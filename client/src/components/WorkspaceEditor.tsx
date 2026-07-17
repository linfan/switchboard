import { useEffect, useState } from "react";

import { gitChanges, gitInfo, gitLog, listDir } from "../net/rest";
import type {
  FsListing,
  GitChange,
  GitCommit,
  GitInfo,
} from "../protocol";
import { useStore } from "../store/store";
import { tabKey, WORKING_COMMIT, type Workspace } from "../store/types";
import { EditorArea } from "./EditorArea";

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

  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);

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

  const toggleDir = (path: string) => {
    const next = expandedDirs.includes(path)
      ? expandedDirs.filter((p) => p !== path)
      : [...expandedDirs, path];
    patch(workspace.id, { expandedDirs: next });
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
      </header>

      <div className={`weditor__body ${showGit ? "" : "weditor__body--nogit"}`}>
        <div className="weditor__panels">
          <section className="weditor__panel weditor__panel--tree">
            <div className="weditor__panel-head">Files</div>
            <div className="weditor__panel-body">
              <FileTree
                service={service}
                root={workspace.cwd}
                expanded={expandedDirs}
                activePath={active?.mode === "edit" ? active.path : undefined}
                onToggleDir={toggleDir}
                onOpenFile={(path) =>
                  openTab(workspace.id, { path, mode: "edit" })
                }
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

        <EditorArea
          key={workspace.id}
          workspaceId={workspace.id}
          service={service}
          cwd={workspace.cwd}
          tabs={openTabs}
          activeKey={activeTab}
          onActivate={(k) => setActiveTab(workspace.id, k)}
          onClose={(k) => closeTab(workspace.id, k)}
        />
      </div>

      {gitError && <p className="hint hint--error">{gitError}</p>}
    </main>
  );
}

// --- file tree --------------------------------------------------------------

function FileTree({
  service,
  root,
  expanded,
  activePath,
  onToggleDir,
  onOpenFile,
}: {
  service: ServiceRef;
  root: string;
  expanded: string[];
  activePath?: string;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  return (
    <DirNode
      service={service}
      path={root}
      depth={0}
      isRoot
      expanded={expanded}
      activePath={activePath}
      onToggleDir={onToggleDir}
      onOpenFile={onOpenFile}
    />
  );
}

function DirNode({
  service,
  path,
  name,
  depth,
  isRoot,
  expanded,
  activePath,
  onToggleDir,
  onOpenFile,
}: {
  service: ServiceRef;
  path: string;
  name?: string;
  depth: number;
  isRoot?: boolean;
  expanded: string[];
  activePath?: string;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const open = isRoot || expanded.includes(path);
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
  }, [open, path, service]);

  const indent = { paddingLeft: `${depth * 12 + 8}px` };

  return (
    <>
      {!isRoot && (
        <button
          className="weditor__row weditor__row--dir"
          style={indent}
          title={name}
          onClick={() => onToggleDir(path)}
        >
          <span className={`weditor__twist ${open ? "is-open" : ""}`}>▸</span>
          <span className="weditor__label">{name}</span>
        </button>
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
      {open &&
        listing?.entries.map((e) =>
          e.is_dir ? (
            <DirNode
              key={e.path}
              service={service}
              path={e.path}
              name={e.name}
              depth={depth + 1}
              expanded={expanded}
              activePath={activePath}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
          ) : (
            <button
              key={e.path}
              className={`weditor__row weditor__row--file ${
                activePath === e.path ? "is-active" : ""
              }`}
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
              title={e.name}
              onClick={() => onOpenFile(e.path)}
            >
              <span className="weditor__label">{e.name}</span>
            </button>
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
          title={`${c.subject}${c.body ? `\n\n${c.body}` : ""}\n\n${c.short} · ${c.author} · ${c.date}`}
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
      {changes?.map((c) => (
        <button
          key={c.path}
          className={`weditor__row weditor__row--file ${
            activePath === c.path ? "is-active" : ""
          }`}
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
