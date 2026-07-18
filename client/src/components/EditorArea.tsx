import { basicSetup } from "codemirror";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";

import * as editors from "../net/editors";
import { gitFileDiff, readFile, writeFile } from "../net/rest";
import { tabKey, type DiffLayout, type OpenFile } from "../store/types";
import { ContextMenu } from "./Menu";

/** Map a file path's extension to a CodeMirror language extension (or none). */
function langForPath(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return javascript({ typescript: true, jsx: ext === "tsx" });
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext === "jsx" });
    case "json":
      return json();
    case "py":
      return python();
    case "rs":
      return rust();
    case "md":
    case "markdown":
      return markdown();
    case "html":
    case "htm":
      return html();
    case "css":
      return css();
    default:
      return [];
  }
}

/** Base name of a path, for tab labels. */
function basename(path: string): string {
  return path.split("/").pop() || path;
}

type Status = "loading" | "ready" | "binary" | "error";

/** A built diff view (inline `EditorView` or split `MergeView`), normalized. */
interface BuiltDiff {
  dom: HTMLElement;
  destroy: () => void;
  measure: () => void;
}

/**
 * The right-hand editor pane: a tab bar over the open files plus the active
 * file's editor. Tree files are editable (Cmd/Ctrl+S saves). Diff files are
 * read-only and rendered with a real diff editor — inline (unified) or
 * side-by-side, switchable via the tab-bar toggle. Each tab's live view lives in
 * the `editors` registry so switching tabs — or workspaces — preserves unsaved
 * edits, scroll, and undo.
 */
export function EditorArea({
  workspaceId,
  service,
  cwd,
  tabs,
  activeKey,
  diffLayout,
  onActivate,
  onClose,
  onReorder,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onDiffLayout,
}: {
  workspaceId: string;
  service: { url: string; token: string };
  cwd: string;
  tabs: OpenFile[];
  activeKey?: string;
  diffLayout: DiffLayout;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onReorder: (fromKey: string, toKey: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseToRight: (key: string) => void;
  onCloseAll: () => void;
  onDiffLayout: (layout: DiffLayout) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  // Per-tab dirty flags, mirrored from the registry so the tab bar re-renders.
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  // Drag-to-reorder state: the tab key being dragged, and the one hovered over.
  // A ref mirrors the source key so drag handlers read it synchronously,
  // without waiting for the state update from dragstart to flush.
  const dragKeyRef = useRef<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  // True while hovering the empty area past the last tab (drop = move to end).
  const [dragOverEnd, setDragOverEnd] = useState(false);
  // Right-click context menu: cursor position + the tab it targets.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    key: string;
  } | null>(null);

  const active =
    tabs.find((t) => tabKey(t) === activeKey) ?? tabs[tabs.length - 1];
  const path = active?.path;
  const mode = active?.mode;
  const commit = active?.commit;
  const key = active ? tabKey(active) : undefined;

  const markDirty = (k: string, d: boolean) => {
    editors.setDirty(workspaceId, k, d);
    setDirty((m) => ({ ...m, [k]: d }));
  };

  const save = (k: string, filePath: string, view: EditorView): boolean => {
    writeFile(service, filePath, view.state.doc.toString())
      .then(() => markDirty(k, false))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
    return true;
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !path || !mode || !key) return;

    let cancelled = false;
    let attachedDom: HTMLElement | null = null;
    setError(null);

    const attach = (dom: HTMLElement, measure?: () => void, focus?: EditorView) => {
      host.appendChild(dom);
      attachedDom = dom;
      requestAnimationFrame(() => {
        if (cancelled) return;
        measure?.();
        if (mode === "edit") focus?.focus();
      });
    };

    const buildEditView = (content: string): EditorView =>
      new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            oneDark,
            langForPath(path),
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: (v) => save(key, path, v),
              },
            ]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) markDirty(key, true);
            }),
          ],
        }),
      });

    // Read-only diff editor: inline (unified) or side-by-side, per `diffLayout`.
    const buildDiffView = (
      oldText: string,
      newText: string,
      layout: DiffLayout,
    ): BuiltDiff => {
      const readOnly = [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ];
      const lang = langForPath(path);
      const collapseUnchanged = { margin: 3, minSize: 4 };

      if (layout === "split") {
        const mv = new MergeView({
          a: { doc: oldText, extensions: [basicSetup, oneDark, lang, ...readOnly] },
          b: { doc: newText, extensions: [basicSetup, oneDark, lang, ...readOnly] },
          gutter: true,
          highlightChanges: true,
          collapseUnchanged,
        });
        return {
          dom: mv.dom,
          destroy: () => mv.destroy(),
          measure: () => {
            mv.a.requestMeasure();
            mv.b.requestMeasure();
          },
        };
      }

      const view = new EditorView({
        state: EditorState.create({
          doc: newText,
          extensions: [
            basicSetup,
            oneDark,
            lang,
            ...readOnly,
            unifiedMergeView({
              original: oldText,
              mergeControls: false,
              gutter: true,
              collapseUnchanged,
            }),
          ],
        }),
      });
      return {
        dom: view.dom,
        destroy: () => view.destroy(),
        measure: () => view.requestMeasure(),
      };
    };

    const registerDiff = (built: BuiltDiff, diff: { oldText: string; newText: string }) => {
      editors.setDiffView(workspaceId, key, {
        dom: built.dom,
        destroy: built.destroy,
        measure: built.measure,
        layout: diffLayout,
        diff,
      });
    };

    const existing = editors.getEntry(workspaceId, key);

    if (mode === "diff") {
      if (existing && existing.layout === diffLayout) {
        // Same layout — re-parent the live view, preserving scroll.
        setStatus("ready");
        attach(existing.dom, existing.measure);
      } else if (existing?.diff) {
        // Layout toggled — rebuild from the cached sides (no refetch).
        const { oldText, newText } = existing.diff;
        editors.disposeTab(workspaceId, key);
        const built = buildDiffView(oldText, newText, diffLayout);
        registerDiff(built, { oldText, newText });
        attach(built.dom, built.measure);
        setStatus("ready");
      } else {
        // First open — fetch both sides.
        setStatus("loading");
        const load = async () => {
          const fd = await gitFileDiff(service, cwd, commit ?? "WORKING", path);
          if (cancelled) return;
          if (fd.binary) {
            setStatus("binary");
            return;
          }
          const diff = { oldText: fd.old_text, newText: fd.new_text };
          const built = buildDiffView(diff.oldText, diff.newText, diffLayout);
          registerDiff(built, diff);
          attach(built.dom, built.measure);
          setStatus("ready");
        };
        load().catch((e: unknown) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        });
      }
    } else if (existing?.editor) {
      // Editable tab already built — re-parent, preserving edits/scroll.
      const view = existing.editor;
      setStatus("ready");
      attach(view.dom, () => view.requestMeasure(), view);
    } else {
      setStatus("loading");
      const load = async () => {
        const fc = await readFile(service, path);
        if (cancelled) return;
        if (fc.truncated) {
          setStatus("binary");
          return;
        }
        const view = buildEditView(fc.content);
        editors.setView(workspaceId, key, view);
        attach(view.dom, () => view.requestMeasure(), view);
        setStatus("ready");
      };
      load().catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      });
    }

    return () => {
      cancelled = true;
      // Detach (but don't destroy) so the view survives a tab/workspace switch.
      if (attachedDom && attachedDom.parentElement === host) {
        host.removeChild(attachedDom);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, key, path, mode, commit, diffLayout]);

  // Dispose the live views for a set of tab keys and forget their dirty flags.
  // The store still owns the tab list; this just tears down the CM editors.
  const disposeKeys = (keys: string[]) => {
    if (keys.length === 0) return;
    keys.forEach((k) => editors.disposeTab(workspaceId, k));
    setDirty((m) => {
      const next = { ...m };
      keys.forEach((k) => delete next[k]);
      return next;
    });
  };

  const closeTab = (k: string) => {
    disposeKeys([k]);
    onClose(k);
  };

  const keysOf = (list: OpenFile[]) => list.map((t) => tabKey(t));

  const closeOthers = (k: string) => {
    disposeKeys(keysOf(tabs).filter((tk) => tk !== k));
    onCloseOthers(k);
  };

  const closeToRight = (k: string) => {
    const idx = tabs.findIndex((t) => tabKey(t) === k);
    if (idx === -1) return;
    disposeKeys(keysOf(tabs.slice(idx + 1)));
    onCloseToRight(k);
  };

  const closeAll = () => {
    disposeKeys(keysOf(tabs));
    onCloseAll();
  };

  if (tabs.length === 0 || !active) {
    return (
      <div className="weditor__area weditor__area--empty">
        <p className="empty">Select a file to view or edit.</p>
      </div>
    );
  }

  const isDirty = (k: string) => dirty[k] ?? editors.isDirty(workspaceId, k);

  return (
    <div className="weditor__area">
      <div className="weditor__tabbar">
        <div
          className={`weditor__tabs ${dragOverEnd ? "is-dragover-end" : ""}`}
          onDragOver={(e) => {
            // Fires only for the empty area past the tabs: tabs stopPropagation.
            if (!dragKeyRef.current) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (dragOverKey) setDragOverKey(null);
            if (!dragOverEnd) setDragOverEnd(true);
          }}
          onDrop={(e) => {
            e.preventDefault();
            const src = dragKeyRef.current;
            const lastKey = tabs.length ? tabKey(tabs[tabs.length - 1]) : null;
            if (src && lastKey && src !== lastKey) onReorder(src, lastKey);
            dragKeyRef.current = null;
            setDragKey(null);
            setDragOverKey(null);
            setDragOverEnd(false);
          }}
        >
          {tabs.map((t) => {
            const k = tabKey(t);
            const d = isDirty(k) && t.mode === "edit";
            return (
              <div
                key={k}
                className={`weditor__tab ${k === key ? "is-active" : ""} ${
                  k === dragKey ? "is-dragging" : ""
                } ${k === dragOverKey ? "is-dragover" : ""}`}
                title={t.mode === "diff" ? `${t.path} (diff)` : t.path}
                draggable
                onClick={() => onActivate(k)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, key: k });
                }}
                onDragStart={(e) => {
                  dragKeyRef.current = k;
                  setDragKey(k);
                  e.dataTransfer.effectAllowed = "move";
                  // WebKit/Firefox only fire drop events if drag data is set.
                  e.dataTransfer.setData("text/plain", k);
                }}
                onDragOver={(e) => {
                  const src = dragKeyRef.current;
                  if (!src) return;
                  // Handle here so the container's end-drop zone stays inactive
                  // while pointing at a tab.
                  e.stopPropagation();
                  if (dragOverEnd) setDragOverEnd(false);
                  if (src === k) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverKey !== k) setDragOverKey(k);
                }}
                onDragLeave={() => {
                  if (dragOverKey === k) setDragOverKey(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const src = dragKeyRef.current;
                  if (src && src !== k) onReorder(src, k);
                  dragKeyRef.current = null;
                  setDragKey(null);
                  setDragOverKey(null);
                  setDragOverEnd(false);
                }}
                onDragEnd={() => {
                  dragKeyRef.current = null;
                  setDragKey(null);
                  setDragOverKey(null);
                  setDragOverEnd(false);
                }}
              >
                <span className="weditor__tab-name">
                  {t.mode === "diff" ? "◈ " : ""}
                  {basename(t.path)}
                  {d ? " ●" : ""}
                </span>
                <button
                  className="weditor__tab-close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(k);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {mode === "diff" && (
          <div
            className="weditor__difftoggle"
            role="radiogroup"
            aria-label="Diff layout"
          >
            <button
              role="radio"
              aria-checked={diffLayout === "inline"}
              className={`weditor__difftoggle-opt ${diffLayout === "inline" ? "is-active" : ""}`}
              onClick={() => onDiffLayout("inline")}
            >
              Inline
            </button>
            <button
              role="radio"
              aria-checked={diffLayout === "split"}
              className={`weditor__difftoggle-opt ${diffLayout === "split" ? "is-active" : ""}`}
              onClick={() => onDiffLayout("split")}
            >
              Side-by-side
            </button>
          </div>
        )}
        {mode === "edit" && key && (
          <button
            className="btn weditor__save"
            disabled={!isDirty(key)}
            onClick={() => {
              const view = editors.getView(workspaceId, key);
              if (view) save(key, path!, view);
            }}
          >
            Save
          </button>
        )}
      </div>

      {error && <p className="hint hint--error">{error}</p>}
      {status === "binary" && (
        <p className="hint">This file is binary or too large to display.</p>
      )}
      {/* Editor mounts here; hidden (not unmounted) on binary/error states. */}
      <div
        className="weditor__cm"
        ref={hostRef}
        style={{ display: status === "ready" ? "block" : "none" }}
      />
      {status === "loading" && <p className="hint">Loading…</p>}

      {ctxMenu &&
        (() => {
          const idx = tabs.findIndex((t) => tabKey(t) === ctxMenu.key);
          const isLast = idx === tabs.length - 1;
          const onlyOne = tabs.length <= 1;
          return (
            <ContextMenu
              x={ctxMenu.x}
              y={ctxMenu.y}
              onClose={() => setCtxMenu(null)}
              items={[
                { label: "Close", onClick: () => closeTab(ctxMenu.key) },
                {
                  label: "Close Others",
                  disabled: onlyOne,
                  onClick: () => closeOthers(ctxMenu.key),
                },
                {
                  label: "Close to the Right",
                  disabled: isLast,
                  onClick: () => closeToRight(ctxMenu.key),
                },
                { label: "Close All Tabs", onClick: () => closeAll() },
              ]}
            />
          );
        })()}
    </div>
  );
}
