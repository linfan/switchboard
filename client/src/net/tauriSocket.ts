//! A {@link WebSocketLike} backed by the native Rust bridge (`net.rs`).
//!
//! Behaves like a browser `WebSocket` from `ConnectionManager`'s point of view,
//! but the actual socket lives in Rust, which accepts self-signed TLS certs the
//! webview would reject. Injected via `wsFactory` when running under Tauri.
//!
//! Frames arrive from Rust over a Tauri `Channel` as raw bytes (no base64/JSON
//! tax): each message is `[tag][payload]`, where `tag` selects text, binary, or
//! close. The Channel preserves ordering, so interleaved control (text) and
//! data-plane (binary) frames are delivered in the exact order the server sent
//! them.

import { bytesToBase64 } from "./b64";
import type { WebSocketFactory, WebSocketLike } from "./connection";
import { invoke } from "./tauri";

/** Outer framing tags on the raw Channel bytes (mirror `net.rs`). */
const TAG_TEXT = 0;
const TAG_BINARY = 1;

type WsEvt =
  | { kind: "text"; data: string }
  | { kind: "binary"; data: ArrayBuffer }
  | { kind: "close" };

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

const textDecoder = new TextDecoder();

class TauriWebSocket implements WebSocketLike {
  readyState = CONNECTING;
  binaryType = "arraybuffer";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  private id: number | null = null;
  private closed = false;
  private opened = false;
  /**
   * Frames delivered before the socket is reported open. The server sends its
   * `auth_challenge` the instant the WS upgrades — which can reach us before the
   * `ws_connect` invoke resolves — so we queue anything early and flush it on
   * open, in order, rather than delivering it ahead of `onopen`.
   */
  private pending: WsEvt[] = [];

  constructor(url: string, pin?: string) {
    void this.connect(url, pin);
  }

  private async connect(url: string, pin?: string): Promise<void> {
    try {
      // Import lazily so the browser build never loads Tauri modules.
      const { Channel } = await import("@tauri-apps/api/core");
      // A close() that raced the import: never connect.
      if (this.closed) return;
      // Register the callback before invoking, so no frame can be missed.
      const channel = new Channel<ArrayBuffer>();
      channel.onmessage = (buf) => this.onFrame(buf);
      const id = await invoke<number>("ws_connect", {
        url,
        pin: pin ?? null,
        onFrame: channel,
      });
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
    } catch {
      this.readyState = CLOSED;
      this.onerror?.();
      this.onclose?.();
    }
  }

  /** Decode one `[tag][payload]` Channel message into a {@link WsEvt}. */
  private onFrame(buf: ArrayBuffer): void {
    const view = new Uint8Array(buf);
    if (view.length < 1) return;
    const tag = view[0];
    let evt: WsEvt;
    if (tag === TAG_TEXT) {
      evt = { kind: "text", data: textDecoder.decode(view.subarray(1)) };
    } else if (tag === TAG_BINARY) {
      evt = { kind: "binary", data: buf.slice(1) };
    } else {
      evt = { kind: "close" };
    }
    // Hold frames until the socket is reported open (and its id is known, so a
    // reply can be sent); deliver in arrival order once open.
    if (!this.opened) {
      this.pending.push(evt);
      return;
    }
    this.deliver(evt);
  }

  private deliver(p: WsEvt): void {
    if (p.kind === "text") {
      this.onmessage?.({ data: p.data });
    } else if (p.kind === "binary") {
      this.onmessage?.({ data: p.data });
    } else {
      this.readyState = CLOSED;
      this.onclose?.();
    }
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.id === null) return;
    if (typeof data === "string") {
      void invoke("ws_send", { id: this.id, text: data, binaryB64: null });
    } else {
      // Client->server frames are tiny keystrokes/resizes, so base64 here is
      // negligible; the volume (and the perf win of raw bytes) is all inbound.
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
    if (this.id !== null) void invoke("ws_close", { id: this.id });
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
