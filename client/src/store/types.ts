import type { ServiceInfo, TaskInfo, TaskStatus } from "../protocol";

/** Liveness of a single hosting-service connection. */
export type ConnStatus =
  | "connecting"
  | "online"
  | "offline"
  | "reconnecting";

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

export type { ServiceInfo, TaskInfo, TaskStatus };
