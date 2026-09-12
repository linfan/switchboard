import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import * as editors from "../net/editors";
import {
  createEntry,
  deletePath,
  gitChanges,
  gitInfo,
  gitLog,
  listDir,
  renamePath,
} from "../net/rest";
import { formatBytes } from "../net/media";
import {
  cancelTransfer,
  downloadFile,
  uploadFile,
  type TransferHooks,
} from "../net/transfer";
import type {
  FsEntry,
  FsListing,
  GitChange,
  GitCommit,
  GitInfo,
} from "../protocol";
import type { Settings } from "../store/settings";
import { useStore } from "../store/store";
import {
  tabKey,
  WORKING_COMMIT,
  type DiffLayout,
  type Transfer,
  type Workspace,
} from "../store/types";
import { EditorArea } from "./EditorArea";
import { InlineEdit } from "./InlineEdit";
import { ContextMenu, type MenuItem } from "./Menu";

type ServiceRef = { url: string; token: string };

/**
 * Resolve `path` against the tree rooted at `root`, returning the resolved
 * path of every segment (the target last). Listings report canonicalized paths
 * — the same form the tree rows use — so this is how a file path (either
 * client-built from `root`, or already canonical because it came from the
 * tree) is translated into the paths the tree is actually rendered with.
 * Rejects when the path is outside the root or a segment can't be found.
 */
async function resolveTreePath(
  service: ServiceRef,
  root: string,
  path: string,
): Promise<string[]> {
  const rootListing = await listDir(service, root);
  const bases = [
    root.replace(/\/+$/, ""),
    rootListing.path.replace(/\/+$/, ""),
  ];
  const base = bases.find((b) => path.startsWith(`${b}/`));
  if (!base) throw new Error(`outside workspace: ${path}`);
  const parts = path.slice(base.length + 1).split("/");

  const chain: string[] = [];
  let entries = rootListing.entries;
  for (const seg of parts) {
    const entry = entries.find((e) => e.name === seg);
    if (!entry) throw new Error(`not found: ${seg}`);
    chain.push(entry.path);
    // No need to list the target itself (a file — and its row path is just
    // parent + name); intermediate directories must be listed to descend.
    if (chain.length < parts.length) {
      entries = (await listDir(service, entry.path)).entries;
    }
  }
  return chain;
}

/** Right-pane file editor for a selected workspace. */
export function WorkspaceEditor({ workspace }: { workspace: Workspace }) {
  const service = useStore((s) =>
    s.services.find((sv) => sv.id === workspace.serviceId),
  );
  const online = useStore(
    (s) => s.runtime[workspace.serviceId]?.status === "online",
  );
  const editorState = useStore((s) => s.editorState[workspace.id]);
  const patch = useStore((s) => s.patchEditorState);
  const openTab = useStore((s) => s.openTab);
  const closeTab = useStore((s) => s.closeTab);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const moveTab = useStore((s) => s.moveTab);
  const closeOtherTabs = useStore((s) => s.closeOtherTabs);
  const closeTabsToRight = useStore((s) => s.closeTabsToRight);
  const closeAllTabs = useStore((s) => s.closeAllTabs);

  const closeTabsUnder = useStore((s) => s.closeTabsUnder);
  const startTransfer = useStore((s) => s.startTransfer);
  const progressTransfer = useStore((s) => s.progressTransfer);
  const endTransfer = useStore((s) => s.endTransfer);

  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  // Bumped after a filesystem op so open directory listings re-fetch.
  const [refreshKey, setRefreshKey] = useState(0);
  const [fsError, setFsError] = useState<string | null>(null);

  // Width of the left panel column, adjustable by dragging the divider.
  const [panelWidth, setPanelWidth] = useState(280);
  // Header slot the editor's tab actions are portaled into (see EditorArea).
  const [actionsSlot, setActionsSlot] = useState<HTMLDivElement | null>(null);
  // Latest reveal request from the editor toolbar; `seq` makes repeat clicks on
  // the same path distinct so the tree re-scrolls.
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(
    null,
  );
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(
        640,
        Math.max(160, startWidth + ev.clientX - startX),
      );
      setPanelWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    setGit(null);
    setGitError(null);
    gitInfo(service, workspace.cwd)
      .then((info) => !cancelled && setGit(info))
      .catch((e: unknown) => {
        if (!cancelled) setGitError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [service, workspace.cwd, workspace.id]);

  if (!service) {
    return (
      <main className="panel panel--empty">
        <p className="empty">This workspace's service is gone.</p>
      </main>
    );
  }

  const showGit = !!git && git.available && git.is_repo;
  const openTabs = editorState?.openTabs ?? [];
  const activeTab = editorState?.activeTab;
  const active = openTabs.find((t) => tabKey(t) === activeTab);
  const expandedDirs = editorState?.expandedDirs ?? [];
  const selectedCommit = editorState?.selectedCommit;
  const diffLayout: DiffLayout = editorState?.diffLayout ?? "inline";

  const toggleDir = (path: string) => {
    const next = expandedDirs.includes(path)
      ? expandedDirs.filter((p) => p !== path)
      : [...expandedDirs, path];
    patch(workspace.id, { expandedDirs: next });
  };

  // Expand the tree down to `path` and have it scroll the row into view.
  const revealInTree = async (path: string) => {
    const chain = await resolveTreePath(service, workspace.cwd, path).catch(
      () => null,
    );
    if (chain && chain.length > 1) {
      const dirs = chain.slice(0, -1);
      const current =
        useStore.getState().editorState[workspace.id]?.expandedDirs ?? [];
      patch(workspace.id, {
        expandedDirs: [...new Set([...current, ...dirs])],
      });
    }
    setReveal((prev) => ({
      path: chain?.at(-1) ?? path,
      seq: (prev?.seq ?? 0) + 1,
    }));
  };

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // A renamed/deleted path invalidates any tab for it (or, for a folder, its
  // descendants): tear down the live editor views, then drop the tabs.
  const dropTabsUnder = (path: string) => {
    for (const t of openTabs) {
      if (t.path === path || t.path.startsWith(`${path}/`)) {
        editors.disposeTab(workspace.id, tabKey(t));
      }
    }
    closeTabsUnder(workspace.id, path);
  };

  const handleRename = async (entry: FsEntry, newName: string) => {
    setFsError(null);
    try {
      await renamePath(service, entry.path, newName);
      dropTabsUnder(entry.path);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setFsError(errMsg(e));
    }
  };

  const handleDelete = async (entry: FsEntry) => {
    setFsError(null);
    try {
      await deletePath(service, entry.path);
      dropTabsUnder(entry.path);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setFsError(errMsg(e));
    }
  };

  // Feed a transfer's progress into the store so the strip under the tree can
  // follow it; `ended` clears the row however the transfer finished.
  const transferHooks = (
    kind: Transfer["kind"],
  ): TransferHooks & { ended: () => void } => {
    let started: number | null = null;
    return {
      onStart: ({ id, name, total }) => {
        started = id;
        startTransfer({
          id,
          kind,
          workspaceId: workspace.id,
          name,
          total,
          done: 0,
        });
      },
      onProgress: progressTransfer,
      ended: () => started !== null && endTransfer(started),
    };
  };

  const handleDownload = async (entry: FsEntry) => {
    setFsError(null);
    const hooks = transferHooks("download");
    try {
      await downloadFile(service, entry.path, entry.name, hooks);
    } catch (e) {
      setFsError(errMsg(e));
    } finally {
      hooks.ended();
    }
  };

  const handleUpload = async (entry: FsEntry) => {
    setFsError(null);
    const hooks = transferHooks("upload");
    try {
      if (await uploadFile(service, entry.path, hooks)) {
        setRefreshKey((k) => k + 1);
      }
    } catch (e) {
      setFsError(errMsg(e));
    } finally {
      hooks.ended();
    }
  };

  const handleCreate = async (dir: string, name: string, isDir: boolean) => {
    setFsError(null);
    try {
      await createEntry(service, dir, name, isDir);
      setRefreshKey((k) => k + 1);
      // Open a freshly-created file straight away for editing.
      if (!isDir) {
        const path = `${dir.replace(/\/+$/, "")}/${name}`;
        openTab(workspace.id, { path, mode: "edit" });
      }
    } catch (e) {
      setFsError(errMsg(e));
    }
  };

  return (
    <main className="panel weditor">
      <header className="panel__header">
        <span className="panel__title" title={workspace.cwd}>
          {workspace.name}
        </span>
        {showGit && git?.branch && (
          <span className="weditor__branch">⎇ {git.branch}</span>
        )}
        <span className="panel__spacer" />
        {!online && <span className="weditor__offline">offline</span>}
        <div ref={setActionsSlot} className="weditor__actions" />
      </header>

      <div
        className={`weditor__body ${showGit ? "" : "weditor__body--nogit"}`}
        style={{ gridTemplateColumns: `${panelWidth}px 6px 1fr` }}
      >
        <div className="weditor__panels">
          <section className="weditor__panel weditor__panel--tree">
            <div className="weditor__panel-head">Files</div>
            <div className="weditor__panel-body">
              <FileTree
                service={service}
                root={workspace.cwd}
                expanded={expandedDirs}
                activePath={active?.mode === "edit" ? active.path : undefined}
                reveal={reveal}
                refreshKey={refreshKey}
                onToggleDir={toggleDir}
                onOpenFile={(path) =>
                  openTab(workspace.id, { path, mode: "edit" })
                }
                onRename={handleRename}
                onDelete={handleDelete}
                onDownload={handleDownload}
                onUpload={handleUpload}
                onCreate={handleCreate}
              />
            </div>
            <TransferStrip workspaceId={workspace.id} />
          </section>

          {showGit && (
            <section className="weditor__panel weditor__panel--history">
              <div className="weditor__panel-head">History</div>
              <div className="weditor__panel-body">
                <GitHistory
                  service={service}
                  cwd={workspace.cwd}
                  selected={selectedCommit}
                  onSelect={(commit) =>
                    patch(workspace.id, { selectedCommit: commit })
                  }
                />
              </div>
            </section>
          )}

          {showGit && (
            <section className="weditor__panel weditor__panel--changes">
              <div className="weditor__panel-head">Changes</div>
              <div className="weditor__panel-body">
                <ChangedFiles
                  service={service}
                  cwd={workspace.cwd}
                  commit={selectedCommit}
                  activePath={active?.mode === "diff" ? active.path : undefined}
                  onOpenDiff={(path, commit) =>
                    openTab(workspace.id, { path, mode: "diff", commit })
                  }
                  onOpenInEditor={(path) =>
                    openTab(workspace.id, { path, mode: "edit" })
                  }
                />
              </div>
            </section>
          )}
        </div>

        <div
          className="weditor__resizer"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={startDrag}
        />

        <EditorArea
          key={workspace.id}
          workspaceId={workspace.id}
          service={service}
          cwd={workspace.cwd}
          tabs={openTabs}
          activeKey={activeTab}
          diffLayout={diffLayout}
          actionsSlot={actionsSlot}
          onActivate={(k) => setActiveTab(workspace.id, k)}
          onClose={(k) => closeTab(workspace.id, k)}
          onReorder={(from, to) => moveTab(workspace.id, from, to)}
          onCloseOthers={(k) => closeOtherTabs(workspace.id, k)}
          onCloseToRight={(k) => closeTabsToRight(workspace.id, k)}
          onCloseAll={() => closeAllTabs(workspace.id)}
          onDiffLayout={(layout) => patch(workspace.id, { diffLayout: layout })}
          onOpenInEditor={(path) =>
            openTab(workspace.id, { path, mode: "edit" })
          }
          onRevealInTree={revealInTree}
        />
      </div>

      {gitError && <p className="hint hint--error">{gitError}</p>}
      {fsError && <p className="hint hint--error">{fsError}</p>}
    </main>
  );
}

// --- transfers --------------------------------------------------------------

/**
 * Progress for this workspace's in-flight downloads/uploads, pinned below the
 * file tree so it stays visible however far the tree is scrolled. Absent while
 * nothing is transferring.
 */
function TransferStrip({ workspaceId }: { workspaceId: string }) {
  const all = useStore((s) => s.transfers);
  // Filtering inside the selector would return a fresh array on every store
  // change, which zustand treats as a new snapshot.
  const mine = useMemo(
    () => all.filter((t) => t.workspaceId === workspaceId),
    [all, workspaceId],
  );
  if (mine.length === 0) return null;

  return (
    <div className="weditor__transfers">
      {mine.map((t) => {
        // No total yet (headers not in, or none sent): show bytes moved instead
        // of a percentage, and let the bar say "working" rather than "0%".
        const pct =
          t.total && t.total > 0
            ? Math.min(100, Math.floor((t.done / t.total) * 100))
            : null;
        return (
          <div className="weditor__xfer" key={t.id}>
            <span className="weditor__xfer-dir" aria-hidden>
              {t.kind === "download" ? "↓" : "↑"}
            </span>
            <span className="weditor__label" title={t.name}>
              {t.name}
            </span>
            <span
              className={`weditor__xfer-bar ${pct === null ? "is-waiting" : ""}`}
              role="progressbar"
              aria-label={`${t.kind} ${t.name}`}
              aria-valuenow={pct ?? undefined}
            >
              <span style={pct === null ? undefined : { width: `${pct}%` }} />
            </span>
            <span className="weditor__xfer-pct">
              {pct === null ? formatBytes(t.done) : `${pct}%`}
            </span>
            <button
              type="button"
              className="weditor__xfer-cancel"
              aria-label={`Cancel ${t.kind} of ${t.name}`}
              title="Cancel"
              onClick={() => cancelTransfer(t.id)}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

// --- file tree --------------------------------------------------------------

/** Shared handlers/state threaded through the recursive tree nodes. */
interface TreeActions {
  service: ServiceRef;
  expanded: string[];
  activePath?: string;
  /** Path the open context menu acts on, highlighted so the target is obvious. */
  contextPath: string | null;
  refreshKey: number;
  /** Lower-cased name filter; empty string means no filtering. */
  filter: string;
  /**
   * While filtering, the set of directory paths that are ancestors of a match
   * somewhere in their subtree. Such folders are revealed (and force-opened)
   * even when their own name doesn't match, so matching files nested in
   * subfolders become reachable.
   */
  visibleDirs: Set<string>;
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
  /** Path the last reveal landed on, flashed briefly so the jump is visible. */
  revealPath: string | null;
  /** An in-progress "new file/folder" inline input inside directory `dir`. */
  creating: { dir: string; isDir: boolean } | null;
  setCreating: (c: { dir: string; isDir: boolean } | null) => void;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (entry: FsEntry, e: React.MouseEvent) => void;
  onRename: (entry: FsEntry, newName: string) => void;
  onCreate: (dir: string, name: string, isDir: boolean) => void;
}

/** Run `fn`s with at most `max` in flight at once. */
function makeLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/**
 * Walk the tree under `root` and collect the paths of every directory that
 * contains a match (by name) anywhere below it. A match is a file or folder
 * whose name includes `filter`. The returned set holds each matching entry's
 * ancestor directories so the render can reveal the path down to it. Matching
 * folders aren't descended into — the render reveals their whole subtree via
 * `forceShow`.
 *
 * The walk is bounded by the caller's `scan*` settings so a very deep tree or a
 * folder with a huge number of entries can't hang the UI or flood the server
 * with requests.
 */
async function scanMatches(
  service: ServiceRef,
  root: string,
  filter: string,
  cancelled: () => boolean,
  bounds: Settings,
): Promise<Set<string>> {
  const dirs = new Set<string>();
  const listLimited = makeLimiter(bounds.scanMaxConcurrency);
  const deadline = Date.now() + bounds.scanTimeBudgetMs;
  let visited = 0;
  const overBudget = () =>
    cancelled() || visited >= bounds.scanMaxDirs || Date.now() > deadline;

  async function walk(
    dir: string,
    chain: string[],
    depth: number,
  ): Promise<void> {
    if (overBudget()) return;
    visited++;
    let listing: FsListing;
    try {
      listing = await listLimited(() => listDir(service, dir));
    } catch {
      return; // unreadable dir: skip, don't abort the whole scan
    }
    if (cancelled()) return;
    const here = [...chain, dir];
    const childWalks: Promise<void>[] = [];
    for (const e of listing.entries) {
      const matches = e.name.toLowerCase().includes(filter);
      if (matches) for (const p of here) dirs.add(p);
      // Descend into non-matching folders to find deeper matches, but stop
      // queueing work once we hit a bound so we don't build up a huge backlog.
      if (
        e.is_dir &&
        !matches &&
        depth < bounds.scanMaxDepth &&
        !overBudget()
      ) {
        childWalks.push(walk(e.path, here, depth + 1));
      }
    }
    await Promise.all(childWalks);
  }
  await walk(root, [], 0);
  return dirs;
}

function FileTree({
  service,
  root,
  expanded,
  activePath,
  reveal,
  refreshKey,
  onToggleDir,
  onOpenFile,
  onRename,
  onDelete,
  onDownload,
  onUpload,
  onCreate,
}: {
  service: ServiceRef;
  root: string;
  expanded: string[];
  activePath?: string;
  /** A request from the editor toolbar to scroll `path` into view. */
  reveal: { path: string; seq: number } | null;
  refreshKey: number;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onRename: (entry: FsEntry, newName: string) => void;
  onDelete: (entry: FsEntry) => void;
  onDownload: (entry: FsEntry) => void;
  onUpload: (entry: FsEntry) => void;
  onCreate: (dir: string, name: string, isDir: boolean) => void;
}) {
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    entry: FsEntry;
    /** True when opened on the tree background (workspace root, no entry). */
    isRoot?: boolean;
  } | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [visibleDirs, setVisibleDirs] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<{
    dir: string;
    isDir: boolean;
  } | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  // Path the last reveal landed on, flashed briefly so the eye can find it.
  const [flashPath, setFlashPath] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();

  const normFilter = filter.trim().toLowerCase();

  // Recursively scan for matches whenever the filter (or the tree) changes.
  // Debounced so typing doesn't fire a full-tree walk on every keystroke.
  useEffect(() => {
    if (normFilter === "") {
      setVisibleDirs(new Set());
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      // Bounds are read here rather than subscribed to: a scan keeps the limits
      // it started with, and editing them shouldn't restart one mid-flight.
      const bounds = useStore.getState().settings;
      scanMatches(service, root, normFilter, () => cancelled, bounds).then(
        (dirs) => {
          if (!cancelled) setVisibleDirs(dirs);
        },
      );
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [service, root, normFilter, refreshKey]);

  // Reveal request from the editor toolbar: drop any filter that would hide the
  // row, then scroll it into view. Expanded ancestors only render their rows
  // after their listings come back, so retry briefly until the row exists.
  useEffect(() => {
    if (!reveal) return;
    setFilter("");
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const el = treeRef.current?.querySelector<HTMLElement>(
        `[data-path="${CSS.escape(reveal.path)}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: "nearest" });
        el.focus({ preventScroll: true });
        setFlashPath(reveal.path);
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlashPath(null), 1600);
        return;
      }
      if (attempts++ < 60) timer = setTimeout(tick, 50);
    };
    tick();
    return () => clearTimeout(timer);
  }, [reveal]);

  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const actions: TreeActions = {
    service,
    expanded,
    activePath,
    contextPath: ctxMenu && !ctxMenu.isRoot ? ctxMenu.entry.path : null,
    revealPath: flashPath,
    refreshKey,
    filter: normFilter,
    visibleDirs,
    renamingPath,
    setRenamingPath,
    creating,
    setCreating,
    onToggleDir,
    onOpenFile,
    onContextMenu: (entry, e) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, entry });
    },
    onRename: (entry, newName) => {
      setRenamingPath(null);
      onRename(entry, newName);
    },
    onCreate: (dir, name, isDir) => {
      setCreating(null);
      onCreate(dir, name, isDir);
    },
  };

  // Show the inline "new entry" input inside `dir`, expanding it if collapsed.
  const startCreate = (dir: string, isDir: boolean) => {
    if (dir !== root && !expanded.includes(dir)) onToggleDir(dir);
    setCreating({ dir, isDir });
  };

  const menuItems = (entry: FsEntry, isRoot?: boolean): MenuItem[] => {
    const newFile: MenuItem = {
      label: "New file\u2026",
      onClick: () => startCreate(entry.path, false),
    };
    const newFolder: MenuItem = {
      label: "New folder\u2026",
      onClick: () => startCreate(entry.path, true),
    };
    const upload: MenuItem = {
      label: "Upload file\u2026",
      onClick: () => onUpload(entry),
    };
    const copyPath: MenuItem = {
      label: entry.is_dir ? "Copy folder path" : "Copy file path",
      onClick: () => {
        navigator.clipboard.writeText(entry.path).catch(() => {});
      },
    };
    if (isRoot) return [newFile, newFolder, upload, copyPath];
    const rename: MenuItem = {
      label: "Rename",
      onClick: () => setRenamingPath(entry.path),
    };
    const del: MenuItem = {
      label: entry.is_dir ? "Delete folder" : "Delete",
      danger: true,
      confirm: entry.is_dir
        ? "Click again to delete folder"
        : "Click again to delete",
      onClick: () => onDelete(entry),
    };
    return entry.is_dir
      ? [newFile, newFolder, rename, upload, copyPath, del]
      : [
          rename,
          { label: "Download", onClick: () => onDownload(entry) },
          copyPath,
          del,
        ];
  };

  return (
    <div
      ref={treeRef}
      className={`weditor__tree ${ctxMenu?.isRoot ? "is-context" : ""}`}
      onContextMenu={(e) => {
        // Right-click on the tree background targets the workspace root.
        e.preventDefault();
        setCtxMenu({
          x: e.clientX,
          y: e.clientY,
          entry: { name: "", path: root, is_dir: true },
          isRoot: true,
        });
      }}
    >
      <div className="weditor__filter">
        <input
          type="text"
          value={filter}
          placeholder="Filter files…"
          aria-label="Filter files"
          onChange={(e) => setFilter(e.target.value)}
          onContextMenu={(e) => e.stopPropagation()}
        />
        {filter !== "" && (
          <button
            type="button"
            className="weditor__filter-clear"
            aria-label="Clear filter"
            title="Clear filter"
            onClick={() => setFilter("")}
          >
            ×
          </button>
        )}
      </div>
      <DirNode
        service={service}
        path={root}
        depth={0}
        isRoot
        actions={actions}
      />
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={menuItems(ctxMenu.entry, ctxMenu.isRoot)}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function DirNode({
  service,
  path,
  name,
  depth,
  isRoot,
  forceShow,
  actions,
}: {
  service: ServiceRef;
  path: string;
  name?: string;
  depth: number;
  isRoot?: boolean;
  /** True when an ancestor folder matched the filter: show this whole subtree. */
  forceShow?: boolean;
  actions: TreeActions;
}) {
  const filtering = actions.filter !== "";
  // While filtering, force matched subtrees open so their contents are visible
  // even if the user never expanded them (they revert on clearing the filter).
  const open =
    isRoot ||
    actions.expanded.includes(path) ||
    (filtering && (!!forceShow || actions.visibleDirs.has(path)));
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listDir(service, path)
      .then((l) => !cancelled && setListing(l))
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // refreshKey re-lists after a filesystem op (rename/delete/upload).
  }, [open, path, service, actions.refreshKey]);

  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  return (
    <>
      {!isRoot && (
        <div
          role="button"
          tabIndex={0}
          className={`weditor__row weditor__row--dir ${
            actions.contextPath === path ? "is-context" : ""
          }`}
          style={indent}
          title={name}
          onClick={() => {
            if (actions.renamingPath !== path) actions.onToggleDir(path);
          }}
          onContextMenu={(e) =>
            actions.onContextMenu({ name: name ?? "", path, is_dir: true }, e)
          }
        >
          <span className={`weditor__twist ${open ? "is-open" : ""}`}>▸</span>
          <InlineEdit
            className="weditor__label"
            value={name ?? ""}
            ariaLabel="Folder name"
            editing={actions.renamingPath === path}
            onEditingChange={(on) => actions.setRenamingPath(on ? path : null)}
            onCommit={(newName) =>
              actions.onRename(
                { name: name ?? "", path, is_dir: true },
                newName,
              )
            }
          />
        </div>
      )}
      {open && loading && !listing && (
        <div className="weditor__row weditor__row--hint" style={indent}>
          loading…
        </div>
      )}
      {open && error && (
        <div className="weditor__row weditor__row--hint" style={indent}>
          {error}
        </div>
      )}
      {open && actions.creating?.dir === path && (
        <div
          className="weditor__row weditor__row--new"
          style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
        >
          <InlineEdit
            className="weditor__label"
            value=""
            ariaLabel={
              actions.creating.isDir ? "New folder name" : "New file name"
            }
            placeholder={
              actions.creating.isDir ? "folder name\u2026" : "file name\u2026"
            }
            editing
            onEditingChange={(on) => {
              if (!on) actions.setCreating(null);
            }}
            onCommit={(newName) =>
              actions.onCreate(path, newName, actions.creating?.isDir ?? false)
            }
          />
        </div>
      )}
      {open &&
        listing?.entries.map((e) => {
          // Filter rule: keep a matching name; a matched folder keeps all of
          // its content (forceShow cascades down); a non-matching folder is
          // kept when it holds a match deeper in its subtree (visibleDirs);
          // everything else is hidden.
          const matches = e.name.toLowerCase().includes(actions.filter);
          const revealDir = e.is_dir && actions.visibleDirs.has(e.path);
          if (filtering && !forceShow && !matches && !revealDir) return null;
          const childForceShow = forceShow || (filtering && matches);
          return e.is_dir ? (
            <DirNode
              key={e.path}
              service={service}
              path={e.path}
              name={e.name}
              depth={depth + 1}
              forceShow={childForceShow}
              actions={actions}
            />
          ) : (
            <div
              key={e.path}
              role="button"
              tabIndex={0}
              data-path={e.path}
              className={`weditor__row weditor__row--file ${
                actions.activePath === e.path ? "is-active" : ""
              } ${actions.contextPath === e.path ? "is-context" : ""} ${
                actions.revealPath === e.path ? "is-reveal" : ""
              }`}
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
              title={e.name}
              onClick={() => {
                if (actions.renamingPath !== e.path) actions.onOpenFile(e.path);
              }}
              onContextMenu={(ev) => actions.onContextMenu(e, ev)}
            >
              <InlineEdit
                className="weditor__label"
                value={e.name}
                ariaLabel="File name"
                editing={actions.renamingPath === e.path}
                onEditingChange={(on) =>
                  actions.setRenamingPath(on ? e.path : null)
                }
                onCommit={(newName) => actions.onRename(e, newName)}
              />
            </div>
          );
        })}
    </>
  );
}

// --- git history ------------------------------------------------------------

function GitHistory({
  service,
  cwd,
  selected,
  onSelect,
}: {
  service: ServiceRef;
  cwd: string;
  selected?: string;
  onSelect: (commit: string) => void;
}) {
  const [commits, setCommits] = useState<GitCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    commit: GitCommit;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCommits(null);
    setError(null);
    gitLog(service, cwd)
      .then((c) => !cancelled && setCommits(c))
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [service, cwd]);

  return (
    <>
      <button
        className={`weditor__row weditor__commit ${
          selected === WORKING_COMMIT ? "is-active" : ""
        }`}
        onClick={() => onSelect(WORKING_COMMIT)}
      >
        <span className="weditor__label">● Uncommitted changes</span>
      </button>
      {error && <div className="weditor__row weditor__row--hint">{error}</div>}
      {!commits && !error && (
        <div className="weditor__row weditor__row--hint">loading…</div>
      )}
      {commits?.map((c) => (
        <button
          key={c.hash}
          className={`weditor__row weditor__commit ${
            selected === c.hash ? "is-active" : ""
          }`}
          title={`${c.subject}${
            c.body
              ? `

${c.body}`
              : ""
          }

${c.short} · ${c.author} · ${c.date}`}
          onClick={() => onSelect(c.hash)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setCtxMenu({ x: e.clientX, y: e.clientY, commit: c });
          }}
        >
          <span className="weditor__label">{c.subject}</span>
          <span className="weditor__commit-meta">{c.short}</span>
        </button>
      ))}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            {
              label: "Copy commit ID",
              onClick: () => {
                navigator.clipboard.writeText(ctxMenu.commit.hash).catch(() => {});
              },
            },
            {
              label: "Copy message",
              onClick: () => {
                navigator.clipboard.writeText(ctxMenu.commit.subject).catch(() => {});
              },
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}

// --- changed files ----------------------------------------------------------

function ChangedFiles({
  service,
  cwd,
  commit,
  activePath,
  onOpenDiff,
  onOpenInEditor,
}: {
  service: ServiceRef;
  cwd: string;
  commit?: string;
  activePath?: string;
  onOpenDiff: (path: string, commit: string) => void;
  /** Open the given absolute path as an editable tab. */
  onOpenInEditor: (absPath: string) => void;
}) {
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed directory paths (default: everything expanded).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    change: GitChange;
  } | null>(null);

  // Git reports changed-file paths relative to the repo root; tabs use absolute.
  const absPath = (p: string) => `${cwd.replace(/\/+$/, "")}/${p}`;

  useEffect(() => {
    if (!commit) {
      setChanges(null);
      return;
    }
    let cancelled = false;
    setChanges(null);
    setError(null);
    gitChanges(service, cwd, commit)
      .then((c) => !cancelled && setChanges(c))
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [service, cwd, commit]);

  const tree = useMemo(() => buildChangeTree(changes ?? []), [changes]);

  const toggle = (dirPath: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });

  if (!commit) {
    return (
      <div className="weditor__row weditor__row--hint">
        Select a commit to see changed files.
      </div>
    );
  }

  return (
    <>
      {error && <div className="weditor__row weditor__row--hint">{error}</div>}
      {!changes && !error && (
        <div className="weditor__row weditor__row--hint">loading…</div>
      )}
      {changes?.length === 0 && (
        <div className="weditor__row weditor__row--hint">No changes.</div>
      )}
      {changes && changes.length > 0 && (
        <ChangeTree
          node={tree}
          prefix=""
          depth={0}
          commit={commit}
          collapsed={collapsed}
          activePath={activePath}
          onToggle={toggle}
          onOpenDiff={onOpenDiff}
          onFileContextMenu={(change, e) =>
            setCtxMenu({ x: e.clientX, y: e.clientY, change })
          }
        />
      )}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={[
            {
              label: "Copy file path",
              onClick: () => {
                navigator.clipboard
                  .writeText(absPath(ctxMenu.change.path))
                  .catch(() => {});
              },
            },
            {
              label: "Open in editor",
              onClick: () => onOpenInEditor(absPath(ctxMenu.change.path)),
            },
          ]}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}

// --- changed-files tree -----------------------------------------------------

/** A directory in the changed-files tree: subdirectories plus files directly in it. */
interface ChangeTreeNode {
  dirs: Map<string, ChangeTreeNode>;
  files: GitChange[];
}

/** Group a flat list of changed files into a nested directory tree by path. */
function buildChangeTree(changes: GitChange[]): ChangeTreeNode {
  const root: ChangeTreeNode = { dirs: new Map(), files: [] };
  for (const change of changes) {
    const parts = change.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = node.dirs.get(seg);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(seg, child);
      }
      node = child;
    }
    node.files.push(change);
  }
  return root;
}

/** Recursively render a changed-files directory node: folders first, then files. */
function ChangeTree({
  node,
  prefix,
  depth,
  commit,
  collapsed,
  activePath,
  onToggle,
  onOpenDiff,
  onFileContextMenu,
}: {
  node: ChangeTreeNode;
  prefix: string;
  depth: number;
  commit: string;
  collapsed: Set<string>;
  activePath?: string;
  onToggle: (dirPath: string) => void;
  onOpenDiff: (path: string, commit: string) => void;
  onFileContextMenu: (change: GitChange, e: React.MouseEvent) => void;
}) {
  const indent = { paddingLeft: `${depth * 12 + 8}px` };
  const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
  const files = [...node.files].sort((a, b) =>
    (a.path.split("/").pop() ?? "").localeCompare(
      b.path.split("/").pop() ?? "",
    ),
  );

  return (
    <>
      {dirNames.map((name) => {
        const dirPath = prefix ? `${prefix}/${name}` : name;
        const open = !collapsed.has(dirPath);
        return (
          <Fragment key={dirPath}>
            <button
              className="weditor__row weditor__row--dir"
              style={indent}
              title={name}
              onClick={() => onToggle(dirPath)}
            >
              <span className={`weditor__twist ${open ? "is-open" : ""}`}>
                ▸
              </span>
              <span className="weditor__label">{name}</span>
            </button>
            {open && (
              <ChangeTree
                node={node.dirs.get(name)!}
                prefix={dirPath}
                depth={depth + 1}
                commit={commit}
                collapsed={collapsed}
                activePath={activePath}
                onToggle={onToggle}
                onOpenDiff={onOpenDiff}
                onFileContextMenu={onFileContextMenu}
              />
            )}
          </Fragment>
        );
      })}
      {files.map((c) => (
        <button
          key={c.path}
          className={`weditor__row weditor__row--file ${
            activePath === c.path ? "is-active" : ""
          }`}
          style={indent}
          title={c.path}
          onClick={() => onOpenDiff(c.path, commit)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onFileContextMenu(c, e);
          }}
        >
          <span
            className={`weditor__status weditor__status--${c.status[0] ?? ""}`}
          >
            {c.status}
          </span>
          <span className="weditor__label">{c.path.split("/").pop()}</span>
        </button>
      ))}
    </>
  );
}
