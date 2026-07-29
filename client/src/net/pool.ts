//! Connection pool: one `ConnectionManager` per registered service, wired to the
//! Zustand store and to browser network/wake signals. This is the glue the UI
//! talks to — it never touches sockets directly.

import type { ClientMsg, ServerMsg } from "../protocol";
import { useStore } from "../store/store";
import { ConnectionManager } from "./connection";
import { decode, encodeInput } from "./frame";
import { isTauri } from "./tauri";
import { makeTauriWsFactory } from "./tauriSocket";
import * as terminals from "./terminals";

let clientId = "";

/** Identity of a service's connection config — changes when url/token is edited. */
interface ServiceConfig {
  id: string;
  url: string;
  token: string;
  certFingerprint?: string;
}

function configKey(svc: ServiceConfig): string {
  return `${svc.url} ${svc.token} ${svc.certFingerprint ?? ""}`;
}

/** Stable per-install client id (persisted). Used in every Hello. */
function ensureClientId(): string {
  if (clientId) return clientId;
  const KEY = "switchboard-client-id";
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
  /** Last-synced connection config per service, to detect edits (url/token). */
  private configs = new Map<string, string>();
  private unsub: (() => void) | null = null;
  /**
   * Highest seq seen per `serviceId::taskId` since the last flush, buffered so
   * the initial replay burst (thousands of data-plane frames back-to-back)
   * collapses into one store write per task per tick instead of one per frame —
   * each store write notifies every subscriber, so per-frame writes would pin
   * the main thread under re-renders and re-sync passes. Flushed on a timer and,
   * for correctness, synchronously whenever cursors are read for a Hello.
   */
  private pendingCursors = new Map<
    string,
    { serviceId: string; taskId: string; seq: number }
  >();
  private cursorFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Start managing all current services and follow future add/remove. */
  start(): void {
    const id = ensureClientId();
    // Route keystrokes/resizes from any terminal back to its owning service.
    terminals.setSinks(
      (sid, tid, bytes) => this.sendInput(sid, tid, bytes),
      (sid, tid, cols, rows) => this.sendResize(sid, tid, cols, rows),
    );
    const sync = (services: ServiceConfig[]) => {
      const live = new Set(services.map((s) => s.id));
      // Drop managers for removed services. Delete from the map *before*
      // stopping: `mgr.stop()` fires an `onStatus("offline")` that writes to the
      // store, which re-enters this subscriber synchronously. If the manager
      // were still mapped at that point the re-entrant pass would stop it again,
      // recursing until the stack overflows — which aborts the `removeService`
      // reducer before persistence runs, resurrecting the service on reload.
      for (const [sid, mgr] of this.managers) {
        if (!live.has(sid)) {
          this.managers.delete(sid);
          this.configs.delete(sid);
          mgr.stop();
        }
      }
      // Tear down managers whose service was edited (url/token changed) so the
      // block below rebuilds them with the new config — a live ConnectionManager
      // captures url/token at construction and never re-reads them.
      for (const svc of services) {
        const mgr = this.managers.get(svc.id);
        if (mgr && this.configs.get(svc.id) !== configKey(svc)) {
          this.managers.delete(svc.id);
          this.configs.delete(svc.id);
          mgr.stop();
        }
      }
      // Spin up managers for new (or just-edited) services.
      for (const svc of services) {
        if (this.managers.has(svc.id)) continue;
        this.configs.set(svc.id, configKey(svc));
        const mgr = new ConnectionManager({
          clientId: id,
          url: svc.url,
          token: svc.token,
          certFingerprint: svc.certFingerprint,
          // In the desktop app, route the socket through Rust so it can pin the
          // server's leaf cert (which the webview would reject if self-signed).
          wsFactory: isTauri ? makeTauriWsFactory(svc.certFingerprint) : undefined,
          getCursors: () => {
            // Land any buffered advances before the Hello reads cursors, so a
            // reconnect never asks the server to replay chunks we already have.
            this.flushCursors();
            return useStore.getState().cursorsFor(svc.id);
          },
          onMessage: (msg) => this.onControl(svc.id, msg),
          onBinary: (bytes) => this.onBinary(svc.id, bytes),
          // On every (re)connect, replay the live terminal geometry so a resize
          // that happened while offline reaches the server and its snapshots
          // match the client's viewport.
          onReady: () => terminals.resync(svc.id),
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
    // Zustand fires this on *every* store mutation. Re-syncing managers only
    // matters when the service list itself changes, so gate on its identity —
    // otherwise the replay burst's thousands of cursor writes would each re-run
    // the full sync (Set allocation + manager/service scan) for nothing.
    this.unsub = useStore.subscribe((s, prev) => {
      if (s.services !== prev.services) sync(s.services);
    });

    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
    }
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    this.flushCursors();
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

  /** Apply a control message, disposing a deleted task's terminal first. */
  private onControl(serviceId: string, msg: ServerMsg): void {
    if (msg.type === "task_deleted") {
      terminals.dispose(serviceId, msg.task_id);
    }
    useStore.getState().applyServerMsg(serviceId, msg);
  }

  /** Decode a data-plane frame, paint its terminal, and advance the cursor. */
  private onBinary(serviceId: string, bytes: Uint8Array): void {
    let frame;
    try {
      frame = decode(bytes);
    } catch {
      return;
    }
    // The terminal write is applied immediately (xterm queues its own parse);
    // the cursor advance is buffered and coalesced — see `pendingCursors`.
    terminals.write(serviceId, frame.taskId, frame);
    if (frame.kind === "output" || frame.kind === "snapshot") {
      this.queueCursor(serviceId, frame.taskId, frame.seq);
    }
  }

  /** Buffer a cursor advance, coalescing to the highest seq per task. */
  private queueCursor(serviceId: string, taskId: string, seq: number): void {
    const key = `${serviceId}::${taskId}`;
    const cur = this.pendingCursors.get(key);
    if (!cur || seq > cur.seq) {
      this.pendingCursors.set(key, { serviceId, taskId, seq });
    }
    if (this.cursorFlushTimer === null) {
      this.cursorFlushTimer = setTimeout(() => this.flushCursors(), 32);
    }
  }

  /** Write every buffered cursor advance to the store in one pass. */
  private flushCursors(): void {
    if (this.cursorFlushTimer !== null) {
      clearTimeout(this.cursorFlushTimer);
      this.cursorFlushTimer = null;
    }
    if (this.pendingCursors.size === 0) return;
    const pending = this.pendingCursors;
    this.pendingCursors = new Map();
    const setCursor = useStore.getState().setCursor;
    for (const { serviceId, taskId, seq } of pending.values()) {
      setCursor(serviceId, taskId, seq);
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

  /** Delete a task: terminate its process and drop all its data on the host. */
  deleteTask(serviceId: string, taskId: string): boolean {
    return this.send(serviceId, { type: "delete_task", task_id: taskId });
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
