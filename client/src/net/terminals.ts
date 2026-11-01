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
   * When lock is ON, typing or pasting while scrolled away returns to the
   * bottom and resumes following. Control shortcuts (Ctrl+C, Cmd+C, arrows,
   * …) do not. A toggle button in the terminal UI controls this flag.
   */
  lock: boolean;
  /** Notified on every `lock` flip; see onLock. */
  lockListeners: Set<(locked: boolean) => void>;
  serviceId: string;
  taskId: string;
  /** Last native scrollbar/touch input; wheel uses xterm's buffer API instead. */
  nativeScrollAt: number;
  /** True while the native scrollbar thumb is being dragged. */
  scrollbarDrag: boolean;
  /** Sub-line pixel remainder of pixel-mode wheel deltas. */
  wheelPx: number;
  /** Last buffer position not produced by a resize transient. */
  stableY: number;
  resizeRestore: ResizeRestore | null;
}

interface ResizeRestore {
  following: boolean;
  distanceFromBottom: number;
  targetY: number | null;
  framesRemaining: number;
  raf: number | null;
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
  syncViewportTop(e);
  e.stableY = e.term.buffer.active.viewportY;
  e.wheelPx = 0;
  setFollow(e, true);
}

function jumpToBottom(e: Entry): void {
  cancelResizeRestore(e);
  scrollToBottomNow(e);
}

/**
 * Whether a keydown is ordinary text input rather than a control shortcut.
 * Typing while scrolled up should bring the viewport back to the cursor, but
 * Ctrl+C/Cmd+C and friends are commands sent while reading history — they
 * must not yank the viewport away. Enter/Backspace/Tab edit the current input
 * line, and IME composition still lands text in the terminal, so both count
 * as typing; Escape, arrows and function keys do not.
 */
function isTypingKey(ev: KeyboardEvent): boolean {
  if (ev.isComposing || ev.key === "Process") return true;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
  if (ev.key.length === 1) return true;
  return ev.key === "Enter" || ev.key === "Backspace" || ev.key === "Tab";
}

/** User input wins over an in-flight resize restoration. */
function markUserScroll(e: Entry, native = false): void {
  e.nativeScrollAt = native ? now() : 0;
  cancelResizeRestore(e);
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

function rowHeight(e: Entry): number {
  const screen = e.el.querySelector<HTMLElement>(".xterm-screen");
  return screen && e.term.rows > 0
    ? screen.getBoundingClientRect().height / e.term.rows
    : 0;
}

/** Match the DOM to the buffer in the same task, before a stale scroll event. */
function syncViewportTop(e: Entry): void {
  const vp = viewportEl(e);
  const height = rowHeight(e);
  if (!vp || !(height > 0)) return;
  const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
  const target = e.term.buffer.active.viewportY * height;
  vp.scrollTop = Math.max(0, Math.min(target, max));
  e.scrollTop = vp.scrollTop;
}

function cancelResizeRestore(e: Entry): void {
  const restore = e.resizeRestore;
  if (restore?.raf !== null && restore?.raf !== undefined) {
    cancelAnimationFrame(restore.raf);
  }
  e.resizeRestore = null;
}

function restoreViewport(e: Entry): void {
  const restore = e.resizeRestore;
  if (!restore) return;
  const b = e.term.buffer.active;
  if (!restore.following && restore.targetY === null) {
    restore.targetY = Math.max(0, b.baseY - restore.distanceFromBottom);
  }
  const target = restore.following ? b.baseY : restore.targetY!;
  e.term.scrollToLine(target);
  syncViewportTop(e);
  setFollow(e, target >= b.baseY);
}

function fitAndRestore(e: Entry, force = false): void {
  let dims: ReturnType<FitAddon["proposeDimensions"]>;
  try {
    dims = e.fit.proposeDimensions();
  } catch {
    return;
  }
  if (!dims) return;
  if (!force && dims.cols === e.term.cols && dims.rows === e.term.rows) {
    return;
  }

  const b = e.term.buffer.active;
  const stableY = Math.max(0, Math.min(e.stableY, b.baseY));
  const previousRestore = e.resizeRestore;
  const anchorY = previousRestore?.targetY ?? stableY;
  cancelResizeRestore(e);
  const restore: ResizeRestore = {
    following: previousRestore?.following ?? e.follow,
    distanceFromBottom: b.baseY - anchorY,
    targetY: null,
    framesRemaining: 2,
    raf: null,
  };
  e.resizeRestore = restore;
  try {
    e.fit.fit();
  } catch {
    cancelResizeRestore(e);
    return;
  }
  restoreViewport(e);

  const step = () => {
    if (e.resizeRestore !== restore) return;
    restore.raf = null;
    restoreViewport(e);
    restore.framesRemaining--;
    if (restore.framesRemaining === 0) {
      e.stableY = e.term.buffer.active.viewportY;
      e.resizeRestore = null;
      return;
    }
    restore.raf = requestAnimationFrame(step);
  };
  restore.raf = requestAnimationFrame(step);
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
  const height = rowHeight(e);
  if (!(height > 0)) return;

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
    lines = Math.trunc(e.wheelPx / height);
    if (lines !== 0) e.wheelPx -= lines * height;
  }
  if (lines !== 0) {
    e.term.scrollLines(lines);
    syncViewportTop(e);
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
  const nativeGesture =
    e.scrollbarDrag || (e.nativeScrollAt > 0 && now() - e.nativeScrollAt < 300);
  if (!nativeGesture) return;

  const b = e.term.buffer.active;
  if (domAtBottom(vp)) {
    if (b.viewportY < b.baseY) {
      e.term.scrollLines(b.baseY - b.viewportY);
      syncViewportTop(e);
    }
    setFollow(e, true);
  } else {
    followFromBuffer(e);
  }
  e.stableY = b.viewportY;
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
    // xterm otherwise jumps to the bottom on every user byte — including
    // control bytes like Ctrl+C's ^C — while the user is reading scrollback.
    // The keydown listener in `attach` decides which input should jump.
    scrollOnUserInput: false,
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
    nativeScrollAt: 0,
    scrollbarDrag: false,
    wheelPx: 0,
    stableY: 0,
    resizeRestore: null,
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
    cancelResizeRestore(e);
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
    jumpToBottom(e);
    e.term.focus();
  }
  for (const cb of e.lockListeners) cb(e.lock);
}

/** Jump to the latest output and resume auto-following it. */
export function scrollToBottom(serviceId: string, taskId: string): void {
  const e = entries.get(convKey(serviceId, taskId));
  if (!e) return;
  jumpToBottom(e);
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
    e.term.onScroll(() => {
      if (e.resizeRestore) return;
      e.stableY = e.term.buffer.active.viewportY;
      followFromBuffer(e);
    });

    const vp = viewportEl(e);
    vp?.addEventListener("scroll", () => handleViewportScroll(e, vp));
    // Mousedown on the viewport itself means the native scrollbar thumb;
    // scroll events until release belong to the user.
    vp?.addEventListener("mousedown", (ev: MouseEvent) => {
      if (ev.button !== 0) return;
      e.scrollbarDrag = true;
      markUserScroll(e, true);
      const up = () => {
        e.scrollbarDrag = false;
        markUserScroll(e, true);
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
    e.el.addEventListener("touchstart", () => markUserScroll(e, true), {
      passive: true,
    });
    e.el.addEventListener("touchmove", () => markUserScroll(e, true), {
      passive: true,
    });
    e.el.addEventListener("touchend", () => markUserScroll(e, true), {
      passive: true,
    });
    // When the auto-follow lock is on and the user has scrolled away, typing
    // should jump back to the bottom and resume following. Control shortcuts
    // (Ctrl+C, Cmd+C, arrows, Escape, …) leave the viewport alone. Capture
    // phase: xterm cancels (stopPropagation) the keydowns it consumes.
    e.el.addEventListener(
      "keydown",
      (ev) => {
        if (e.lock && !e.follow && isTypingKey(ev)) jumpToBottom(e);
      },
      true,
    );
    // Pasting inserts text like typing does, but produces no keydown.
    e.el.addEventListener(
      "paste",
      () => {
        if (e.lock && !e.follow) jumpToBottom(e);
      },
      true,
    );
  }
  restoreScrollTop(e);
  const settle = () => {
    fitAndRestore(e);
    // Repaint every row: output written while this terminal was detached (a
    // background task) can leave the renderer's grid stale, drawing new content
    // over old on re-attach. A full refresh clears that; a plain fit does not
    // when the geometry is unchanged.
    e.term.refresh(0, e.term.rows - 1);
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
  if (!e) return;
  cancelResizeRestore(e);
  if (e.el.parentElement) e.el.parentElement.removeChild(e.el);
}

/** Refit the currently mounted terminal (call on container resize). */
export function refit(serviceId: string, taskId: string): void {
  const e = entries.get(convKey(serviceId, taskId));
  if (!e?.opened) return;
  fitAndRestore(e);
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
    fitAndRestore(e, true);
    e.term.refresh(0, e.term.rows - 1);
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
