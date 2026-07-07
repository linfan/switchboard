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
  /** Viewport is pinned to the last line, so new output keeps auto-scrolling. */
  follow: boolean;
  serviceId: string;
  taskId: string;
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

  e = { term, fit, el, opened: false, follow: true, serviceId, taskId };
  const entry = e;
  // Track whether the viewport is riding the bottom. xterm only auto-scrolls on
  // write while the user is already at the bottom, so we mirror that state here
  // and re-assert it after writes/refits (a reflow can nudge ydisp off ybase).
  term.onScroll(() => {
    const b = term.buffer.active;
    entry.follow = b.viewportY >= b.baseY;
  });
  entries.set(key, e);
  return e;
}

/** Apply an incoming data-plane frame to the task's terminal. */
export function write(serviceId: string, taskId: string, frame: Frame): void {
  const e = ensure(serviceId, taskId);
  if (frame.kind === "snapshot") {
    // A snapshot is an authoritative full-screen redraw: clear, then paint. It
    // reconstructs the *current* screen, so always land the viewport on it.
    e.term.reset();
    e.term.write(frame.data, () => {
      e.follow = true;
      e.term.scrollToBottom();
    });
  } else if (frame.kind === "output") {
    // Pin to the bottom after the chunk is parsed if we were following it. This
    // keeps streaming output (Qoder-style downward growth) glued to the latest
    // line instead of drifting up when a write races with a reflow.
    const follow = e.follow;
    e.term.write(frame.data, () => {
      if (follow) e.term.scrollToBottom();
    });
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
  const settle = () => {
    try {
      e.fit.fit();
    } catch {
      // ignore transient zero-size measurements
    }
    // Repaint every row: output written while this terminal was detached (a
    // background task) can leave the renderer's grid stale, drawing new content
    // over old on re-attach. A full refresh clears that; a plain fit does not
    // when the geometry is unchanged.
    e.term.refresh(0, e.term.rows - 1);
    if (e.follow) e.term.scrollToBottom();
  };
  // Defer the first fit until the host has a measured size.
  requestAnimationFrame(() => {
    settle();
    e.term.focus();
  });
  // Re-fit once webfonts finish loading. The first fit can measure the fallback
  // font's cell size and mis-compute rows, clipping or overlapping the last
  // line until something forces a resize.
  document.fonts?.ready?.then(settle).catch(() => {});
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
  // fit() reflows the buffer, which can leave the viewport above the last line;
  // re-pin so a resize never scrolls live output out of view.
  if (e.follow) e.term.scrollToBottom();
}

/**
 * Re-send the live geometry of every on-screen terminal of a service. Call this
 * right after a (re)connect: a window resize that happened while the socket was
 * down updated the local xterm but never reached the server, so its PTY and the
 * snapshot it renders are stale. Replaying the current size makes the server
 * SIGWINCH and redraw at the client's real dimensions. Only mounted+fitted
 * terminals are reported — a detached entry may still hold the 80×24 default and
 * would otherwise shrink the server's PTY.
 */
export function resync(serviceId: string): void {
  for (const e of entries.values()) {
    if (e.serviceId !== serviceId || !e.opened || !e.el.isConnected) continue;
    resizeSink?.(e.serviceId, e.taskId, e.term.cols, e.term.rows);
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
