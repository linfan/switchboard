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
  /**
   * When lock is ON, pressing any key while scrolled away returns to the
   * bottom and resumes following. A toggle button in the terminal UI controls
   * this flag.
   */
  lock: boolean;
  /** Notified on every `lock` flip; see onLock. */
  lockListeners: Set<(locked: boolean) => void>;
  serviceId: string;
  taskId: string;
  /**
   * `performance.now()` of the last user scroll input (wheel, touch, scrollbar
   * drag). xterm emits DOM scroll events of its own while it reflows or syncs
   * the scrollbar, so a scroll event only means "the user moved the viewport"
   * while this is recent.
   */
  userScrollAt: number;
  /** True while the native scrollbar thumb is being dragged. */
  scrollbarDrag: boolean;
  /** Sub-line pixel remainder of pixel-mode wheel deltas. */
  wheelPx: number;
  /**
   * Deadline until which a just-resized terminal keeps re-pinning itself to
   * the last line. xterm's viewport catches up asynchronously after a reflow
   * and can briefly write a stale scrollTop, which otherwise strands the view
   * one line above the bottom.
   */
  repinUntil: number;
  repinRaf: number | null;
}

const entries = new Map<string, Entry>();
const encoder = new TextEncoder();

const now = () => performance.now();

/** Flip `follow` and tell subscribers, skipping no-op transitions so a smooth
 *  wheel gesture doesn't re-render React on every scrolled row. */
function setFollow(e: Entry, follow: boolean): void {
  if (e.follow === follow) return;
  e.follow = follow;
  for (const l of e.followListeners) l(follow);
}

/** Re-derive `follow` from where xterm's viewport sits in the buffer. */
function followFromBuffer(e: Entry): void {
  const b = e.term.buffer.active;
  setFollow(e, b.viewportY >= b.baseY);
}

/** Jump to the latest output. This also clears xterm's own `isUserScrolling`
 *  flag, so subsequent output keeps following. */
function scrollToBottomNow(e: Entry): void {
  e.term.scrollToBottom();
  e.wheelPx = 0;
  setFollow(e, true);
}

/** Mark the current scroll stream as user-initiated and stop any resize pin. */
function markUserScroll(e: Entry): void {
  e.userScrollAt = now();
  e.repinUntil = 0;
  if (e.repinRaf !== null) {
    cancelAnimationFrame(e.repinRaf);
    e.repinRaf = null;
  }
}

/** The element xterm scrolls; absent until `Terminal.open` has run. */
function viewportEl(e: Entry): HTMLElement | null {
  return e.el.querySelector<HTMLElement>(".xterm-viewport");
}

/** Whether the DOM scroller is at (or within a pixel of) its bottom. */
function domAtBottom(vp: HTMLElement): boolean {
  return vp.scrollHeight - vp.clientHeight - vp.scrollTop <= 2;
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
 * Re-pin a following terminal after its grid was resized/reflowed.
 *
 * `fit()` changes rows/columns synchronously, but xterm finishes reflowing the
 * buffer and syncing the scrollbar over the following frames. Its late viewport
 * write can land one row short of `baseY` (and be misread as a user scroll),
 * leaving the view stuck just above the last line. Pinning now and on every
 * frame for a short grace period keeps the viewport on the last line no matter
 * how those async syncs interleave.
 */
function pinAfterResize(e: Entry): void {
  scrollToBottomNow(e);
  e.repinUntil = now() + 500;
  if (e.repinRaf !== null) return;
  const step = () => {
    e.repinRaf = null;
    if (e.repinUntil === 0 || now() >= e.repinUntil) return;
    const b = e.term.buffer.active;
    if (now() - e.userScrollAt > 300 && b.viewportY < b.baseY) {
      e.term.scrollToBottom();
    }
    e.repinRaf = requestAnimationFrame(step);
  };
  e.repinRaf = requestAnimationFrame(step);
}

/**
 * Wheel handling for the normal scrollback buffer, translated to
 * `Terminal.scrollLines` instead of letting xterm nudge `.xterm-viewport`
 * directly.
 *
 * xterm's own wheel path writes `scrollTop` immediately and learns the new
 * position from the resulting DOM scroll event. That event can be coalesced
 * with (or mistaken for) one of xterm's own programmatic scroll writes, which
 * xterm then ignores via `_ignoreNextScrollEvent` — so the wheel gesture is
 * lost, `viewportY` stays on the last line and the next output snaps back to
 * the bottom. Driving the public `scrollLines` API keeps xterm's viewport
 * model and its `isUserScrolling` flag authoritative; the scrollbar is then
 * synced by xterm itself.
 *
 * Alternate-screen apps (no scrollback) and applications that enabled mouse
 * tracking still go through xterm so wheel reports/arrow-key translation keep
 * working.
 */
function handleWheel(e: Entry, ev: WheelEvent): void {
  if (ev.deltaY === 0 || ev.shiftKey || ev.ctrlKey || ev.metaKey) return;
  if (e.term.buffer.active.type === "alternate") return;
  if (e.term.modes.mouseTrackingMode !== "none") return;
  const screen = e.el.querySelector<HTMLElement>(".xterm-screen");
  const rowHeight =
    screen && e.term.rows > 0
      ? screen.getBoundingClientRect().height / e.term.rows
      : 0;
  if (!(rowHeight > 0)) return;

  ev.preventDefault();
  ev.stopPropagation();
  markUserScroll(e);

  const opts = e.term.options;
  const modifier = opts.fastScrollModifier;
  const fast =
    (modifier === "alt" && ev.altKey) ||
    (modifier === "ctrl" && ev.ctrlKey) ||
    (modifier === "shift" && ev.shiftKey);
  const speed =
    (fast ? (opts.fastScrollSensitivity ?? 5) : 1) *
    (opts.scrollSensitivity ?? 1);

  let lines: number;
  if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    e.wheelPx = 0;
    lines = ev.deltaY * speed;
  } else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    e.wheelPx = 0;
    lines = ev.deltaY * e.term.rows * speed;
  } else {
    // Pixel deltas from trackpads arrive in fractions of a row; accumulate.
    e.wheelPx += ev.deltaY * speed;
    lines = Math.trunc(e.wheelPx / rowHeight);
    if (lines !== 0) e.wheelPx -= lines * rowHeight;
  }
  if (lines !== 0) {
    e.term.scrollLines(lines);
    followFromBuffer(e);
  }
}

/**
 * A scroll event on the viewport. xterm handles the event first, so its
 * `viewportY` is already up to date for a genuine user scroll.
 */
function handleViewportScroll(e: Entry, vp: HTMLElement): void {
  // React removes our element before TerminalView's cleanup runs, so a scroll
  // event is the only moment the live offset can be noted.
  e.scrollTop = vp.scrollTop;
  const b = e.term.buffer.active;

  if (domAtBottom(vp)) {
    // Reached the end of the scrollback. If xterm did not follow — its
    // viewport handler ignores the scroll event that follows its own
    // programmatic write, and a user gesture can coalesce into it — adopt the
    // bottom explicitly so the viewport is not left one line short.
    if (b.viewportY < b.baseY) e.term.scrollLines(b.baseY - b.viewportY);
    setFollow(e, true);
    return;
  }

  if (e.scrollbarDrag || now() - e.userScrollAt < 300) {
    followFromBuffer(e);
    return;
  }

  // xterm's reflow/sync wrote scrollTop on its own. A following terminal must
  // not be nudged off the last line by that (see pinAfterResize).
  if (e.repinUntil > now() && b.viewportY < b.baseY) {
    e.term.scrollToBottom();
  }
}

/** Font size (px) applied to every terminal, adjustable via the zoom shortcuts.
 *  Held here (not per-Entry) so new terminals inherit the current size and a
 *  change fans out to all live ones. Mirrors the persisted `terminalFontSize`. */
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
    lock: true,
    lockListeners: new Set(),
    userScrollAt: 0,
    scrollbarDrag: false,
    wheelPx: 0,
    repinUntil: 0,
    repinRaf: null,
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
      scrollToBottomNow(e);
    });
  } else if (frame.kind === "output") {
    // xterm auto-follows new lines whenever its own `isUserScrolling` flag is
    // clear, so no scroll is needed here. Only repair a following terminal
    // whose viewport was left above the last line by a reflow race.
    e.term.write(frame.data, () => {
      if (!e.follow) return;
      const b = e.term.buffer.active;
      if (b.viewportY < b.baseY) scrollToBottomNow(e);
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

/**
 * Whether auto-follow lock is ON for a task. Defaults to true for new
 * terminals. Safe to call during render.
 */
export function isLocked(serviceId: string, taskId: string): boolean {
  return entries.get(convKey(serviceId, taskId))?.lock ?? true;
}

/**
 * Subscribe to lock-state flips. Returns an unsubscribe function.
 */
export function onLock(
  serviceId: string,
  taskId: string,
  cb: (locked: boolean) => void,
): () => void {
  const e = ensure(serviceId, taskId);
  e.lockListeners.add(cb);
  return () => {
    e.lockListeners.delete(cb);
  };
}

/**
 * Toggle the auto-follow lock. When locking ON while scrolled away the
 * viewport jumps to the latest output and resumes following.
 */
export function toggleLock(serviceId: string, taskId: string): void {
  const e = entries.get(convKey(serviceId, taskId));
  if (!e) return;
  e.lock = !e.lock;
  if (e.lock) {
    // Enabling lock while scrolled away: jump to bottom immediately.
    scrollToBottomNow(e);
    e.term.focus();
  }
  for (const cb of e.lockListeners) cb(e.lock);
}

/** Jump to the latest output and resume auto-following it. */
export function scrollToBottom(serviceId: string, taskId: string): void {
  const e = entries.get(convKey(serviceId, taskId));
  if (!e) return;
  scrollToBottomNow(e);
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
    // Keyboard/selection scrolling goes through xterm's public `scrollLines`,
    // which fires onScroll with the new buffer position.
    e.term.onScroll(() => followFromBuffer(e));

    const vp = viewportEl(e);
    vp?.addEventListener("scroll", () => handleViewportScroll(e, vp));
    // Mousedown on the viewport itself means the native scrollbar thumb;
    // scroll events until release belong to the user.
    vp?.addEventListener("mousedown", (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      e.scrollbarDrag = true;
      markUserScroll(e);
      const up = () => {
        e.scrollbarDrag = false;
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mouseup", up);
    });
    // Capture phase runs before xterm's own wheel listener on `.xterm`, so the
    // normal-buffer wheel gesture never reaches its DOM scroll path.
    e.el.addEventListener("wheel", (ev) => handleWheel(e, ev), {
      capture: true,
      passive: false,
    });
    e.el.addEventListener("touchstart", () => markUserScroll(e), {
      passive: true,
    });
    e.el.addEventListener("touchmove", () => markUserScroll(e), {
      passive: true,
    });
    // When the auto-follow lock is on and the user has scrolled away, pressing
    // any key should jump back to the bottom and resume following.
    e.el.addEventListener("keydown", () => {
      if (e.lock && !e.follow) scrollToBottomNow(e);
    });
  }
  restoreScrollTop(e);
  const settle = () => {
    const wasFollowing = e.follow;
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
    if (wasFollowing) pinAfterResize(e);
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
  const wasFollowing = e.follow;
  try {
    e.fit.fit();
  } catch {
    // ignore
  }
  // fit() reflows the buffer asynchronously; re-pin so a resize never strands
  // the viewport a row above live output.
  if (wasFollowing) pinAfterResize(e);
}

/**
 * Set the shared terminal font size (px). Updates every live terminal and
 * refits it so the grid geometry (and the server PTY, via onResize) tracks the
 * new cell size. New terminals created later pick up the stored value.
 */
export function setFontSize(size: number): void {
  fontSize = size;
  for (const e of entries.values()) {
    const wasFollowing = e.follow;
    e.term.options.fontSize = size;
    if (!e.opened) continue;
    try {
      e.fit.fit();
    } catch {
      // ignore transient zero-size measurements
    }
    e.term.refresh(0, e.term.rows - 1);
    if (wasFollowing) pinAfterResize(e);
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
  if (e.repinRaf !== null) cancelAnimationFrame(e.repinRaf);
  e.term.dispose();
  entries.delete(key);
}
