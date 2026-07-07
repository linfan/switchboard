//! Per-service WebSocket connection manager.
//!
//! Owns exactly one hosting-service connection and everything that keeps it
//! healthy: the Hello handshake with per-task cursors, a Ping/Pong heartbeat
//! watchdog, exponential-backoff auto-reconnect with a manual override, and
//! detection of both network online/offline transitions and system
//! resume-from-sleep. Message de-duplication lives in the store reducer; this
//! layer guarantees a live, gap-free byte pipe and re-issues Hello (with the
//! latest cursors) on every (re)connect so no message is lost across drops.

import type { ClientMsg, ServerMsg } from "../protocol";
import type { ConnStatus } from "../store/types";

/** Minimal WebSocket surface we depend on (injectable for tests). */
export interface WebSocketLike {
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  readyState: number;
  binaryType?: string;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ReconnectOptions {
  /** Delay before the first retry. */
  baseDelayMs: number;
  /** Upper bound on backoff delay. */
  maxDelayMs: number;
  /** Backoff multiplier per consecutive failure. */
  factor: number;
  /** Random fraction (0..1) added to each delay to avoid thundering herds. */
  jitter: number;
}

export interface HeartbeatOptions {
  /** How often to send a Ping while connected. */
  intervalMs: number;
  /** How long to wait for a Pong before declaring the socket dead. */
  timeoutMs: number;
}

export interface WakeOptions {
  /** Watchdog tick cadence. */
  checkMs: number;
  /** Elapsed beyond `checkMs` that implies the machine slept. */
  driftMs: number;
}

export interface StatusMeta {
  error?: string;
  nextRetryAt?: number;
  attempt?: number;
  /** Last measured round-trip time in ms. */
  rttMs?: number;
}

export interface ConnectionDeps {
  clientId: string;
  /** HTTP base URL, e.g. `http://127.0.0.1:8787`. */
  url: string;
  token: string;
  /** Latest per-task cursors, read fresh on every (re)connect. */
  getCursors: () => Record<string, number>;
  /** Deliver a parsed server message (non-Pong) to the app. */
  onMessage: (msg: ServerMsg) => void;
  /** Deliver a raw binary data-plane frame (terminal output/snapshot). */
  onBinary: (bytes: Uint8Array) => void;
  /** Report a connection status transition. */
  onStatus: (status: ConnStatus, meta?: StatusMeta) => void;
  /** Fired once per successful (re)connect, after Hello is sent. */
  onReady?: () => void;
  wsFactory?: WebSocketFactory;
  now?: () => number;
  reconnect?: Partial<ReconnectOptions>;
  heartbeat?: Partial<HeartbeatOptions>;
  wake?: Partial<WakeOptions>;
}

const DEFAULT_RECONNECT: ReconnectOptions = {
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  factor: 2,
  jitter: 0.2,
};
const DEFAULT_HEARTBEAT: HeartbeatOptions = {
  intervalMs: 15000,
  timeoutMs: 10000,
};
const DEFAULT_WAKE: WakeOptions = { checkMs: 2000, driftMs: 5000 };

const WS_OPEN = 1;

/** Convert an http(s) base URL into the service's ws(s) endpoint with token. */
export function toWsUrl(base: string, token: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const ws = trimmed.replace(/^http/i, (m) =>
    m.toLowerCase() === "http" ? "ws" : m,
  );
  // Handle https -> wss explicitly (the regex above only maps the http prefix).
  const scheme = /^https/i.test(trimmed) ? "wss" : ws.startsWith("wss") ? "wss" : "ws";
  const rest = trimmed.replace(/^https?/i, "");
  return `${scheme}${rest}/ws?token=${encodeURIComponent(token)}`;
}

export class ConnectionManager {
  private readonly d: ConnectionDeps;
  private readonly wsFactory: WebSocketFactory;
  private readonly now: () => number;
  private readonly reconnectOpts: ReconnectOptions;
  private readonly heartbeatOpts: HeartbeatOptions;
  private readonly wakeOpts: WakeOptions;

  private ws: WebSocketLike | null = null;
  private status: ConnStatus = "offline";
  private attempt = 0;
  private stopped = true;
  /** True while the browser reports the network as down. */
  private networkDown = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimer: ReturnType<typeof setInterval> | null = null;
  private lastWakeTick = 0;
  private lastPingTs = 0;

  constructor(deps: ConnectionDeps) {
    this.d = deps;
    this.wsFactory =
      deps.wsFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.now = deps.now ?? (() => Date.now());
    this.reconnectOpts = { ...DEFAULT_RECONNECT, ...deps.reconnect };
    this.heartbeatOpts = { ...DEFAULT_HEARTBEAT, ...deps.heartbeat };
    this.wakeOpts = { ...DEFAULT_WAKE, ...deps.wake };
  }

  /** Begin connecting and keep the connection alive until `stop()`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.startWakeWatchdog();
    this.open();
  }

  /** Tear down permanently; no further reconnects. */
  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.stopWakeWatchdog();
    this.closeSocket();
    this.setStatus("offline");
  }

  /** Force an immediate reconnect (manual "Reconnect now" button). */
  reconnectNow(): void {
    if (this.stopped) return;
    this.clearReconnect();
    this.attempt = 0;
    this.closeSocket();
    this.open();
  }

  /** Send a client message if the socket is open. Returns whether it was sent. */
  send(msg: ClientMsg): boolean {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /** Send a raw binary data-plane frame (e.g. an INPUT keystroke frame). */
  sendBytes(bytes: Uint8Array): boolean {
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.ws.send(bytes);
      return true;
    }
    return false;
  }

  /** Wire this to the browser `online` event. */
  notifyOnline(): void {
    if (this.stopped) return;
    this.networkDown = false;
    this.reconnectNow();
  }

  /** Wire this to the browser `offline` event. */
  notifyOffline(): void {
    if (this.stopped) return;
    this.networkDown = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.closeSocket();
    this.setStatus("offline", { error: "network offline" });
  }

  getStatus(): ConnStatus {
    return this.status;
  }

  // --- internals ----------------------------------------------------------

  private open(): void {
    if (this.networkDown) return;
    this.closeSocket();
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting", {
      attempt: this.attempt,
    });

    const url = toWsUrl(this.d.url, this.d.token);
    let ws: WebSocketLike;
    try {
      ws = this.wsFactory(url);
    } catch (e) {
      this.scheduleReconnect(String(e));
      return;
    }
    this.ws = ws;
    // Data-plane frames arrive as binary; receive them as ArrayBuffer.
    ws.binaryType = "arraybuffer";

    ws.onopen = () => this.onOpen();
    ws.onclose = () => this.onClose("socket closed");
    ws.onerror = () => this.onClose("socket error");
    ws.onmessage = (ev) => this.onData(ev.data);
  }

  private onOpen(): void {
    this.attempt = 0;
    this.setStatus("online");
    // Re-issue Hello with the freshest cursors so the server replays only what
    // we have not durably applied.
    this.send({
      type: "hello",
      client_id: this.d.clientId,
      cursors: this.d.getCursors(),
    });
    this.startHeartbeat();
    // Let the app re-assert per-task state that must survive a drop (e.g. the
    // terminal geometry, in case the window was resized while offline).
    this.d.onReady?.();
  }

  private onData(data: unknown): void {
    // Binary frames are the terminal data plane; hand them off untouched.
    if (data instanceof ArrayBuffer) {
      this.d.onBinary(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const v = data as ArrayBufferView;
      this.d.onBinary(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      return;
    }
    if (typeof data !== "string") return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(data) as ServerMsg;
    } catch {
      return;
    }
    if (msg.type === "pong") {
      this.onPong(msg.ts);
      return;
    }
    this.d.onMessage(msg);
  }

  private onClose(reason: string): void {
    this.stopHeartbeat();
    this.ws = null;
    if (this.stopped || this.networkDown) return;
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(error: string): void {
    this.clearReconnect();
    const { baseDelayMs, maxDelayMs, factor, jitter } = this.reconnectOpts;
    const raw = baseDelayMs * Math.pow(factor, this.attempt);
    const capped = Math.min(raw, maxDelayMs);
    const delay = capped + capped * jitter * Math.random();
    this.attempt += 1;
    const nextRetryAt = this.now() + delay;
    this.setStatus("reconnecting", { error, nextRetryAt, attempt: this.attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // --- heartbeat ----------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendPing(), this.heartbeatOpts.intervalMs);
  }

  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    this.lastPingTs = this.now();
    this.send({ type: "ping", ts: this.lastPingTs });
    // Arm the pong deadline; if it fires, the link is dead.
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.onClose("heartbeat timeout");
      this.closeSocket();
    }, this.heartbeatOpts.timeoutMs);
  }

  private onPong(ts: number): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    const rttMs = this.now() - ts;
    this.setStatus("online", { rttMs });
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  // --- wake / sleep detection --------------------------------------------

  private startWakeWatchdog(): void {
    this.stopWakeWatchdog();
    this.lastWakeTick = this.now();
    this.wakeTimer = setInterval(() => this.wakeTick(), this.wakeOpts.checkMs);
  }

  private wakeTick(): void {
    const nowT = this.now();
    const elapsed = nowT - this.lastWakeTick;
    this.lastWakeTick = nowT;
    // A gap far larger than the tick means the process was suspended (sleep).
    // The socket is almost certainly stale, so force a fresh reconnect.
    if (elapsed > this.wakeOpts.checkMs + this.wakeOpts.driftMs) {
      if (!this.stopped && !this.networkDown) {
        this.reconnectNow();
      }
    }
  }

  private stopWakeWatchdog(): void {
    if (this.wakeTimer !== null) {
      clearInterval(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  // --- helpers ------------------------------------------------------------

  private closeSocket(): void {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private setStatus(status: ConnStatus, meta?: StatusMeta): void {
    this.status = status;
    this.d.onStatus(status, meta);
  }
}
