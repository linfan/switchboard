//! A {@link WebSocketLike} backed by the native Rust bridge (`net.rs`).
//!
//! Behaves like a browser `WebSocket` from `ConnectionManager`'s point of view,
//! but the actual socket lives in Rust, which accepts self-signed TLS certs the
//! webview would reject. Injected via `wsFactory` when running under Tauri.

import { base64ToArrayBuffer, bytesToBase64 } from "./b64";
import type { WebSocketLike } from "./connection";
import { invoke, listen, type UnlistenFn } from "./tauri";

type WsEvt =
  | { kind: "text"; data: string }
  | { kind: "binary"; data: string }
  | { kind: "close" };

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

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

  constructor(url: string) {
    invoke<number>("ws_connect", { url })
      .then(async (id) => {
        // A close() that raced the connect: tear the fresh socket right down.
        if (this.closed) {
          void invoke("ws_close", { id });
          return;
        }
        this.id = id;
        this.unlisten = await listen<WsEvt>(`ws:${id}`, (p) => this.onEvt(p));
        this.readyState = OPEN;
        this.onopen?.();
      })
      .catch(() => {
        this.readyState = CLOSED;
        this.onerror?.();
        this.onclose?.();
      });
  }

  private onEvt(p: WsEvt): void {
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

export const tauriWsFactory = (url: string): WebSocketLike =>
  new TauriWebSocket(url);
