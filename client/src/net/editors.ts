//! Persistent CodeMirror editor registry, kept OUTSIDE React so switching the
//! selected workspace (or the active tab) never discards an open file's unsaved
//! edits, scroll, or undo history — mirroring how `net/terminals.ts` preserves
//! terminal scrollback.
//!
//! One view is kept per open tab, keyed by `workspaceId` + the tab's `tabKey`.
//! An editable file (or an inline diff) is a single `EditorView`; a side-by-side
//! diff is a `@codemirror/merge` `MergeView`; a media file is a plain media
//! element, so switching tabs doesn't refetch it or restart playback.
//! `EditorArea` re-parents the active
//! tab's DOM into the visible pane; inactive tabs' views stay alive (detached) so
//! returning to them is instant and lossless. Closing a tab (or removing the
//! workspace) destroys the corresponding view(s).
//!
//! The registry also owns each tab's long-line wrap choice, so flipping it
//! reconfigures the live view in place instead of rebuilding it (which would cost
//! the tab its edits, scroll, and undo) and so the choice survives a workspace
//! switch the same way the view does. Each markdown tab's rendered-vs-source
//! choice lives here too, for the same reason.

import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import type { DiffLayout } from "../store/types";

interface Entry {
  /** The DOM node `EditorArea` re-parents into the visible pane. */
  dom: HTMLElement;
  /** Tears down the underlying view(s) (`EditorView`/`MergeView` `.destroy()`). */
  destroy: () => void;
  /** The editable CodeMirror view — present for edit tabs (save/dirty use it). */
  editor?: EditorView;
  /** Every CodeMirror view this entry owns: one, or two for a split diff. */
  views: EditorView[];
  /**
   * Scroll positions captured on detach, one per entry in `views`. Detaching a
   * node resets its scroll offsets, and CodeMirror keeps the scroll position in
   * the DOM rather than in editor state, so it has to be carried across a
   * re-parent by hand.
   */
  scroll?: ReturnType<EditorView["scrollSnapshot"]>[];
  /** Re-measure the view(s) after re-parenting (CM needs this post-detach). */
  measure?: () => void;
  /** For diff tabs: which layout the live view was built in. */
  layout?: DiffLayout;
  /** For diff tabs: cached sides, so a layout toggle rebuilds without refetching. */
  diff?: { oldText: string; newText: string };
  /** Whether the buffer has unsaved edits. */
  dirty: boolean;
  /**
   * For edit tabs: last on-disk mtime (unix millis) known to match the
   * buffer's origin — set on load, save, reload, or when the user dismisses a
   * disk-change notice. The staleness poll compares stat results against this.
   */
  mtime?: number;
  /** Disk mtime observed when an out-of-app change was flagged. */
  diskMtime?: number;
  /** True when the file changed on disk and the user hasn't resolved it yet. */
  changedOnDisk?: boolean;
  /**
   * True while a save is in flight — suppresses the staleness poll so our own
   * write's new mtime isn't misread as an out-of-app change.
   */
  saving?: boolean;
}

const entries = new Map<string, Entry>();

const SEP = " ";
function mapKey(workspaceId: string, tabKey: string): string {
  return `${workspaceId}${SEP}${tabKey}`;
}

/** The full registry entry for a tab, if one has been built. */
export function getEntry(
  workspaceId: string,
  tabKey: string,
): Entry | undefined {
  return entries.get(mapKey(workspaceId, tabKey));
}

/** The editable view for a tab (edit tabs only), if one has been built. */
export function getView(
  workspaceId: string,
  tabKey: string,
): EditorView | undefined {
  return entries.get(mapKey(workspaceId, tabKey))?.editor;
}

/** Register a freshly-built editable view for a tab. */
export function setView(
  workspaceId: string,
  tabKey: string,
  view: EditorView,
  mtime?: number,
): void {
  entries.set(mapKey(workspaceId, tabKey), {
    dom: view.dom,
    destroy: () => view.destroy(),
    editor: view,
    views: [view],
    dirty: false,
    mtime,
  });
}

/**
 * Register a freshly-built diff view for a tab. `dom`/`destroy` come from the
 * underlying `EditorView` (inline) or `MergeView` (split); `layout` + `diff`
 * let a later layout toggle rebuild from cache instead of refetching.
 */
export function setDiffView(
  workspaceId: string,
  tabKey: string,
  v: {
    dom: HTMLElement;
    destroy: () => void;
    measure: () => void;
    views: EditorView[];
    layout: DiffLayout;
    diff: { oldText: string; newText: string };
  },
): void {
  entries.set(mapKey(workspaceId, tabKey), {
    dom: v.dom,
    destroy: v.destroy,
    views: v.views,
    measure: v.measure,
    layout: v.layout,
    diff: v.diff,
    dirty: false,
  });
}

/**
 * Register a media preview for a tab: `dom` is the wrapper around the
 * `<img>`/`<audio>`/`<video>` element, and `destroy` releases the preview's
 * backing cache file (or object URL). Because teardown runs through the same
 * `destroy` path as an editor view, closing the tab — or removing the workspace —
 * already frees the cached bytes.
 */
export function setMediaView(
  workspaceId: string,
  tabKey: string,
  v: { dom: HTMLElement; destroy: () => void },
): void {
  entries.set(mapKey(workspaceId, tabKey), {
    dom: v.dom,
    destroy: v.destroy,
    views: [],
    dirty: false,
  });
}

/**
 * Remember where each of a tab's views is scrolled, just before its DOM leaves
 * the pane, so `restoreScroll` can put it back when the tab is next activated.
 */
export function saveScroll(workspaceId: string, tabKey: string): void {
  const e = entries.get(mapKey(workspaceId, tabKey));
  if (!e) return;
  e.scroll = e.views.map((v) => v.scrollSnapshot());
}

/** Re-apply the offsets from `saveScroll`, once the DOM is back in the pane. */
export function restoreScroll(workspaceId: string, tabKey: string): void {
  const e = entries.get(mapKey(workspaceId, tabKey));
  const snapshots = e?.scroll;
  if (!e || !snapshots) return;
  e.views.forEach((v, i) => {
    if (snapshots[i]) v.dispatch({ effects: snapshots[i] });
  });
  e.scroll = undefined;
}

export function setDirty(
  workspaceId: string,
  tabKey: string,
  dirty: boolean,
): void {
  const e = entries.get(mapKey(workspaceId, tabKey));
  if (e) e.dirty = dirty;
}

export function isDirty(workspaceId: string, tabKey: string): boolean {
  return entries.get(mapKey(workspaceId, tabKey))?.dirty ?? false;
}

/** Rebase the disk baseline after a load, save, or reload. */
export function setMtime(
  workspaceId: string,
  tabKey: string,
  mtime: number,
): void {
  const e = entries.get(mapKey(workspaceId, tabKey));
  if (e) e.mtime = mtime;
}

export function setSaving(
  workspaceId: string,
  tabKey: string,
  saving: boolean,
): void {
  const e = entries.get(mapKey(workspaceId, tabKey));
  if (e) e.saving = saving;
}

export function isSaving(workspaceId: string, tabKey: string): boolean {
  return entries.get(mapKey(workspaceId, tabKey))?.saving ?? false;
}

/** Flag an out-of-app change, remembering the observed disk mtime. */
export function flagDiskChange(
  workspaceId: string,
  tabKey: string,
  diskMtime: number,
): void {
  const e = entries.get(mapKey(workspaceId, tabKey));
  if (!e) return;
  e.changedOnDisk = true;
  e.diskMtime = diskMtime;
}

/**
 * Resolve a flagged disk change. `adoptDiskMtime` (the "keep my buffer" path)
 * rebases the baseline onto the observed disk mtime so the notice only returns
 * if the file changes *again*; reload/save pass `false` and set the baseline
 * themselves via `setMtime`.
 */
export function clearDiskChange(
  workspaceId: string,
  tabKey: string,
  adoptDiskMtime: boolean,
): void {
  const e = entries.get(mapKey(workspaceId, tabKey));
  if (!e) return;
  e.changedOnDisk = false;
  if (adoptDiskMtime && e.diskMtime !== undefined) e.mtime = e.diskMtime;
  e.diskMtime = undefined;
}

export function isChangedOnDisk(workspaceId: string, tabKey: string): boolean {
  return entries.get(mapKey(workspaceId, tabKey))?.changedOnDisk ?? false;
}

/**
 * Long-line wrap. One compartment instance is shared by every view: each editor
 * state holds its own value for it, and `reconfigure` only ever reaches the state
 * it is dispatched to, so a single shared instance is what lets one toggle flip a
 * split diff's two panes together.
 */
const wrapCompartment = new Compartment();

/** The wrap extension to build a view with, so it starts in the tab's state. */
export function wrapExtension(wrap: boolean): Extension {
  return wrapCompartment.of(wrap ? EditorView.lineWrapping : []);
}

/**
 * Each tab's wrap choice, keyed like {@link entries} but kept apart from it: a
 * tab can have a choice before it has a view (the toggle works while a build is
 * still in flight), so reading one must not depend on an entry existing.
 * Destroying a tab's view forgets its choice, which is what makes a file closed
 * and reopened later start from the global default again.
 */
const wraps = new Map<string, boolean>();

/**
 * Whether each markdown tab shows the rendered view or the raw source. Just a
 * recorded choice — the view itself is untouched — so `EditorArea` can keep the
 * CodeMirror buffer alive (hidden) behind the rendered pane, and reopening a
 * closed tab starts rendered again. `undefined` means "no choice yet", which
 * reads as the rendered default.
 */
const mdPreviews = new Map<string, boolean>();

/**
 * The tab's rendered-vs-source choice for markdown, or `undefined` if the tab
 * never toggled it (callers apply the rendered default themselves).
 */
export function getMdPreview(
  workspaceId: string,
  tabKey: string,
): boolean | undefined {
  return mdPreviews.get(mapKey(workspaceId, tabKey));
}

/** Record a markdown tab's rendered-vs-source choice. */
export function setMdPreview(
  workspaceId: string,
  tabKey: string,
  rendered: boolean,
): void {
  mdPreviews.set(mapKey(workspaceId, tabKey), rendered);
}

/** The tab's wrap choice, or `undefined` if it hasn't been seeded yet. */
export function getWrap(
  workspaceId: string,
  tabKey: string,
): boolean | undefined {
  return wraps.get(mapKey(workspaceId, tabKey));
}

/**
 * Set a tab's wrap choice and apply it to its live views. Called before the view
 * exists (a tab seeded from the global default, or one whose build is still in
 * flight) it only records the choice, which the build then picks up.
 */
export function setWrap(
  workspaceId: string,
  tabKey: string,
  wrap: boolean,
): void {
  const k = mapKey(workspaceId, tabKey);
  wraps.set(k, wrap);
  const effect = wrapCompartment.reconfigure(
    wrap ? EditorView.lineWrapping : [],
  );
  entries.get(k)?.views.forEach((v) => v.dispatch({ effects: effect }));
}

/**
 * Ask every live view to re-measure. Font size is applied via a CSS variable on
 * the host, so the DOM restyles on its own; CodeMirror, however, caches line
 * heights and must be told to recompute after the cell size changes.
 */
export function remeasureAll(): void {
  for (const e of entries.values()) {
    e.editor?.requestMeasure();
    e.measure?.();
  }
}

function destroy(key: string): void {
  wraps.delete(key);
  mdPreviews.delete(key);
  const e = entries.get(key);
  if (!e) return;
  if (e.dom.parentElement) {
    e.dom.parentElement.removeChild(e.dom);
  }
  e.destroy();
  entries.delete(key);
}

/** Permanently drop one tab's view (on tab close, or before a diff rebuild). */
export function disposeTab(workspaceId: string, tabKey: string): void {
  destroy(mapKey(workspaceId, tabKey));
}

/** Permanently drop every tab's view for a workspace (on workspace/service removal). */
export function dispose(workspaceId: string): void {
  const prefix = `${workspaceId}${SEP}`;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix)) destroy(key);
  }
}
