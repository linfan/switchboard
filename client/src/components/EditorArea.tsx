import { basicSetup } from "codemirror";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import DOMPurify from "dompurify";
import { marked } from "marked";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";

import * as editors from "../net/editors";
import { formatBytes, mediaForPath, type MediaKind } from "../net/media";
import { gitFileDiff, readFile, statPath, writeFile } from "../net/rest";
import { openPreview, type Preview } from "../net/transfer";
import { useStore } from "../store/store";
import { tabKey, type DiffLayout, type OpenFile } from "../store/types";
import { ContextMenu } from "./Menu";

const PREVIEW_CAP_KEY = {
  image: "previewMaxImageBytes",
  audio: "previewMaxAudioBytes",
  video: "previewMaxVideoBytes",
} as const;

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

/** True for files the editor offers a rendered-markdown view for. */
function isMarkdownPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext === "md" || ext === "markdown";
}

/**
 * Resolve a relative markdown link/image target against the referencing file's
 * own path (absolute, or relative to the workspace cwd), tolerating `.`/`..`
 * segments. An absolute base keeps its leading `/` (the empty first segment).
 */
function resolveRelative(basePath: string, rel: string): string {
  const stack = basePath.split("/");
  stack.pop(); // the referencing file's own name
  const absolute = stack[0] === "";
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    // Never let ".." climb above the filesystem root (or the cwd).
    if (part === "..") {
      if (stack.length > (absolute ? 1 : 0)) stack.pop();
    } else stack.push(part);
  }
  return stack.join("/");
}

/** Decode a percent-encoded markdown target, keeping the raw form if malformed. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Base name of a path, for tab labels. */
function basename(path: string): string {
  return path.split("/").pop() || path;
}

type Status = "loading" | "ready" | "binary" | "oversize" | "error";

/** A built diff view (inline `EditorView` or split `MergeView`), normalized. */
interface BuiltDiff {
  dom: HTMLElement;
  destroy: () => void;
  measure: () => void;
  views: EditorView[];
}

/** The element that previews each media kind, with controls where they apply. */
function mediaElement(kind: MediaKind, src: string): HTMLElement {
  if (kind === "image") {
    const img = document.createElement("img");
    img.className = "weditor__media";
    img.src = src;
    return img;
  }
  const el = document.createElement(kind === "audio" ? "audio" : "video");
  el.className = "weditor__media";
  el.controls = true;
  el.src = src;
  return el;
}

/**
 * The right-hand editor pane: a tab bar over the open files plus the active
 * file's editor. Tree files are editable (Cmd/Ctrl+S saves). Diff files are
 * read-only and rendered with a real diff editor — inline (unified) or
 * side-by-side, switchable via the title-bar toggle. Markdown files render as
 * a sanitized HTML document (headings, tables, relative images fetched through
 * the authenticated preview path), with the raw source one toggle away. Each
 * tab's live view lives in
 * the `editors` registry so switching tabs — or workspaces — preserves unsaved
 * edits, scroll, and undo. Long lines wrap or scroll sideways per tab, chosen by
 * the Auto-wrap/No-wrap toggle and seeded from the settings default at build
 * time.
 */
export function EditorArea({
  workspaceId,
  service,
  cwd,
  tabs,
  activeKey,
  diffLayout,
  actionsSlot,
  onActivate,
  onClose,
  onReorder,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onDiffLayout,
  onOpenInEditor,
}: {
  workspaceId: string;
  service: { url: string; token: string };
  cwd: string;
  tabs: OpenFile[];
  activeKey?: string;
  diffLayout: DiffLayout;
  /** Header element (in WorkspaceEditor's title bar) the tab actions render into. */
  actionsSlot: HTMLElement | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onReorder: (fromKey: string, toKey: string) => void;
  onCloseOthers: (key: string) => void;
  onCloseToRight: (key: string) => void;
  onCloseAll: () => void;
  onDiffLayout: (layout: DiffLayout) => void;
  /** Open the given absolute path as an editable tab (from the diff view). */
  onOpenInEditor: (absPath: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  // Why a media file wasn't previewed (status `oversize`).
  const [oversizeNote, setOversizeNote] = useState<string | null>(null);
  // Per-tab dirty flags, mirrored from the registry so the tab bar re-renders.
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  // Per-tab "changed on disk" flags, mirrored from the registry so the notice
  // banner re-renders. The registry copy survives workspace switches.
  const [changed, setChanged] = useState<Record<string, boolean>>({});
  // Per-tab wrap choices, mirrored from the registry for the same reason.
  const [wraps, setWraps] = useState<Record<string, boolean>>({});
  // Per-tab markdown rendered-vs-source choices, mirrored the same way.
  const [mdPrev, setMdPrev] = useState<Record<string, boolean>>({});
  // The active tab's rendered HTML, or null while no preview is on screen.
  // `for` keys it to the tab so a switch never paints the previous tab's body.
  const [mdHtml, setMdHtml] = useState<{ for: string; html: string } | null>(
    null,
  );
  // The rendered pane's host, for post-processing (image srcs, link targets).
  const mdHostRef = useRef<HTMLDivElement>(null);
  // Image previews behind the current rendered pane, by target path. A tab
  // switch re-mounts the HTML with its original relative srcs, so resolved
  // URLs are re-applied from here instead of refetching every image.
  const mdImagesRef = useRef<Map<string, Preview>>(new Map());
  // The document the image cache was built for, to refresh it when the same
  // tab's buffer changes (an edit followed by a re-render, or a disk reload).
  const mdDocRef = useRef<{ for: string; html: string } | null>(null);
  // Fallback for a tab with no choice of its own yet — its view isn't built.
  const defaultWrap = useStore((s) => s.editorWrapDefault);
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
  // Image/audio/video tree files preview instead of loading into CodeMirror.
  const media = mode === "edit" && path ? mediaForPath(path) : null;
  // Markdown tree files render as a document, with the raw source one toggle away.
  const isMd = mode === "edit" && !!path && isMarkdownPath(path);
  const mdRendered = (k: string) =>
    mdPrev[k] ?? editors.getMdPreview(workspaceId, k) ?? true;
  // The active markdown tab is currently showing its rendered pane.
  const showPreview = !!key && isMd && mdRendered(key);

  const markDirty = (k: string, d: boolean) => {
    editors.setDirty(workspaceId, k, d);
    setDirty((m) => ({ ...m, [k]: d }));
  };

  const markChanged = (k: string, c: boolean) => {
    setChanged((m) => ({ ...m, [k]: c }));
  };

  /** Render a markdown tab's live buffer into sanitized HTML for the preview. */
  const renderMarkdownDoc = (k: string, view: EditorView) => {
    // Sanitized because a file (say, a cloned repo's README) can carry raw
    // HTML: it must never execute in the app's origin, which holds tokens.
    const html = DOMPurify.sanitize(
      marked.parse(view.state.doc.toString()) as string,
    );
    setMdHtml({ for: k, html });
  };

  const save = (k: string, filePath: string, view: EditorView): boolean => {
    // Suppress the staleness poll while our own write is in flight so its new
    // mtime isn't misread as an out-of-app change.
    editors.setSaving(workspaceId, k, true);
    writeFile(service, filePath, view.state.doc.toString())
      .then(({ mtime }) => {
        editors.setMtime(workspaceId, k, mtime);
        // Saving overwrites any pending disk-side change: the user kept theirs.
        editors.clearDiskChange(workspaceId, k, false);
        markDirty(k, false);
        markChanged(k, false);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => editors.setSaving(workspaceId, k, false));
    return true;
  };

  /** Replace the buffer with the current on-disk contents (notice "Reload"). */
  const reloadFromDisk = (k: string, filePath: string) => {
    readFile(service, filePath)
      .then((fc) => {
        const view = editors.getView(workspaceId, k);
        if (!view) return; // tab closed while the read was in flight
        if (fc.truncated) {
          setError("File on disk is now binary or too large to reload.");
          return;
        }
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: fc.content },
        });
        editors.setMtime(workspaceId, k, fc.mtime);
        editors.clearDiskChange(workspaceId, k, false);
        markDirty(k, false);
        markChanged(k, false);
        // The rendered pane (if up) must not keep showing the pre-reload body.
        if (mdRendered(k)) renderMarkdownDoc(k, view);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : String(e)),
      );
  };

  /** Dismiss the notice, keeping the buffer (notice "Keep editing"). */
  const keepBuffer = (k: string) => {
    // Adopt the observed disk mtime so the notice only returns if the file
    // changes on disk again.
    editors.clearDiskChange(workspaceId, k, true);
    markChanged(k, false);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !path || !mode || !key) return;

    let cancelled = false;
    let attachedDom: HTMLElement | null = null;
    setError(null);
    setOversizeNote(null);

    const attach = (
      dom: HTMLElement,
      measure?: () => void,
      focus?: EditorView,
    ) => {
      host.appendChild(dom);
      attachedDom = dom;
      requestAnimationFrame(() => {
        if (cancelled) return;
        measure?.();
        if (mode === "edit") focus?.focus();
        // After focus(), which scrolls the caret into view and would otherwise
        // override the position the tab was left at.
        editors.restoreScroll(workspaceId, key);
      });
    };

    /**
     * This tab's wrap choice, seeded from the global default the first time its
     * view is built and recorded so the tab keeps that value from then on. The
     * default is read through `getState` rather than subscribed to, keeping it
     * out of this effect's deps: a new default belongs to views built after it,
     * and must not tear down (or silently re-wrap) the ones on screen.
     */
    const wrapForTab = (): boolean => {
      const own = editors.getWrap(workspaceId, key);
      if (own !== undefined) return own;
      const seeded = useStore.getState().editorWrapDefault;
      editors.setWrap(workspaceId, key, seeded);
      return seeded;
    };

    const buildEditView = (content: string, wrap: boolean): EditorView =>
      new EditorView({
        state: EditorState.create({
          doc: content,
          extensions: [
            basicSetup,
            oneDark,
            langForPath(path),
            editors.wrapExtension(wrap),
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
      wrap: boolean,
    ): BuiltDiff => {
      const readOnly = [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ];
      const lang = langForPath(path);
      const collapseUnchanged = { margin: 3, minSize: 4 };

      if (layout === "split") {
        const mv = new MergeView({
          a: {
            doc: oldText,
            extensions: [
              basicSetup,
              oneDark,
              lang,
              editors.wrapExtension(wrap),
              ...readOnly,
            ],
          },
          b: {
            doc: newText,
            extensions: [
              basicSetup,
              oneDark,
              lang,
              editors.wrapExtension(wrap),
              ...readOnly,
            ],
          },
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
          views: [mv.a, mv.b],
        };
      }

      const view = new EditorView({
        state: EditorState.create({
          doc: newText,
          extensions: [
            basicSetup,
            oneDark,
            lang,
            editors.wrapExtension(wrap),
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
        views: [view],
      };
    };

    const registerDiff = (
      built: BuiltDiff,
      diff: { oldText: string; newText: string },
    ) => {
      editors.setDiffView(workspaceId, key, {
        dom: built.dom,
        destroy: built.destroy,
        measure: built.measure,
        views: built.views,
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
        // Layout toggled — rebuild from the cached sides (no refetch). Disposing
        // the view forgets the tab's wrap choice, so hold it across the rebuild.
        const { oldText, newText } = existing.diff;
        const wrap = wrapForTab();
        editors.disposeTab(workspaceId, key);
        editors.setWrap(workspaceId, key, wrap);
        const built = buildDiffView(oldText, newText, diffLayout, wrap);
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
          const built = buildDiffView(
            diff.oldText,
            diff.newText,
            diffLayout,
            wrapForTab(),
          );
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
    } else if (media) {
      if (existing) {
        // Already fetched — re-parent the live element, so playback continues
        // from where it was and the cached bytes aren't downloaded twice.
        setStatus("ready");
        attach(existing.dom);
      } else {
        setStatus("loading");
        const load = async () => {
          // Stat first: an oversize file is never transferred at all.
          const st = await statPath(service, path);
          if (cancelled) return;
          // Read the cap at open time instead of subscribing: keeping it out of
          // this effect's deps avoids tearing down live CodeMirror views when an
          // unrelated setting changes. Raising the cap therefore applies to the
          // next open of an oversize tab, not retroactively to this one.
          const cap = useStore.getState().settings[PREVIEW_CAP_KEY[media.kind]];
          if (st.size > cap) {
            setOversizeNote(
              `This ${media.kind} is ${formatBytes(st.size)} — too large to preview (limit ${formatBytes(cap)}).`,
            );
            setStatus("oversize");
            return;
          }
          const preview = await openPreview(service, path, media.ext, st.mtime);
          if (cancelled) {
            preview.release(); // tab closed mid-fetch: don't leak the cache file
            return;
          }
          const wrap = document.createElement("div");
          wrap.className = "weditor__mediawrap";
          const el = mediaElement(media.kind, preview.url);
          wrap.appendChild(el);
          editors.setMediaView(workspaceId, key, {
            dom: wrap,
            destroy: () => {
              // Drop the source before releasing it, so nothing is still
              // streaming from the file we're about to delete.
              el.removeAttribute("src");
              if (el instanceof HTMLMediaElement) el.load();
              preview.release();
            },
          });
          attach(wrap);
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
        const view = buildEditView(fc.content, wrapForTab());
        editors.setView(workspaceId, key, view, fc.mtime);
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
        editors.saveScroll(workspaceId, key);
        host.removeChild(attachedDom);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, key, path, mode, commit, diffLayout]);

  // Markdown preview: whenever the rendered pane is (or becomes) the thing on
  // screen, render the active tab's buffer into HTML. Reads the live view's
  // doc, so unsaved edits show too; while the pane is up the buffer can only
  // change through a disk reload, which re-renders explicitly. A layout effect
  // so a tab switch fills the new tab's HTML in before the browser paints,
  // never flashing the previous tab's body.
  useLayoutEffect(() => {
    if (!key || !showPreview || status !== "ready") {
      setMdHtml(null);
      return;
    }
    const view = editors.getView(workspaceId, key);
    if (view) renderMarkdownDoc(key, view);
  }, [workspaceId, key, showPreview, status]);

  // Post-process the rendered pane: give headings ids so `[x](#x)` TOC links
  // resolve, open links outside the app, and point relative image srcs at
  // authenticated previews. `<img src>` can't reach /api itself — every REST
  // request carries per-request MAC headers, nothing a plain URL could hold —
  // so each relative image is fetched like a media preview and its blob/asset
  // URL swapped in. Runs on every (re)mount of the pane: toggling or switching
  // tabs re-creates the DOM from the original HTML, with relative srcs back.
  useEffect(() => {
    const host = mdHostRef.current;
    if (!host || !mdHtml || !path) return;

    host.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
      if (h.id) return;
      const slug =
        h.textContent
          ?.trim()
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s-]/gu, "")
          .replace(/\s+/g, "-") ?? "";
      if (slug) h.id = slug;
    });
    host.querySelectorAll("a").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });

    // A different document in the same tab means its images may have changed
    // with it; a different tab keeps both tabs' images cached for switch-back.
    const prevDoc = mdDocRef.current;
    mdDocRef.current = { for: mdHtml.for, html: mdHtml.html };
    if (prevDoc && prevDoc.for === mdHtml.for && prevDoc.html !== mdHtml.html) {
      mdImagesRef.current.forEach((p) => p.release());
      mdImagesRef.current.clear();
    }

    let cancelled = false;
    const cache = mdImagesRef.current;
    for (const img of Array.from(host.querySelectorAll("img"))) {
      const raw = img.getAttribute("src") ?? "";
      const clean = raw.split("#")[0].split("?")[0];
      // Absolute URLs (badges, hotlinked screenshots) load directly; only
      // workspace-relative srcs need the authenticated hop.
      if (
        !clean ||
        /^[a-z][a-z0-9+.-]*:/i.test(clean) ||
        clean.startsWith("//")
      )
        continue;
      const target = resolveRelative(path, safeDecode(clean));
      if (!target) continue;
      const cached = cache.get(target);
      if (cached) {
        img.src = cached.url;
        continue;
      }
      statPath(service, target)
        .then((st) => {
          if (cancelled || !st.exists || st.is_dir) return null;
          const ext = target.split(".").pop()?.toLowerCase() ?? "";
          return openPreview(service, target, ext, st.mtime);
        })
        .then((preview) => {
          if (!preview) return;
          if (cancelled) {
            preview.release(); // pane went away mid-fetch: don't leak it
            return;
          }
          cache.set(target, preview);
          if (img.isConnected) img.src = preview.url;
        })
        .catch(() => {
          // Missing or undecodable image: leave the alt text where it is.
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mdHtml]);

  // Release every fetched image preview when the workspace pane goes away.
  useEffect(
    () => () => {
      mdImagesRef.current.forEach((p) => p.release());
      mdImagesRef.current.clear();
    },
    [],
  );

  // Watch the ACTIVE edit tab for out-of-app changes: an immediate stat on
  // activation (so a change made while the tab was backgrounded surfaces the
  // moment you switch back), a slow poll while it stays active, and a re-check
  // on window focus (when outside edits most likely happened). The interval is
  // cleared on tab switch/close/unmount, so no polling ever outlives an open
  // file; a stat resolving after close finds no registry entry and is dropped.
  // Media previews are snapshots of the bytes at open time, so they aren't polled.
  useEffect(() => {
    if (!key || !path || mode !== "edit" || media || status !== "ready") return;

    let cancelled = false;
    let inFlight = false;

    const check = async () => {
      if (cancelled || inFlight || document.hidden) return;
      // Nothing to do while a save is in flight or a notice is already shown.
      if (
        editors.isSaving(workspaceId, key) ||
        editors.isChangedOnDisk(workspaceId, key)
      )
        return;
      inFlight = true;
      try {
        const st = await statPath(service, path);
        if (cancelled) return;
        const entry = editors.getEntry(workspaceId, key);
        // Tab closed / workspace gone / save started meanwhile: drop the result.
        if (!entry?.editor || entry.saving) return;
        if (
          st.exists &&
          entry.mtime !== undefined &&
          st.mtime !== entry.mtime
        ) {
          editors.flagDiskChange(workspaceId, key, st.mtime);
          markChanged(key, true);
        }
      } catch {
        // Transient stat/network failure — try again on the next tick.
      } finally {
        inFlight = false;
      }
    };

    void check();
    const timer = setInterval(() => void check(), 3000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, key, path, mode, status]);

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
    setChanged((m) => {
      const next = { ...m };
      keys.forEach((k) => delete next[k]);
      return next;
    });
    setWraps((m) => {
      const next = { ...m };
      keys.forEach((k) => delete next[k]);
      return next;
    });
    setMdPrev((m) => {
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
  const isChanged = (k: string) =>
    changed[k] ?? editors.isChangedOnDisk(workspaceId, k);
  const isWrapped = (k: string) =>
    wraps[k] ?? editors.getWrap(workspaceId, k) ?? defaultWrap;

  /** Flip this tab between wrapped lines and horizontal scrolling. */
  const toggleWrap = (k: string) => {
    const next = !isWrapped(k);
    // The registry reconfigures the live view(s) in place — no rebuild, so the
    // tab keeps its edits, scroll position, and undo history.
    editors.setWrap(workspaceId, k, next);
    setWraps((m) => ({ ...m, [k]: next }));
  };

  /** Flip this markdown tab between its rendered pane and the raw source. */
  const toggleMdPreview = (k: string, rendered: boolean) => {
    // A recorded choice only — the buffer view stays alive behind the pane,
    // so switching back restores edits, scroll, and undo untouched.
    editors.setMdPreview(workspaceId, k, rendered);
    setMdPrev((m) => ({ ...m, [k]: rendered }));
  };

  /**
   * Route a plain click inside the rendered pane. Nothing here may navigate
   * the app itself: external links open a new window, `#anchor` links scroll
   * the preview (marked emits no heading ids; the post-processing adds them),
   * and workspace-relative links open as an editor tab.
   */
  const onMdPaneClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    const a = (e.target as HTMLElement).closest("a");
    if (!a || !path) return;
    const href = a.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href) || href.startsWith("//")) {
      e.preventDefault();
      window.open(href, "_blank", "noopener");
      return;
    }
    if (href.startsWith("#")) {
      e.preventDefault();
      document.getElementById(href.slice(1))?.scrollIntoView();
      return;
    }
    e.preventDefault();
    const clean = href.split("#")[0].split("?")[0];
    if (!clean) return;
    const target = resolveRelative(path, safeDecode(clean));
    if (!target) return;
    // Tree paths are absolute; a relative resolution needs the cwd in front.
    onOpenInEditor(
      target.startsWith("/") ? target : `${cwd.replace(/\/+$/, "")}/${target}`,
    );
  };

  const wrapped = !!key && isWrapped(key);

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
        {/* Tab actions live in the workspace title bar (portal), not beside the
            tabs, so they never compete with tabs for width. */}
        {actionsSlot &&
          createPortal(
            <>
              {key && isMd && (
                <div
                  className="weditor__seg"
                  role="radiogroup"
                  aria-label="Markdown view"
                >
                  <button
                    role="radio"
                    aria-checked={showPreview}
                    className={`weditor__seg-opt ${showPreview ? "is-active" : ""}`}
                    title="Show the rendered document"
                    onClick={() => {
                      if (!showPreview) toggleMdPreview(key, true);
                    }}
                  >
                    Preview
                  </button>
                  <button
                    role="radio"
                    aria-checked={!showPreview}
                    className={`weditor__seg-opt ${!showPreview ? "is-active" : ""}`}
                    title="Show the raw markdown source"
                    onClick={() => {
                      if (showPreview) toggleMdPreview(key, false);
                    }}
                  >
                    Source
                  </button>
                </div>
              )}
              {key && !media && !showPreview && (
                <div
                  className="weditor__wrap weditor__seg"
                  role="radiogroup"
                  aria-label="Line wrapping"
                >
                  <button
                    role="radio"
                    aria-checked={wrapped}
                    className={`weditor__seg-opt ${wrapped ? "is-active" : ""}`}
                    title="Wrap long lines to the editor width"
                    onClick={() => {
                      if (!wrapped) toggleWrap(key);
                    }}
                  >
                    Auto-wrap
                  </button>
                  <button
                    role="radio"
                    aria-checked={!wrapped}
                    className={`weditor__seg-opt ${!wrapped ? "is-active" : ""}`}
                    title="Keep long lines on one row and scroll sideways"
                    onClick={() => {
                      if (wrapped) toggleWrap(key);
                    }}
                  >
                    No-wrap
                  </button>
                </div>
              )}
              {mode === "diff" && (
                <div
                  className="weditor__seg"
                  role="radiogroup"
                  aria-label="Diff layout"
                >
                  <button
                    role="radio"
                    aria-checked={diffLayout === "inline"}
                    className={`weditor__seg-opt ${diffLayout === "inline" ? "is-active" : ""}`}
                    onClick={() => onDiffLayout("inline")}
                  >
                    Inline
                  </button>
                  <button
                    role="radio"
                    aria-checked={diffLayout === "split"}
                    className={`weditor__seg-opt ${diffLayout === "split" ? "is-active" : ""}`}
                    onClick={() => onDiffLayout("split")}
                  >
                    Side-by-side
                  </button>
                </div>
              )}
              {mode === "diff" && path && (
                <button
                  className="btn weditor__openeditor"
                  title="Open this file for editing in a new tab"
                  onClick={() =>
                    onOpenInEditor(`${cwd.replace(/\/+$/, "")}/${path}`)
                  }
                >
                  Open in editor
                </button>
              )}
              {mode === "edit" && key && !media && (
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
            </>,
            actionsSlot,
          )}
      </div>

      {mode === "edit" && key && isChanged(key) && (
        <div className="weditor__notice" role="alert">
          <span className="weditor__notice-text">
            This file changed on disk
            {isDirty(key)
              ? " — reloading will discard your unsaved edits."
              : "."}
          </span>
          <button
            className="btn weditor__notice-btn"
            onClick={() => reloadFromDisk(key, path!)}
          >
            Reload
          </button>
          <button
            className="btn weditor__notice-btn"
            onClick={() => keepBuffer(key)}
          >
            Keep editing
          </button>
        </div>
      )}
      {error && <p className="hint hint--error">{error}</p>}
      {status === "binary" && (
        <p className="hint">This file is binary or too large to display.</p>
      )}
      {status === "oversize" && oversizeNote && (
        <p className="hint">{oversizeNote}</p>
      )}
      {/* Editor mounts here; hidden (not unmounted) on binary/error states —
          and while a markdown tab shows its rendered pane instead. */}
      <div
        className="weditor__cm"
        ref={hostRef}
        style={{
          display: status === "ready" && !showPreview ? "block" : "none",
        }}
      />
      {showPreview && mdHtml?.for === key && (
        <div
          ref={mdHostRef}
          className="weditor__md"
          onClick={onMdPaneClick}
          dangerouslySetInnerHTML={{ __html: mdHtml.html }}
        />
      )}
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
