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
  /** True while the native scrollbar thumb is being dragged. */
  scrollbarDrag: boolean;
  /** `performance.now()` of the last touch gesture, which scrolls the DOM. */
  touchAt: number;
  /** Sub-line pixel remainder of pixel-mode wheel deltas. */
  wheelPx: number;
  /**
   * Deadline until which a just-resized terminal keeps holding a viewport
   * position. xterm's reflow catches up asynchronously and its viewport can
   * look at the old DOM offset as a user scroll, so the position has to be
   * re-asserted for a short window after every grid change.
   */
  settleUntil: number;
  settleRaf: number | null;
  /**
   * Position to hold while settling, as an absolute buffer line.
   * `null` means "the last line", which is what a following terminal wants; a
   * number freezes a scrolled-up view so a resize and the repaint that follows
   * it do not drag the user through the new output.
   */
  settleY: number | null;
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
  // An explicit jump overrides any resize anchor still being held.
  e.settleY = null;
  setFollow(e, true);
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

/** User scroll input wins over an in-flight resize anchor. */
function markUserScroll(e: Entry): void {
  cancelSettle(e);
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
 * Whether it follows is read from xterm's buffer, not the (possibly stale)
 * `follow` flag — a suppressed scroll can leave that flag behind.
 */
function restoreScrollTop(e: Entry): void {
  const vp = viewportEl(e);
  if (!vp) return;
  const b = e.term.buffer.active;
  vp.scrollTop = b.viewportY >= b.baseY ? vp.scrollHeight : e.scrollTop;
}

/** Whether xterm's viewport is riding the last line. */
function atBottom(e: Entry): boolean {
  const b = e.term.buffer.active;
  return b.viewportY >= b.baseY;
}

/** Whether the buffer sits where the active settle target wants it. */
function settleSatisfied(e: Entry): boolean {
  const b = e.term.buffer.active;
  return e.settleY === null || e.settleY >= b.baseY
    ? b.viewportY >= b.baseY
    : b.viewportY === e.settleY;
}

/** Move the viewport to the position the current settle target describes. */
function enforceSettle(e: Entry): void {
  const b = e.term.buffer.active;
  if (e.settleY === null || e.settleY >= b.baseY) {
    if (b.viewportY < b.baseY) scrollToBottomNow(e);
    else setFollow(e, true);
    return;
  }
  if (b.viewportY !== e.settleY) e.term.scrollLines(e.settleY - b.viewportY);
}

function cancelSettle(e: Entry): void {
  e.settleUntil = 0;
  e.settleY = null;
  if (e.settleRaf !== null) {
    cancelAnimationFrame(e.settleRaf);
    e.settleRaf = null;
  }
}

/**
 * Hold a viewport position across a grid change.
 *
 * `fit()` reflows the buffer synchronously, but xterm finishes syncing its
 * scroll area over the following frames. Meanwhile the browser clamps the DOM
 * scroller as the viewport height changes, and xterm treats the resulting
 * scroll event as a *user* scroll — with a large scrollback that can fling the
 * view toward the top, from where auto-follow crawls back down line by line as
 * output arrives. Re-asserting the position in the same task as the fit (and
 * on every frame for a short grace period) keeps the resize from moving the
 * view at all: a following terminal stays on the last line, and a scrolled-up
 * terminal stays where xterm's reflow put it while the repaint streams past.
 *
 * `holdY` is xterm's post-reflow viewport line, or null to ride the last line;
 * a holdY at or past the last line also means "follow the bottom", so a view
 * that reflow leaves at the end of the buffer simply stays there.
 */
function beginSettle(e: Entry, holdY: number | null): void {
  e.settleY = holdY;
  e.settleUntil = now() + 500;
  enforceSettle(e);
  if (e.settleRaf !== null) return;
  const step = () => {
    e.settleRaf = null;
    if (e.settleUntil === 0 || now() >= e.settleUntil) {
      cancelSettle(e);
      return;
    }
    enforceSettle(e);
    e.settleRaf = requestAnimationFrame(step);
  };
  e.settleRaf = requestAnimationFrame(step);
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
  // A wheel event is not a DOM gesture; clear the touch marker so its own
  // scroll echoes are never mistaken for one.
  e.touchAt = 0;

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
 * A scroll event on the viewport. xterm's own listener runs first, so for a
 * DOM gesture its `viewportY` is already up to date by the time this runs.
 *
 * Scroll events come from two very different sources, and conflating them is
 * what breaks the viewport:
 *
 * - a DOM gesture — scrollbar drag or touch — which moved `scrollTop` and which
 *   xterm translated into a buffer scroll;
 * - an echo of xterm writing `scrollTop` itself (reflow, the async sync after
 *   `scrollLines`, or the browser clamping it when the viewport shrinks).
 *
 * Wheel input never takes the DOM path (see `handleWheel`), so its echoes must
 * not be read as "the user is at the bottom now": at the last line the browser
 * still reports the old, maxed-out offset for a frame, and adopting that would
 * silently undo the wheel notch. Only gestures may adopt the bottom; echoes are
 * judged against xterm's buffer, which is the source of truth.
 */
function handleViewportScroll(e: Entry, vp: HTMLElement): void {
  // React removes our element before TerminalView's cleanup runs, so a scroll
  // event is the only moment the live offset can be noted.
  e.scrollTop = vp.scrollTop;
  const b = e.term.buffer.active;

  if (e.scrollbarDrag || now() - e.touchAt < 300) {
    if (domAtBottom(vp)) {
      // Rounding can leave xterm a row short of the DOM bottom; adopt it so
      // the scrollbar's end really is the last line.
      if (b.viewportY < b.baseY) e.term.scrollLines(b.baseY - b.viewportY);
      setFollow(e, true);
    } else {
      followFromBuffer(e);
    }
    return;
  }

  // A resize is in flight: hold the target position and ignore the offsets
  // xterm's reflow writes along the way.
  if (e.settleUntil > now()) {
    enforceSettle(e);
    return;
  }

  if (b.viewportY >= b.baseY) {
    // Nothing moved the view away from the last line; keep following even if
    // xterm swallowed the scroll notification.
    setFollow(e, true);
    return;
  }

  // xterm wrote a stale offset while we believe we are following (a clamp
  // misread as a user scroll). Repair it instead of silently ending follow.
  if (e.follow) e.term.scrollToBottom();
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
    scrollbarDrag: false,
    touchAt: 0,
    wheelPx: 0,
    settleUntil: 0,
    settleRaf: null,
    settleY: null,
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
    // whose viewport was left above the last line by a reflow race. The buffer
    // is the truth: if it sits on the last line, follow regardless of a flag
    // that a swallowed scroll event may have left behind.
    e.term.write(frame.data, () => {
      const b = e.term.buffer.active;
      if (b.viewportY >= b.baseY) {
        setFollow(e, true);
      } else if (e.follow) {
        scrollToBottomNow(e);
      }
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
    // which fires onScroll with the new buffer position. A buffer move that is
    // not the one the settle is holding means the user took over; drop it.
    e.term.onScroll(() => {
      if (e.settleUntil > now() && !settleSatisfied(e)) cancelSettle(e);
      followFromBuffer(e);
    });

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
    e.el.addEventListener(
      "touchstart",
      () => {
        e.touchAt = now();
        markUserScroll(e);
      },
      { passive: true },
    );
    e.el.addEventListener(
      "touchmove",
      () => {
        e.touchAt = now();
        markUserScroll(e);
      },
      { passive: true },
    );
    // When the auto-follow lock is on and the user has scrolled away, typing
    // should jump back to the bottom and resume following. Control shortcuts
    // (Ctrl+C, Cmd+C, arrows, Escape, …) leave the viewport alone. Capture
    // phase: xterm cancels (stopPropagation) the keydowns it consumes.
    e.el.addEventListener(
      "keydown",
      (ev) => {
        if (e.lock && !e.follow && isTypingKey(ev)) scrollToBottomNow(e);
      },
      true,
    );
    // Pasting inserts text like typing does, but produces no keydown.
    e.el.addEventListener(
      "paste",
      () => {
        if (e.lock && !e.follow) scrollToBottomNow(e);
      },
      true,
    );
  }
  restoreScrollTop(e);
  const settle = () => {
    // Decide from xterm's buffer, not the flag: a suppressed scroll can leave
    // `follow` stale, and a drag can call this several times in a row.
    const following = atBottom(e);
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
    beginSettle(e, following ? null : e.term.buffer.active.viewportY);
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
  // `follow` is the user's intent; the buffer can already have been nudged by
  // the resize's own scroll clamping before this runs. A following terminal is
  // pinned to the last line, a scrolled-up one holds whatever xterm's reflow
  // leaves visible.
  const following = e.follow;
  try {
    e.fit.fit();
  } catch {
    // ignore
  }
  // Reflow and the browser's scroll clamping run async and can be mistaken for
  // user scrolls; hold the position across them.
  beginSettle(e, following ? null : e.term.buffer.active.viewportY);
}

/**
 * Set the shared terminal font size (px). Updates every live terminal and
 * refits it so the grid geometry (and the server PTY, via onResize) tracks the
 * new cell size. New terminals created later pick up the stored value.
 */
export function setFontSize(size: number): void {
  fontSize = size;
  for (const e of entries.values()) {
    const following = e.follow;
    e.term.options.fontSize = size;
    if (!e.opened) continue;
    try {
      e.fit.fit();
    } catch {
      // ignore transient zero-size measurements
    }
    e.term.refresh(0, e.term.rows - 1);
    beginSettle(e, following ? null : e.term.buffer.active.viewportY);
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
  cancelSettle(e);
  e.term.dispose();
  entries.delete(key);
}
