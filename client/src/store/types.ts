import type { ServiceInfo, TaskInfo, TaskStatus } from "../protocol";

/** Liveness of a single hosting-service connection. */
export type ConnStatus = "connecting" | "online" | "offline" | "reconnecting";

/** A hosting service the user has registered. Persisted across restarts. */
export interface Service {
  /** Stable client-generated id (survives edits to name/url). */
  id: string;
  /** User-facing label. */
  name: string;
  /** Base URL, e.g. `http://127.0.0.1:8787` (ws:// derived from it). */
  url: string;
  /** Shared secret. Never transmitted — used only to compute SWB-v1 HMAC proofs. */
  token: string;
  /**
   * SHA-256 (hex) of the server's pinned leaf TLS certificate, captured on first
   * add (trust-on-first-use). Enforced on every later connection and mixed into
   * every auth proof as the channel binding. Absent for plain-HTTP services.
   */
  certFingerprint?: string;
}

/**
 * A work folder on a service. Purely a client-side grouping construct: the
 * server knows nothing about workspaces — it just spawns tasks in a `cwd`. A
 * workspace captures that `cwd` (plus a friendly name) once so tasks created
 * under it inherit the folder without re-prompting.
 */
export interface Workspace {
  /** Stable client-generated id. */
  id: string;
  /** Owning service. */
  serviceId: string;
  /** User-facing label (editable). */
  name: string;
  /** Working directory on the hosting machine tasks inherit. */
  cwd: string;
  /**
   * True when this workspace is a git worktree created from another workspace
   * (its `cwd` lives under `~/.switchboard/worktree/…`). Drives the "Remove
   * worktree" menu item, which deletes the worktree from git as well as the
   * workspace. Absent on ordinary workspaces.
   */
  worktree?: boolean;
}

/** A local loopback listener mapped to a loopback port on one hosting service. */
export interface PortForward {
  /** Stable client-generated id. */
  id: string;
  /** Hosting service whose worker owns the remote loopback target. */
  serviceId: string;
  /** Port bound as 127.0.0.1:<localPort> on this machine. */
  localPort: number;
  /** Port dialed as 127.0.0.1:<remotePort> on the hosting worker. */
  remotePort: number;
  /** Whether the native listener should be running. */
  enabled: boolean;
}

export type PortForwardStatus =
  "starting" | "active" | "stopped" | "error" | "unavailable";

/** Native listener state, refreshed at runtime and never persisted. */
export interface PortForwardRuntime {
  status: PortForwardStatus;
  activeConnections: number;
  error?: string;
}

/** Live connection state for a service (not persisted). */
export interface ServiceRuntime {
  status: ConnStatus;
  info?: ServiceInfo;
  /** Last connection error message, if any. */
  lastError?: string;
  /** Epoch millis of the next scheduled reconnect attempt, if reconnecting. */
  nextRetryAt?: number;
  /** Consecutive failed attempts (drives backoff). */
  attempt: number;
}

/** One open file in the editor: a tab. */
export interface OpenFile {
  /** Absolute path on the hosting machine (repo-relative for a diff). */
  path: string;
  /** `edit` = editable file from the tree; `diff` = read-only diff view. */
  mode: "edit" | "diff";
  /** For a diff, the commit the diff is against (hash or `"WORKING"`). */
  commit?: string;
}

/**
 * Stable identity for an open file, so the same path opened as an edit vs a diff
 * (or against different commits) are distinct tabs. Used as the tab key and the
 * editor-view registry key.
 */
export function tabKey(f: OpenFile): string {
  return `${f.mode}:${f.commit ?? ""}:${f.path}`;
}

/** How a diff tab is rendered: unified inline, or two-pane side-by-side. */
export type DiffLayout = "inline" | "split";

/**
 * Persisted UI state of a workspace's file editor, so switching workspaces or
 * restarting the app restores what the user had open (content itself is
 * re-fetched from the host — cf. how terminals replay from the server).
 */
export interface WorkspaceEditorState {
  /** Absolute paths of expanded folders in the file tree. */
  expandedDirs: string[];
  /** Selected git-history node: a commit hash, or `"WORKING"` for uncommitted. */
  selectedCommit?: string;
  /** Open editor tabs, in display order. */
  openTabs: OpenFile[];
  /** `tabKey` of the active tab, if any. */
  activeTab?: string;
  /** Rendering style for diff tabs (defaults to `"inline"`). */
  diffLayout?: DiffLayout;
}

/** Sentinel commit id for the working tree (uncommitted changes) node. */
export const WORKING_COMMIT = "WORKING";

/**
 * A file transfer in flight between the host and this machine, shown in the
 * Files panel's transfers strip. Ids are allocated by `net/transfer.ts`, which
 * also holds the handle that cancels one.
 */
export interface Transfer {
  id: number;
  kind: "download" | "upload";
  /** Workspace whose Files panel shows this transfer. */
  workspaceId: string;
  /** Base name of the file being moved. */
  name: string;
  /** Bytes moved so far. */
  done: number;
  /** Total bytes, absent until known (or unknown for good, e.g. no Content-Length). */
  total?: number;
}

/** A conversation === one agent task on one service. */
export interface Conversation {
  serviceId: string;
  task: TaskInfo;
  /** Highest PTY chunk seq durably applied — sent back as the reconnect cursor. */
  cursor: number;
}

/** Composite key so tasks from different services never collide. */
export function convKey(serviceId: string, taskId: string): string {
  return `${serviceId}::${taskId}`;
}

/**
 * A service's tasks in display order: those named by `order` first (in that
 * order), then any the list doesn't mention, keeping their relative order. The
 * list is a local override — tasks themselves arrive from the server in creation
 * order and are held in an in-memory record, so one created since the last
 * reorder simply lands at the end.
 */
export function sortConversations(
  conversations: Conversation[],
  order?: string[],
): Conversation[] {
  if (!order || order.length === 0) return conversations;
  const rank = new Map(order.map((id, i) => [id, i]));
  // Array#sort is stable, so unranked tasks keep their server order.
  return [...conversations].sort(
    (a, b) =>
      (rank.get(a.task.id) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(b.task.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export type { ServiceInfo, TaskInfo, TaskStatus };
