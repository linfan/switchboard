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
export type InputSink = (
  serviceId: string,
  taskId: string,
  bytes: Uint8Array,
) => void;
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
  /**
   * Last known `.xterm-viewport` scrollTop, recorded on every scroll event so
   * it survives re-parenting. See `restoreScrollTop`.
   */
  scrollTop: number;
  opened: boolean;
  /**
   * Viewport is pinned to the last line, so new output keeps auto-scrolling.
   * Flipping to false means the user scrolled away to read history, which is
   * when the jump-to-bottom affordance appears.
   */
  follow: boolean;
  /** Notified on every `follow` flip; see onFollow. */
  followListeners: Set<(following: boolean) => void>;
  serviceId: string;
  taskId: string;
}

const entries = new Map<string, Entry>();
const encoder = new TextEncoder();

/** Flip `follow` and tell subscribers, skipping no-op transitions so a smooth
 *  wheel gesture doesn't re-render React on every scrolled row. */
function setFollow(e: Entry, follow: boolean): void {
  if (e.follow === follow) return;
  e.follow = follow;
  for (const l of e.followListeners) l(follow);
}

/** Re-derive `follow` from where the viewport sits in the buffer. */
function syncFollow(e: Entry): void {
  const b = e.term.buffer.active;
  setFollow(e, b.viewportY >= b.baseY);
}

/** The element xterm scrolls; absent until `Terminal.open` has run. */
function viewportEl(e: Entry): HTMLElement | null {
  return e.el.querySelector<HTMLElement>(".xterm-viewport");
}

/**
 * Put the DOM scroller back where xterm believes it is, after re-parenting.
 *
 * Inserting an element resets its scrollTop to 0 and xterm never notices: it
 * caches the previous offset, so `syncScrollArea()`'s fast path compares that
 * cache against `ydisp`, sees no change, and skips the rewrite. `ydisp` then
 * says "last line" while the DOM says "first line", and the next scroll event
 * makes xterm scroll by `round(0 / rowHeight) - ydisp` — hurling the viewport
 * to the top of the scrollback. That lands as a DOM scroll event, so the follow
 * listener reads it as the user scrolling away and auto-follow silently ends.
 *
 * A following terminal wants a maxed-out scroller, which is exact and needs no
 * memory; otherwise fall back to the offset the last scroll event recorded.
 */
function restoreScrollTop(e: Entry): void {
  const vp = viewportEl(e);
  if (vp) vp.scrollTop = e.follow ? vp.scrollHeight : e.scrollTop;
}

/**
 * Font size (px) applied to every terminal, adjustable via the zoom shortcuts.
 * Held here (not per-Entry) so new terminals inherit the current size and a
 * change fans out to all live ones. Mirrors the persisted `terminalFontSize`.
 */
let fontSize = 13;

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
    fontSize,
    scrollback: 10000,
    theme: { background: "#0b0f14" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((s) => inputSink?.(serviceId, taskId, encoder.encode(s)));
  term.onResize(({ cols, rows }) =>
    resizeSink?.(serviceId, taskId, cols, rows),
  );

  const el = document.createElement("div");
  el.className = "term-host";

  e = {
    term,
    fit,
    el,
    scrollTop: 0,
    opened: false,
    follow: true,
    followListeners: new Set(),
    serviceId,
    taskId,
  };
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
      setFollow(e, true);
      e.term.scrollToBottom();
    });
  } else if (frame.kind === "output") {
    e.term.write(frame.data, () => {
      if (e.follow) e.term.scrollToBottom();
    });
  }
}

/**
 * Whether a task's viewport is riding the last line. Safe to call during render:
 * a terminal that doesn't exist yet has nothing scrolled away from, so it reads
 * as following rather than being constructed on the spot.
 */
export function isFollowing(serviceId: string, taskId: string): boolean {
  return entries.get(convKey(serviceId, taskId))?.follow ?? true;
}

/**
 * Subscribe to a task's follow-state flips, so the panel can show a
 * jump-to-bottom affordance while the user reads history and hide it again once
 * they return to the latest output. Resolves to an unsubscribe function.
 */
export function onFollow(
  serviceId: string,
  taskId: string,
  cb: (following: boolean) => void,
): () => void {
  const e = ensure(serviceId, taskId);
  e.followListeners.add(cb);
  return () => {
    e.followListeners.delete(cb);
  };
}

/** Jump to the latest output and resume auto-following it. */
export function scrollToBottom(serviceId: string, taskId: string): void {
  const e = entries.get(convKey(serviceId, taskId));
  if (!e) return;
  setFollow(e, true);
  e.term.scrollToBottom();
  e.term.focus();
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
    // xterm funnels user scrolling through scrollLines(..., suppressScrollEvent),
    // so its public onScroll stays silent for wheel/scrollbar interaction. Watch
    // the DOM scroller instead; xterm registers its own handler first, so ydisp
    // is already up to date by the time this runs.
    const vp = viewportEl(e);
    vp?.addEventListener("scroll", () => {
      // React removes our element before TerminalView's cleanup runs, so a
      // scroll event is the only moment the live offset can be noted.
      e.scrollTop = vp.scrollTop;
      syncFollow(e);
    });
  }
  restoreScrollTop(e);
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
 * Set the shared terminal font size (px). Updates every live terminal and
 * refits it so the grid geometry (and the server PTY, via onResize) tracks the
 * new cell size. New terminals created later pick up the stored value.
 */
export function setFontSize(size: number): void {
  fontSize = size;
  for (const e of entries.values()) {
    e.term.options.fontSize = size;
    if (!e.opened) continue;
    try {
      e.fit.fit();
    } catch {
      // ignore transient zero-size measurements
    }
    e.term.refresh(0, e.term.rows - 1);
    if (e.follow) e.term.scrollToBottom();
  }
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
