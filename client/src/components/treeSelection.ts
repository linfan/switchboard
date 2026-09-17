//! The file tree's multi-selection rules, kept apart from the tree component so
//! they can be exercised without rendering it (vitest only picks up `*.test.ts`).
//!
//! Selection is by file path and only ever holds files: the host refuses to
//! download a directory, so folder rows are not selectable.

/** How a click modifies the selection. */
export interface ClickMods {
  /** ⌘/Ctrl: toggle this row's membership instead of replacing the selection. */
  toggle: boolean;
  /** Shift: extend the selection from the anchor to this row. */
  range: boolean;
}

export interface Selection {
  paths: Set<string>;
  /** The row range clicks measure from: the last plain/⌘ click. */
  anchor: string | null;
  /** True when the cap cut the click short, so the UI can say so. */
  hitCap: boolean;
}

export const emptySelection = (): Selection => ({
  paths: new Set(),
  anchor: null,
  hitCap: false,
});

/**
 * The file rows the tree currently renders, in visual order. Hidden rows are
 * unmounted rather than `display: none`, so document order *is* visual order,
 * and a collapsed or filtered-away folder simply contributes nothing.
 */
export function visibleFilePaths(tree: Element): string[] {
  return [
    ...tree.querySelectorAll<HTMLElement>(".weditor__row--file[data-path]"),
  ].map((row) => row.dataset.path ?? "");
}

/** The selection a click on `target` leaves behind, capped at `cap` files. */
export function nextSelection(
  prev: Selection,
  target: string,
  visible: string[],
  mods: ClickMods,
  cap: number,
): Selection {
  if (mods.toggle) {
    const paths = new Set(prev.paths);
    if (paths.has(target)) {
      paths.delete(target);
      return { paths, anchor: target, hitCap: false };
    }
    if (paths.size >= cap) {
      return { ...prev, paths, hitCap: true };
    }
    paths.add(target);
    return { paths, anchor: target, hitCap: false };
  }

  if (mods.range && prev.anchor !== null) {
    const from = visible.indexOf(prev.anchor);
    const to = visible.indexOf(target);
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      const paths = new Set(prev.paths);
      let hitCap = false;
      for (const path of visible.slice(start, end + 1)) {
        if (paths.has(path)) continue;
        if (paths.size >= cap) {
          hitCap = true;
          break;
        }
        paths.add(path);
      }
      return { paths, anchor: prev.anchor, hitCap };
    }
    // The anchor scrolled out of view or its folder collapsed since it was
    // clicked: there is no range to speak of, so treat this as a plain pick.
  }

  return { paths: new Set([target]), anchor: target, hitCap: false };
}

/** Collapse the selection to the one row a context menu is opening on. */
export function selectOnly(target: string): Selection {
  return { paths: new Set([target]), anchor: target, hitCap: false };
}
