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
    case "tasks_snapshot": {
      let conversations = s.conversations;
      for (const task of msg.tasks) {
        conversations = ensureConv({ ...s, conversations }, serviceId, task);
      }
      return { conversations };
    }
    case "task_created": {
      const conversations = ensureConv(s, serviceId, msg.task);
      if (!msg.request_id) return { conversations };
      const request = s.createRequests[msg.request_id];
      if (!request || request.serviceId !== serviceId) return { conversations };
      const key = convKey(serviceId, msg.task.id);
      return {
        conversations,
        taskWorkspace: { ...s.taskWorkspace, [key]: request.workspaceId },
        createRequests: {
          ...s.createRequests,
          [msg.request_id]: {
            ...request,
            taskId: msg.task.id,
            error: undefined,
          },
        },
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
      if (msg.code === "create_failed" && msg.request_id) {
        const request = s.createRequests[msg.request_id];
        if (request && request.serviceId === serviceId) {
          return {
            createRequests: {
              ...s.createRequests,
              [msg.request_id]: { ...request, error: msg.message },
            },
          };
        }
      }
      return {};
    }
    case "replay_done":
    case "history_start":
    case "history_done":
    case "pong":
      return {};
  }
}
