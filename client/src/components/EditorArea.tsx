import { basicSetup } from "codemirror";
import { StreamLanguage } from "@codemirror/language";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
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
import { gitDiff, readFile, writeFile } from "../net/rest";
import { tabKey, type OpenFile } from "../store/types";

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

/**
 * The right-hand editor pane: a tab bar over the open files plus the active
 * file's CodeMirror. Tree files are editable (Cmd/Ctrl+S saves); diff files are
 * read-only. Each tab's live `EditorView` lives in the `editors` registry so
 * switching tabs — or workspaces — preserves unsaved edits, scroll, and undo.
 */
export function EditorArea({
  workspaceId,
  service,
  cwd,
  tabs,
  activeKey,
  onActivate,
  onClose,
}: {
  workspaceId: string;
  service: { url: string; token: string };
  cwd: string;
  tabs: OpenFile[];
  activeKey?: string;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  // Per-tab dirty flags, mirrored from the registry so the tab bar re-renders.
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

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
    let attached: EditorView | null = null;
    setError(null);

    const attach = (view: EditorView) => {
      host.appendChild(view.dom);
      attached = view;
      requestAnimationFrame(() => {
        view.requestMeasure();
        if (mode === "edit") view.focus();
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

    const buildDiffView = (text: string): EditorView =>
      new EditorView({
        state: EditorState.create({
          doc: text || "(no changes)",
          extensions: [
            basicSetup,
            oneDark,
            StreamLanguage.define(diffMode),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ],
        }),
      });

    const existing = editors.getView(workspaceId, key);
    if (existing) {
      // Tab already built — re-parent its live view, preserving edits/scroll.
      setStatus("ready");
      attach(existing);
    } else {
      setStatus("loading");
      const load = async () => {
        if (mode === "diff") {
          const { diff } = await gitDiff(service, cwd, commit ?? "WORKING", path);
          if (cancelled) return;
          const view = buildDiffView(diff);
          editors.setView(workspaceId, key, view);
          attach(view);
          setStatus("ready");
        } else {
          const fc = await readFile(service, path);
          if (cancelled) return;
          if (fc.truncated) {
            setStatus("binary");
            return;
          }
          const view = buildEditView(fc.content);
          editors.setView(workspaceId, key, view);
          attach(view);
          setStatus("ready");
        }
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
      if (attached && attached.dom.parentElement === host) {
        host.removeChild(attached.dom);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, key, path, mode, commit]);

  const closeTab = (k: string) => {
    editors.disposeTab(workspaceId, k);
    setDirty((m) => {
      const next = { ...m };
      delete next[k];
      return next;
    });
    onClose(k);
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
        <div className="weditor__tabs">
          {tabs.map((t) => {
            const k = tabKey(t);
            const d = isDirty(k) && t.mode === "edit";
            return (
              <div
                key={k}
                className={`weditor__tab ${k === key ? "is-active" : ""}`}
                title={t.mode === "diff" ? `${t.path} (diff)` : t.path}
                onClick={() => onActivate(k)}
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
      {/* CodeMirror mounts here; hidden (not unmounted) on binary/error states. */}
      <div
        className="weditor__cm"
        ref={hostRef}
        style={{ display: status === "ready" ? "block" : "none" }}
      />
      {status === "loading" && <p className="hint">Loading…</p>}
    </div>
  );
}
