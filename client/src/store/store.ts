import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { ServerMsg } from "../protocol";
import {
  convKey,
  type Conversation,
  type Service,
  type ServiceInfo,
  type ServiceRuntime,
  type TaskInfo,
  type TaskStatus,
} from "./types";

const DEFAULT_RUNTIME: ServiceRuntime = { status: "offline", attempt: 0 };

export interface AppState {
  /** Registered services (persisted). */
  services: Service[];
  /** Per-service live connection state (in-memory). */
  runtime: Record<string, ServiceRuntime>;
  /** Conversations keyed by `serviceId::taskId`. */
  conversations: Record<string, Conversation>;
  /** Persisted reconnect cursors keyed by `serviceId::taskId`. */
  cursors: Record<string, number>;
  /** Currently focused conversation key, if any. */
  selectedKey?: string;

  // --- service management -------------------------------------------------
  addService: (svc: Omit<Service, "id"> & { id?: string }) => string;
  updateService: (id: string, patch: Partial<Omit<Service, "id">>) => void;
  removeService: (id: string) => void;
  setRuntime: (id: string, patch: Partial<ServiceRuntime>) => void;

  // --- sync application ----------------------------------------------------
  /** Apply one server message for a given service to the store. */
  applyServerMsg: (serviceId: string, msg: ServerMsg) => void;

  // --- selection -----------------------------------------------------------
  select: (key: string | undefined) => void;

  /** All cursors for a service (sent in Hello on connect). */
  cursorsFor: (serviceId: string) => Record<string, number>;
}

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      services: [],
      runtime: {},
      conversations: {},
      cursors: {},
      selectedKey: undefined,

      addService: (svc) => {
        const id = svc.id ?? newId();
        set((s) => ({
          services: [...s.services, { ...svc, id }],
          runtime: { ...s.runtime, [id]: { ...DEFAULT_RUNTIME } },
        }));
        return id;
      },

      updateService: (id, patch) =>
        set((s) => ({
          services: s.services.map((sv) =>
            sv.id === id ? { ...sv, ...patch } : sv,
          ),
        })),

      removeService: (id) =>
        set((s) => {
          const services = s.services.filter((sv) => sv.id !== id);
          const runtime = { ...s.runtime };
          delete runtime[id];
          const prefix = `${id}::`;
          const conversations = Object.fromEntries(
            Object.entries(s.conversations).filter(
              ([k]) => !k.startsWith(prefix),
            ),
          );
          const cursors = Object.fromEntries(
            Object.entries(s.cursors).filter(([k]) => !k.startsWith(prefix)),
          );
          const selectedKey = s.selectedKey?.startsWith(prefix)
            ? undefined
            : s.selectedKey;
          return { services, runtime, conversations, cursors, selectedKey };
        }),

      setRuntime: (id, patch) =>
        set((s) => ({
          runtime: {
            ...s.runtime,
            [id]: { ...(s.runtime[id] ?? DEFAULT_RUNTIME), ...patch },
          },
        })),

      applyServerMsg: (serviceId, msg) =>
        set((s) => applyMsg(s, serviceId, msg)),

      select: (key) => set({ selectedKey: key }),

      cursorsFor: (serviceId) => {
        const prefix = `${serviceId}::`;
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(get().cursors)) {
          if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
        }
        return out;
      },
    }),
    {
      name: "agent-manage",
      partialize: (s) => ({ services: s.services, cursors: s.cursors }),
    },
  ),
);

// --- pure reducer -----------------------------------------------------------

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
      : { serviceId, task, messages: [], cursor: s.cursors[key] ?? 0 },
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
      return {
        conversations: ensureConv(s, serviceId, msg.task),
      };
    }
    case "task_state": {
      const key = convKey(serviceId, msg.task_id);
      return { conversations: setStatus(s.conversations, key, msg.status) };
    }
    case "message": {
      const key = convKey(serviceId, msg.task_id);
      const conv = s.conversations[key];
      // Message can arrive before Welcome lists the task; create a stub.
      const base: Conversation =
        conv ??
        {
          serviceId,
          task: {
            id: msg.task_id,
            tool: "",
            title: msg.task_id,
            status: { state: "running" } as TaskStatus,
            created_at: 0,
            last_seq: 0,
          },
          messages: [],
          cursor: s.cursors[key] ?? 0,
        };
      // Dedup + gap-awareness: ignore anything at or below the cursor.
      if (msg.seq <= base.cursor) return {};
      const messages = [...base.messages, { seq: msg.seq, event: msg.event }];
      const updated: Conversation = {
        ...base,
        messages,
        cursor: msg.seq,
        task: { ...base.task, last_seq: Math.max(base.task.last_seq, msg.seq) },
      };
      return {
        conversations: { ...s.conversations, [key]: updated },
        cursors: { ...s.cursors, [key]: msg.seq },
      };
    }
    case "replay_done":
    case "pong":
      return {};
    case "error":
      return {};
  }
}
