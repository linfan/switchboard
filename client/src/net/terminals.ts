//! Persistent xterm.js terminal registry, kept OUTSIDE React so switching the
//! selected conversation never destroys scrollback. Each task owns one long-lived
//! `Terminal` plus a detached host `<div>`; `TerminalView` merely re-parents that
//! div into the visible panel on mount and removes it on unmount. Output frames
//! are written even while a task is not on screen, so no bytes are lost.

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type { Frame } from "./frame";
import { convKey } from "../store/types";

/** Keystrokes typed into a terminal are sent to the owning service/task. */
export type InputSink = (serviceId: string, taskId: string, bytes: Uint8Array) => void;
/** A terminal geometry change is forwarded so the server PTY matches. */
export type ResizeSink = (
  serviceId: string,
  taskId: string,
  cols: number,
  rows: number,
) => void;

interface Entry {
  term: Terminal;
  fit: FitAddon;
  /** Detached host element; re-parented into the panel by TerminalView. */
  el: HTMLDivElement;
  opened: boolean;
}

const entries = new Map<string, Entry>();
const encoder = new TextEncoder();

let inputSink: InputSink | null = null;
let resizeSink: ResizeSink | null = null;

/** Wire the send callbacks (the pool provides these once, at startup). */
export function setSinks(input: InputSink, resize: ResizeSink): void {
  inputSink = input;
  resizeSink = resize;
}

function ensure(serviceId: string, taskId: string): Entry {
  const key = convKey(serviceId, taskId);
  let e = entries.get(key);
  if (e) return e;

  const term = new Terminal({
    convertEol: false,
    cursorBlink: true,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    scrollback: 10000,
    theme: { background: "#0b0f14" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((s) => inputSink?.(serviceId, taskId, encoder.encode(s)));
  term.onResize(({ cols, rows }) => resizeSink?.(serviceId, taskId, cols, rows));

  const el = document.createElement("div");
  el.className = "term-host";

  e = { term, fit, el, opened: false };
  entries.set(key, e);
  return e;
}

/** Apply an incoming data-plane frame to the task's terminal. */
export function write(serviceId: string, taskId: string, frame: Frame): void {
  const e = ensure(serviceId, taskId);
  if (frame.kind === "snapshot") {
    // A snapshot is an authoritative full-screen redraw: clear, then paint.
    e.term.reset();
    e.term.write(frame.data);
  } else if (frame.kind === "output") {
    e.term.write(frame.data);
  }
}

/** Mount a task's terminal into `host` (idempotent across task switches). */
export function attach(
  serviceId: string,
  taskId: string,
  host: HTMLElement,
): void {
  const e = ensure(serviceId, taskId);
  host.appendChild(e.el);
  if (!e.opened) {
    e.term.open(e.el);
    e.opened = true;
  }
  // Defer the fit until the host has a measured size.
  requestAnimationFrame(() => {
    try {
      e.fit.fit();
    } catch {
      // ignore transient zero-size measurements
    }
    e.term.focus();
  });
}

/** Detach the terminal's element without destroying it (scrollback survives). */
export function detach(serviceId: string, taskId: string): void {
  const e = entries.get(convKey(serviceId, taskId));
  if (e?.el.parentElement) e.el.parentElement.removeChild(e.el);
}

/** Refit the currently mounted terminal (call on container resize). */
export function refit(serviceId: string, taskId: string): void {
  const e = entries.get(convKey(serviceId, taskId));
  if (!e?.opened) return;
  try {
    e.fit.fit();
  } catch {
    // ignore
  }
}

/** Permanently drop a task's terminal (on task removal). */
export function dispose(serviceId: string, taskId: string): void {
  const key = convKey(serviceId, taskId);
  const e = entries.get(key);
  if (!e) return;
  detach(serviceId, taskId);
  e.term.dispose();
  entries.delete(key);
}
