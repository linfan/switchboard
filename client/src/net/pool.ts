//! Connection pool: one `ConnectionManager` per registered service, wired to the
//! Zustand store and to browser network/wake signals. This is the glue the UI
//! talks to — it never touches sockets directly.

import type { ClientMsg } from "../protocol";
import { useStore } from "../store/store";
import { ConnectionManager } from "./connection";
import { decode, encodeInput } from "./frame";
import * as terminals from "./terminals";

let clientId = "";

/** Stable per-install client id (persisted). Used in every Hello. */
function ensureClientId(): string {
  if (clientId) return clientId;
  const KEY = "agent-manage-client-id";
  const existing = globalThis.localStorage?.getItem(KEY);
  if (existing) {
    clientId = existing;
    return clientId;
  }
  clientId =
    globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}`;
  globalThis.localStorage?.setItem(KEY, clientId);
  return clientId;
}

export class ConnectionPool {
  private managers = new Map<string, ConnectionManager>();
  private unsub: (() => void) | null = null;

  /** Start managing all current services and follow future add/remove. */
  start(): void {
    const id = ensureClientId();
    // Route keystrokes/resizes from any terminal back to its owning service.
    terminals.setSinks(
      (sid, tid, bytes) => this.sendInput(sid, tid, bytes),
      (sid, tid, cols, rows) => this.sendResize(sid, tid, cols, rows),
    );
    const sync = (services: { id: string; url: string; token: string }[]) => {
      const live = new Set(services.map((s) => s.id));
      // Drop managers for removed services.
      for (const [sid, mgr] of this.managers) {
        if (!live.has(sid)) {
          mgr.stop();
          this.managers.delete(sid);
        }
      }
      // Spin up managers for new services.
      for (const svc of services) {
        if (this.managers.has(svc.id)) continue;
        const mgr = new ConnectionManager({
          clientId: id,
          url: svc.url,
          token: svc.token,
          getCursors: () => useStore.getState().cursorsFor(svc.id),
          onMessage: (msg) => useStore.getState().applyServerMsg(svc.id, msg),
          onBinary: (bytes) => this.onBinary(svc.id, bytes),
          onStatus: (status, meta) =>
            useStore.getState().setRuntime(svc.id, {
              status,
              lastError: meta?.error,
              nextRetryAt: meta?.nextRetryAt,
              attempt: meta?.attempt ?? useStore.getState().runtime[svc.id]?.attempt ?? 0,
            }),
        });
        this.managers.set(svc.id, mgr);
        mgr.start();
      }
    };

    sync(useStore.getState().services);
    this.unsub = useStore.subscribe((s) => sync(s.services));

    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
    }
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    for (const mgr of this.managers.values()) mgr.stop();
    this.managers.clear();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
      window.removeEventListener("offline", this.onOffline);
    }
  }

  reconnect(serviceId: string): void {
    this.managers.get(serviceId)?.reconnectNow();
  }

  private send(serviceId: string, msg: ClientMsg): boolean {
    return this.managers.get(serviceId)?.send(msg) ?? false;
  }

  /** Decode a data-plane frame, paint its terminal, and advance the cursor. */
  private onBinary(serviceId: string, bytes: Uint8Array): void {
    let frame;
    try {
      frame = decode(bytes);
    } catch {
      return;
    }
    terminals.write(serviceId, frame.taskId, frame);
    if (frame.kind === "output" || frame.kind === "snapshot") {
      useStore.getState().setCursor(serviceId, frame.taskId, frame.seq);
    }
  }

  createTask(
    serviceId: string,
    tool: string,
    title: string | null,
    cwd: string | null,
    cols = 80,
    rows = 24,
  ): boolean {
    return this.send(serviceId, {
      type: "create_task",
      tool,
      title,
      cwd,
      cols,
      rows,
    });
  }

  /** Send raw keystrokes as an INPUT data-plane frame. */
  sendInput(serviceId: string, taskId: string, bytes: Uint8Array): boolean {
    return this.managers.get(serviceId)?.sendBytes(encodeInput(taskId, bytes)) ?? false;
  }

  /** Report a terminal geometry change so the server PTY resizes. */
  sendResize(serviceId: string, taskId: string, cols: number, rows: number): boolean {
    return this.send(serviceId, { type: "resize", task_id: taskId, cols, rows });
  }

  terminateTask(serviceId: string, taskId: string): boolean {
    return this.send(serviceId, { type: "terminate_task", task_id: taskId });
  }

  private onOnline = () => {
    for (const mgr of this.managers.values()) mgr.notifyOnline();
  };
  private onOffline = () => {
    for (const mgr of this.managers.values()) mgr.notifyOffline();
  };
}

/** Singleton pool shared by the UI. */
export const pool = new ConnectionPool();
