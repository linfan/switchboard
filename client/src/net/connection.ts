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
import {
  cbFromPin,
  fromHex,
  hex,
  NONCE_LEN,
  randomNonce,
  wsMac,
} from "./swbauth";

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

export interface HandshakeOptions {
  /**
   * How long a socket may stay open-but-unauthenticated before we abandon it
   * and reconnect. Guards against a handshake that stalls (e.g. the server
   * never sends `auth_challenge`, or a socket that died silently after sleep).
   */
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
  /** Shared secret. Never transmitted — used to answer the WS auth challenge. */
  token: string;
  /**
   * Pinned leaf-cert fingerprint (hex) of the server, mixed into the WS auth
   * proof as the channel binding. Absent for plain-HTTP services.
   */
  certFingerprint?: string;
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
  handshake?: Partial<HandshakeOptions>;
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
const DEFAULT_HANDSHAKE: HandshakeOptions = { timeoutMs: 10000 };
const DEFAULT_WAKE: WakeOptions = { checkMs: 2000, driftMs: 5000 };

const WS_OPEN = 1;

/**
 * Convert an http(s) base URL into the service's ws(s) endpoint. No credential
 * is carried in the URL — the token is proven via the SWB-WS-v1 handshake.
 */
export function toWsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  const scheme = /^https/i.test(trimmed) ? "wss" : "ws";
  const rest = trimmed.replace(/^https?/i, "");
  return `${scheme}${rest}/ws`;
}

export class ConnectionManager {
  private readonly d: ConnectionDeps;
  private readonly wsFactory: WebSocketFactory;
  private readonly now: () => number;
  private readonly reconnectOpts: ReconnectOptions;
  private readonly heartbeatOpts: HeartbeatOptions;
  private readonly handshakeOpts: HandshakeOptions;
  private readonly wakeOpts: WakeOptions;

  private ws: WebSocketLike | null = null;
  private status: ConnStatus = "offline";
  private attempt = 0;
  private stopped = true;
  /** True once the SWB-WS-v1 handshake has succeeded on the current socket. */
  private authed = false;
  /** True while the browser reports the network as down. */
  private networkDown = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.handshakeOpts = { ...DEFAULT_HANDSHAKE, ...deps.handshake };
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

    const url = toWsUrl(this.d.url);
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
    // Guard the connect+handshake window: if we're not authenticated by the
    // deadline, abandon this socket and reconnect. Owns recovery of a stuck
    // handshake so the wake watchdog never has to tear an in-flight one down.
    this.armHandshakeWatchdog();
  }

  private onOpen(): void {
    // The socket is open but not yet trusted: the server sends an AuthChallenge
    // as its first frame, and no app traffic (Hello, heartbeat) may flow until
    // we answer it and receive AuthOk. See `handleAuth`.
    this.authed = false;
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
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    // Until authenticated, the only frames the server sends are handshake ones.
    if (!this.authed) {
      void this.handleAuth(msg);
      return;
    }
    if (msg.type === "pong") {
      this.onPong(msg.ts as number);
      return;
    }
    this.d.onMessage(msg as unknown as ServerMsg);
  }

  /**
   * Drive the SWB-WS-v1 channel-bound handshake. The server opens with
   * `auth_challenge`; we reply with a client nonce and an HMAC over both nonces
   * and the channel binding (cert fingerprint) — the token is never sent. On
   * `auth_ok` the connection becomes live; `auth_error` triggers a reconnect.
   */
  private async handleAuth(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === "auth_challenge" && typeof msg.server_nonce === "string") {
      const clientNonce = randomNonce(NONCE_LEN);
      const mac = await wsMac(
        this.d.token,
        fromHex(msg.server_nonce),
        clientNonce,
        cbFromPin(this.d.certFingerprint),
      );
      // Hashing is async; the socket may have dropped meanwhile.
      if (!this.ws || this.ws.readyState !== WS_OPEN) return;
      this.ws.send(
        JSON.stringify({
          type: "auth_response",
          client_nonce: hex(clientNonce),
          mac: hex(mac),
        }),
      );
      return;
    }
    if (msg.type === "auth_ok") {
      this.onAuthed();
      return;
    }
    if (msg.type === "auth_error") {
      const message =
        typeof msg.message === "string" ? msg.message : "rejected";
      this.closeSocket();
      if (!this.stopped && !this.networkDown) {
        this.scheduleReconnect(`authentication failed: ${message}`);
      }
    }
  }

  /** Handshake accepted: go live — reset backoff, send Hello, start heartbeat. */
  private onAuthed(): void {
    this.clearHandshakeWatchdog();
    this.authed = true;
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

  private onClose(reason: string): void {
    this.stopHeartbeat();
    // Fully tear the socket down (detach handlers + close) rather than just
    // dropping the reference. A live-but-orphaned socket keeps its onmessage
    // bound to this manager, so after we reconnect it would deliver a second
    // copy of every server frame into the same xterm — doubled output, keystroke
    // echo included. closeSocket also clears the handshake watchdog, and is
    // idempotent, so running it on an already-closed socket is harmless.
    this.closeSocket();
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
    // Arm the pong deadline; if it fires, the link is (probably) dead.
    if (this.pongTimer !== null) clearTimeout(this.pongTimer);
    const deadline = this.now() + this.heartbeatOpts.timeoutMs;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // If the timer itself fired well past its deadline, the main thread was
      // blocked (e.g. applying a large replay burst), not the link — a pong
      // could not have been processed in time regardless of link health. Treat
      // that as inconclusive and re-probe rather than tearing down a socket that
      // may be perfectly alive (which would reconnect and re-replay, blocking
      // the thread again — a feedback loop).
      if (this.now() - deadline > this.wakeOpts.driftMs) {
        this.sendPing();
        return;
      }
      this.onClose("heartbeat timeout");
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

  // --- handshake watchdog -------------------------------------------------

  private armHandshakeWatchdog(): void {
    this.clearHandshakeWatchdog();
    const deadline = this.now() + this.handshakeOpts.timeoutMs;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.authed) return;
      // A timer that fired far past its deadline means the main thread was
      // blocked (e.g. a large replay burst on another service starved this
      // handshake) — not that the socket is dead. Re-arm rather than tearing
      // down an in-flight handshake: reconnecting would re-drive Welcome +
      // replay and re-saturate the thread, the very feedback loop we avoid on
      // the heartbeat and wake paths.
      if (this.now() - deadline > this.wakeOpts.driftMs) {
        this.armHandshakeWatchdog();
        return;
      }
      // Genuinely stuck (or a socket that died silently after sleep before it
      // authed): drop it and back off, mirroring the auth_error path.
      this.closeSocket();
      if (!this.stopped && !this.networkDown) {
        this.scheduleReconnect("handshake timeout");
      }
    }, this.handshakeOpts.timeoutMs);
  }

  private clearHandshakeWatchdog(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
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
    // A gap far larger than the tick means either the process was suspended
    // (real sleep — the socket is now stale) or the main thread was blocked for
    // a long stretch (e.g. applying a large replay burst — the socket is fine).
    // The clock alone can't tell them apart, so never tear down here: probe a
    // live socket with a ping and let the pong deadline decide. A dead link
    // fails the probe and reconnects; a healthy one is left untouched, so a busy
    // thread can't trigger a needless reconnect (and the re-replay it would
    // cause, which re-saturates the thread — a feedback loop).
    if (elapsed <= this.wakeOpts.checkMs + this.wakeOpts.driftMs) return;
    if (this.stopped || this.networkDown) return;
    if (this.authed) {
      // A live authed socket: probe rather than tear down (a healthy link is
      // left untouched, a dead one fails the pong and reconnects). If it died
      // silently (closed without an onclose), recover it.
      if (this.ws && this.ws.readyState === WS_OPEN) this.sendPing();
      else this.reconnectNow();
      return;
    }
    // Not yet authenticated: a connect or handshake is in flight. The gap is
    // ambiguous — a real sleep leaves a dead socket, but a busy main thread
    // (another service's replay burst) leaves a perfectly good one still
    // waiting on the thread. While the socket object exists, the drift-aware
    // handshake watchdog owns recovery (it reconnects only if it stays stuck
    // once the thread frees). Only nudge a reconnect when there's no socket.
    if (!this.ws) this.reconnectNow();
  }

  private stopWakeWatchdog(): void {
    if (this.wakeTimer !== null) {
      clearInterval(this.wakeTimer);
      this.wakeTimer = null;
    }
  }

  // --- helpers ------------------------------------------------------------

  private closeSocket(): void {
    this.authed = false;
    this.clearHandshakeWatchdog();
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
