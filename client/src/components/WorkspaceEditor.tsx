import { Fragment, useEffect, useMemo, useState } from "react";

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
import { downloadFile, uploadFile } from "../net/transfer";
import type {
  FsEntry,
  FsListing,
  GitChange,
  GitCommit,
  GitInfo,
} from "../protocol";
import { useStore } from "../store/store";
import {
  tabKey,
  WORKING_COMMIT,
  type DiffLayout,
  type Workspace,
} from "../store/types";
import { EditorArea } from "./EditorArea";
import { InlineEdit } from "./InlineEdit";
import { ContextMenu, type MenuItem } from "./Menu";
import { ShortcutsHelp } from "./ShortcutsHelp";

type ServiceRef = { url: string; token: string };

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

  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  // Bumped after a filesystem op so open directory listings re-fetch.
  const [refreshKey, setRefreshKey] = useState(0);
  const [fsError, setFsError] = useState<string | null>(null);

  // Width of the left panel column, adjustable by dragging the divider.
  const [panelWidth, setPanelWidth] = useState(280);
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(640, Math.max(160, startWidth + ev.clientX - startX));
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

  const handleDownload = async (entry: FsEntry) => {
    setFsError(null);
    try {
      await downloadFile(service, entry.path, entry.name);
    } catch (e) {
      setFsError(errMsg(e));
    }
  };

  const handleUpload = async (entry: FsEntry) => {
    setFsError(null);
    try {
      if (await uploadFile(service, entry.path)) setRefreshKey((k) => k + 1);
    } catch (e) {
      setFsError(errMsg(e));
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
        <ShortcutsHelp />
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
          onActivate={(k) => setActiveTab(workspace.id, k)}
          onClose={(k) => closeTab(workspace.id, k)}
          onReorder={(from, to) => moveTab(workspace.id, from, to)}
          onCloseOthers={(k) => closeOtherTabs(workspace.id, k)}
          onCloseToRight={(k) => closeTabsToRight(workspace.id, k)}
          onCloseAll={() => closeAllTabs(workspace.id)}
          onDiffLayout={(layout) => patch(workspace.id, { diffLayout: layout })}
        />
      </div>

      {gitError && <p className="hint hint--error">{gitError}</p>}
      {fsError && <p className="hint hint--error">{fsError}</p>}
    </main>
  );
}

// --- file tree --------------------------------------------------------------

/** Shared handlers/state threaded through the recursive tree nodes. */
interface TreeActions {
  service: ServiceRef;
  expanded: string[];
  activePath?: string;
  refreshKey: number;
  renamingPath: string | null;
  setRenamingPath: (path: string | null) => void;
  /** An in-progress "new file/folder" inline input inside directory `dir`. */
  creating: { dir: string; isDir: boolean } | null;
  setCreating: (c: { dir: string; isDir: boolean } | null) => void;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onContextMenu: (entry: FsEntry, e: React.MouseEvent) => void;
  onRename: (entry: FsEntry, newName: string) => void;
  onCreate: (dir: string, name: string, isDir: boolean) => void;
}

function FileTree({
  service,
  root,
  expanded,
  activePath,
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
  const [creating, setCreating] = useState<{
    dir: string;
    isDir: boolean;
  } | null>(null);

  const actions: TreeActions = {
    service,
    expanded,
    activePath,
    refreshKey,
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
    if (isRoot) return [newFile, newFolder, upload];
    const rename: MenuItem = {
      label: "Rename",
      onClick: () => setRenamingPath(entry.path),
    };
    const del: MenuItem = {
      label: entry.is_dir ? "Delete folder" : "Delete",
      danger: true,
      confirm: entry.is_dir ? "Click again to delete folder" : "Click again to delete",
      onClick: () => onDelete(entry),
    };
    return entry.is_dir
      ? [newFile, newFolder, rename, upload, del]
      : [rename, { label: "Download", onClick: () => onDownload(entry) }, del];
  };

  return (
    <div
      className="weditor__tree"
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
      <DirNode service={service} path={root} depth={0} isRoot actions={actions} />
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
  actions,
}: {
  service: ServiceRef;
  path: string;
  name?: string;
  depth: number;
  isRoot?: boolean;
  actions: TreeActions;
}) {
  const open = isRoot || actions.expanded.includes(path);
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
          className="weditor__row weditor__row--dir"
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
              actions.onRename({ name: name ?? "", path, is_dir: true }, newName)
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
        listing?.entries.map((e) =>
          e.is_dir ? (
            <DirNode
              key={e.path}
              service={service}
              path={e.path}
              name={e.name}
              depth={depth + 1}
              actions={actions}
            />
          ) : (
            <div
              key={e.path}
              role="button"
              tabIndex={0}
              className={`weditor__row weditor__row--file ${
                actions.activePath === e.path ? "is-active" : ""
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
          ),
        )}
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
          title={`${c.subject}${c.body ? `

${c.body}` : ""}

${c.short} · ${c.author} · ${c.date}`}
          onClick={() => onSelect(c.hash)}
        >
          <span className="weditor__label">{c.subject}</span>
          <span className="weditor__commit-meta">{c.short}</span>
        </button>
      ))}
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
}: {
  service: ServiceRef;
  cwd: string;
  commit?: string;
  activePath?: string;
  onOpenDiff: (path: string, commit: string) => void;
}) {
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Collapsed directory paths (default: everything expanded).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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
}: {
  node: ChangeTreeNode;
  prefix: string;
  depth: number;
  commit: string;
  collapsed: Set<string>;
  activePath?: string;
  onToggle: (dirPath: string) => void;
  onOpenDiff: (path: string, commit: string) => void;
}) {
  const indent = { paddingLeft: `${depth * 12 + 8}px` };
  const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
  const files = [...node.files].sort((a, b) =>
    (a.path.split("/").pop() ?? "").localeCompare(b.path.split("/").pop() ?? ""),
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
              <span className={`weditor__twist ${open ? "is-open" : ""}`}>▸</span>
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
        >
          <span className={`weditor__status weditor__status--${c.status[0] ?? ""}`}>
            {c.status}
          </span>
          <span className="weditor__label">{c.path.split("/").pop()}</span>
        </button>
      ))}
    </>
  );
}
