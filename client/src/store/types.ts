import type { AgentEvent, ServiceInfo, TaskInfo, TaskStatus } from "../protocol";

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

/** One sequenced agent event as applied to a conversation. */
export interface AppliedMessage {
  seq: number;
  event: AgentEvent;
}

/** A conversation === one agent task on one service. */
export interface Conversation {
  serviceId: string;
  task: TaskInfo;
  messages: AppliedMessage[];
  /** Highest seq durably applied — sent back as the reconnect cursor. */
  cursor: number;
}

/** Composite key so tasks from different services never collide. */
export function convKey(serviceId: string, taskId: string): string {
  return `${serviceId}::${taskId}`;
}

export type { AgentEvent, ServiceInfo, TaskInfo, TaskStatus };
