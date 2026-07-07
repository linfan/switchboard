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
  /** Shared bearer token. */
  token: string;
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
