import type { ServerMsg } from "../protocol";
import type { AppState } from "./store";
import {
  convKey,
  type Conversation,
  type ServiceInfo,
  type ServiceRuntime,
  type TaskInfo,
  type TaskStatus,
} from "./types";

export const DEFAULT_RUNTIME: ServiceRuntime = {
  status: "offline",
  attempt: 0,
};

function ensureConv(
  s: AppState,
  serviceId: string,
  task: TaskInfo,
): Record<string, Conversation> {
  const key = convKey(serviceId, task.id);
  const existing = s.conversations[key];
  return {
    ...s.conversations,
    [key]: existing
      ? { ...existing, task }
      : { serviceId, task, cursor: s.cursors[key] ?? 0 },
  };
}

function setStatus(
  conversations: Record<string, Conversation>,
  key: string,
  status: TaskStatus,
): Record<string, Conversation> {
  const c = conversations[key];
  if (!c) return conversations;
  return { ...conversations, [key]: { ...c, task: { ...c.task, status } } };
}

/** Pure transition — returns the partial state to merge. Exported for tests. */
export function applyMsg(
  s: AppState,
  serviceId: string,
  msg: ServerMsg,
): Partial<AppState> {
  switch (msg.type) {
    case "welcome": {
      const runtimePatch: ServiceRuntime = {
        ...(s.runtime[serviceId] ?? DEFAULT_RUNTIME),
        status: "online",
        info: msg.service as ServiceInfo,
        lastError: undefined,
        attempt: 0,
      };
      let conversations = s.conversations;
      for (const task of msg.tasks) {
        conversations = ensureConv({ ...s, conversations }, serviceId, task);
      }
      return {
        runtime: { ...s.runtime, [serviceId]: runtimePatch },
        conversations,
      };
    }
    case "task_created": {
      const conversations = ensureConv(s, serviceId, msg.task);
      // Attribute this task to the workspace its create was launched from, if
      // one is queued for this service. Tasks with no queued workspace (e.g.
      // created by another client) stay unmapped and render under "Ungrouped".
      const queue = s.pendingWorkspace[serviceId] ?? [];
      if (queue.length === 0) return { conversations };
      const [workspaceId, ...rest] = queue;
      const key = convKey(serviceId, msg.task.id);
      return {
        conversations,
        taskWorkspace: { ...s.taskWorkspace, [key]: workspaceId },
        pendingWorkspace: { ...s.pendingWorkspace, [serviceId]: rest },
        // This client just created the task — focus its terminal.
        selectedKey: key,
        selectedWorkspaceId: undefined,
      };
    }
    case "task_state": {
      const key = convKey(serviceId, msg.task_id);
      return { conversations: setStatus(s.conversations, key, msg.status) };
    }
    case "task_deleted": {
      const key = convKey(serviceId, msg.task_id);
      const known =
        key in s.conversations ||
        key in s.cursors ||
        key in (s.taskWorkspace ?? {}) ||
        key in (s.titles ?? {});
      if (!known) return {};
      const conversations = { ...s.conversations };
      delete conversations[key];
      const cursors = { ...s.cursors };
      delete cursors[key];
      const taskWorkspace = { ...(s.taskWorkspace ?? {}) };
      delete taskWorkspace[key];
      const titles = { ...(s.titles ?? {}) };
      delete titles[key];
      // The order list names task ids, so forget this one there too.
      const order = s.taskOrder?.[serviceId];
      const taskOrder = order
        ? {
            ...s.taskOrder,
            [serviceId]: order.filter((id) => id !== msg.task_id),
          }
        : s.taskOrder;
      const selectedKey = s.selectedKey === key ? undefined : s.selectedKey;
      return {
        conversations,
        cursors,
        taskWorkspace,
        taskOrder,
        titles,
        selectedKey,
      };
    }
    case "error": {
      if (msg.code === "create_failed") {
        // The queued workspace for this create will never get a task_created;
        // drop it so it doesn't steal a later successful create on this service.
        return {
          createError: msg.message,
          pendingWorkspace: { ...s.pendingWorkspace, [serviceId]: [] },
        };
      }
      return {};
    }
    case "replay_done":
    case "pong":
      return {};
  }
}
