//! A {@link WebSocketLike} backed by the native Rust bridge (`net.rs`).
//!
//! Behaves like a browser `WebSocket` from `ConnectionManager`'s point of view,
//! but the actual socket lives in Rust, which accepts self-signed TLS certs the
//! webview would reject. Injected via `wsFactory` when running under Tauri.

import { base64ToArrayBuffer, bytesToBase64 } from "./b64";
import type { WebSocketFactory, WebSocketLike } from "./connection";
import { invoke, listen, type UnlistenFn } from "./tauri";

type WsEvt =
  | { kind: "text"; data: string }
  | { kind: "binary"; data: string }
  | { kind: "close" };

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** Monotonic suffix so each socket gets its own event channel within this app. */
let chanSeq = 0;

class TauriWebSocket implements WebSocketLike {
  readyState = CONNECTING;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  private id: number | null = null;
  private unlisten: UnlistenFn | null = null;
  private closed = false;
  private opened = false;
  /**
   * Frames delivered before the socket is reported open. The server sends its
   * `auth_challenge` the instant the WS upgrades — which can reach us before the
   * `ws_connect` invoke resolves — so we queue anything early and flush it on
   * open, in order, rather than dropping it (which would hang the handshake).
   */
  private pending: WsEvt[] = [];

  constructor(url: string, pin?: string) {
    const chan = `ws:${chanSeq++}:${
      globalThis.crypto?.randomUUID?.() ?? Date.now()
    }`;
    // Subscribe BEFORE connecting: the listener must exist before Rust can emit
    // the server's first frame, or Tauri's fire-and-forget event bus drops it.
    listen<WsEvt>(chan, (p) => this.onEvt(p))
      .then((unlisten) => {
        // A close() that raced the subscribe: undo it and never connect.
        if (this.closed) {
          unlisten();
          return undefined;
        }
        this.unlisten = unlisten;
        return invoke<number>("ws_connect", { url, pin: pin ?? null, chan });
      })
      .then((id) => {
        if (id === undefined) return; // closed before we connected
        // A close() that raced the connect: tear the fresh socket right down.
        if (this.closed) {
          void invoke("ws_close", { id });
          return;
        }
        this.id = id;
        this.readyState = OPEN;
        this.opened = true;
        this.onopen?.();
        // Flush frames that arrived ahead of this open notification.
        const queued = this.pending;
        this.pending = [];
        for (const p of queued) this.deliver(p);
      })
      .catch(() => {
        this.readyState = CLOSED;
        this.clearListener();
        this.onerror?.();
        this.onclose?.();
      });
  }

  private onEvt(p: WsEvt): void {
    // Hold frames until the socket is reported open (and its id is known, so a
    // reply can be sent); deliver in arrival order once open.
    if (!this.opened) {
      this.pending.push(p);
      return;
    }
    this.deliver(p);
  }

  private deliver(p: WsEvt): void {
    if (p.kind === "text") {
      this.onmessage?.({ data: p.data });
    } else if (p.kind === "binary") {
      this.onmessage?.({ data: base64ToArrayBuffer(p.data) });
    } else {
      this.readyState = CLOSED;
      this.clearListener();
      this.onclose?.();
    }
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.id === null) return;
    if (typeof data === "string") {
      void invoke("ws_send", { id: this.id, text: data, binaryB64: null });
    } else {
      void invoke("ws_send", {
        id: this.id,
        text: null,
        binaryB64: bytesToBase64(data),
      });
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
    this.clearListener();
    if (this.id !== null) void invoke("ws_close", { id: this.id });
  }

  private clearListener(): void {
    this.unlisten?.();
    this.unlisten = null;
  }
}

/**
 * Build a factory bound to a service's pinned cert fingerprint, so every socket
 * the pool opens for that service enforces the same leaf-cert pin in Rust.
 */
export const makeTauriWsFactory =
  (pin?: string): WebSocketFactory =>
  (url) =>
    new TauriWebSocket(url, pin);
