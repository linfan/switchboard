import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ServerMsg } from "../protocol";
import { persistStorage } from "./storage";
import {
  convKey,
  tabKey,
  type Conversation,
  type OpenFile,
  type Service,
  type ServiceInfo,
  type ServiceRuntime,
  type TaskInfo,
  type TaskStatus,
  type Workspace,
  type WorkspaceEditorState,
} from "./types";

const DEFAULT_RUNTIME: ServiceRuntime = { status: "offline", attempt: 0 };

export interface AppState {
  /** Registered services (persisted). */
  services: Service[];
  /** Work folders grouped under services (persisted). */
  workspaces: Workspace[];
  /** Which workspace a task belongs to, keyed by `serviceId::taskId` (persisted). */
  taskWorkspace: Record<string, string>;
  /** Local task-title overrides, keyed by `serviceId::taskId` (persisted). */
  titles: Record<string, string>;
  /**
   * Per-service FIFO queue of workspace ids awaiting a `task_created` to attach
   * to. In-memory only: it briefly holds the workspace a create was launched
   * from so the resulting task can be attributed to it.
   */
  pendingWorkspace: Record<string, string[]>;
  /** Whether the left control panel is collapsed (persisted). */
  sidebarCollapsed: boolean;
  /** Width of the left control panel in px when expanded (persisted). */
  sidebarWidth: number;
  /** Per-service live connection state (in-memory). */
  runtime: Record<string, ServiceRuntime>;
  /** Conversations keyed by `serviceId::taskId`. */
  conversations: Record<string, Conversation>;
  /**
   * Reconnect cursors keyed by `serviceId::taskId`. In-memory only — they track
   * what the *live* xterm buffer already holds, so an in-session reconnect
   * replays nothing redundant. They are deliberately NOT persisted: the terminal
   * buffer doesn't survive a full reload, so a stale cursor would tell the server
   * the client is caught up and leave the reopened screen blank (or paint a
   * mid-stream slice of escapes over a blank screen). Starting fresh at 0 makes
   * the server reconstruct each screen (snapshot or full replay) on reopen.
   */
  cursors: Record<string, number>;
  /** Recently used task commands per service (most-recent first, persisted). */
  recentTools: Record<string, string[]>;
  /** Currently focused conversation key, if any. */
  selectedKey?: string;
  /**
   * Currently focused workspace (its file editor fills the right pane). Mutually
   * exclusive with `selectedKey`. Persisted so the editor restores on restart.
   */
  selectedWorkspaceId?: string;
  /** Per-workspace file-editor UI state, keyed by workspace id (persisted). */
  editorState: Record<string, WorkspaceEditorState>;
  /** Last task-creation error surfaced by the server (in-memory, transient). */
  createError?: string;

  // --- service management -------------------------------------------------
  addService: (svc: Omit<Service, "id"> & { id?: string }) => string;
  updateService: (id: string, patch: Partial<Omit<Service, "id">>) => void;
  removeService: (id: string) => void;
  setRuntime: (id: string, patch: Partial<ServiceRuntime>) => void;
  /** Record a command used to launch a task on a service (dedup, cap 5). */
  addRecentTool: (serviceId: string, cmd: string) => void;
  /** Clear the transient task-creation error. */
  clearCreateError: () => void;

  // --- workspace management -----------------------------------------------
  addWorkspace: (ws: Omit<Workspace, "id"> & { id?: string }) => string;
  updateWorkspace: (id: string, patch: Partial<Omit<Workspace, "id">>) => void;
  /** Remove a workspace and forget its task mappings/titles (does not touch the server). */
  removeWorkspace: (id: string) => void;
  /** Queue a workspace to receive the next `task_created` on a service. */
  enqueuePendingWorkspace: (serviceId: string, workspaceId: string) => void;
  /** Set (or clear, when blank) a local title override for a task. */
  setTaskTitle: (serviceId: string, taskId: string, title: string) => void;

  // --- layout --------------------------------------------------------------
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  /** Set the expanded sidebar width in px. */
  setSidebarWidth: (width: number) => void;

  // --- sync application ----------------------------------------------------
  /** Apply one server (control-plane) message for a given service. */
  applyServerMsg: (serviceId: string, msg: ServerMsg) => void;
  /** Advance a task's durable cursor as data-plane frames are applied. */
  setCursor: (serviceId: string, taskId: string, seq: number) => void;

  // --- selection -----------------------------------------------------------
  /** Focus a conversation (task terminal); clears any workspace selection. */
  select: (key: string | undefined) => void;
  /** Focus a workspace (file editor); clears any conversation selection. */
  selectWorkspace: (id: string | undefined) => void;
  /** Merge a patch into a workspace's persisted editor UI state. */
  patchEditorState: (
    workspaceId: string,
    patch: Partial<WorkspaceEditorState>,
  ) => void;
  /** Open a file as a tab (or focus it if already open) and make it active. */
  openTab: (workspaceId: string, file: OpenFile) => void;
  /** Close a tab; if it was active, focus a neighbouring tab. */
  closeTab: (workspaceId: string, key: string) => void;
  /** Reorder open tabs: move the `fromKey` tab to `toKey`'s position. */
  moveTab: (workspaceId: string, fromKey: string, toKey: string) => void;
  /** Close every tab except `key`, which becomes active. */
  closeOtherTabs: (workspaceId: string, key: string) => void;
  /** Close all tabs positioned after `key`. */
  closeTabsToRight: (workspaceId: string, key: string) => void;
  /** Close every tab in the workspace. */
  closeAllTabs: (workspaceId: string) => void;
  /** Close tabs for `path` or any descendant (after a rename/delete). */
  closeTabsUnder: (workspaceId: string, path: string) => void;
  /** Make an already-open tab the active one. */
  setActiveTab: (workspaceId: string, key: string) => void;

  /** All cursors for a service (sent in Hello on connect). */
  cursorsFor: (serviceId: string) => Record<string, number>;
}

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function emptyEditorState(): WorkspaceEditorState {
  return { expandedDirs: [], openTabs: [] };
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      services: [],
      workspaces: [],
      taskWorkspace: {},
      titles: {},
      pendingWorkspace: {},
      sidebarCollapsed: false,
      sidebarWidth: 260,
      runtime: {},
      conversations: {},
      cursors: {},
      recentTools: {},
      selectedKey: undefined,
      selectedWorkspaceId: undefined,
      editorState: {},
      createError: undefined,

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
          const removedWsIds = new Set(
            s.workspaces.filter((w) => w.serviceId === id).map((w) => w.id),
          );
          const workspaces = s.workspaces.filter((w) => w.serviceId !== id);
          const runtime = { ...s.runtime };
          delete runtime[id];
          const prefix = `${id}::`;
          const dropPrefixed = <V>(m: Record<string, V>) =>
            Object.fromEntries(
              Object.entries(m).filter(([k]) => !k.startsWith(prefix)),
            );
          const conversations = dropPrefixed(s.conversations);
          const cursors = dropPrefixed(s.cursors);
          const taskWorkspace = dropPrefixed(s.taskWorkspace ?? {});
          const titles = dropPrefixed(s.titles ?? {});
          const pendingWorkspace = { ...(s.pendingWorkspace ?? {}) };
          delete pendingWorkspace[id];
          const selectedKey = s.selectedKey?.startsWith(prefix)
            ? undefined
            : s.selectedKey;
          const editorState = Object.fromEntries(
            Object.entries(s.editorState ?? {}).filter(
              ([wsId]) => !removedWsIds.has(wsId),
            ),
          );
          const selectedWorkspaceId =
            s.selectedWorkspaceId && removedWsIds.has(s.selectedWorkspaceId)
              ? undefined
              : s.selectedWorkspaceId;
          return {
            services,
            workspaces,
            runtime,
            conversations,
            cursors,
            taskWorkspace,
            titles,
            pendingWorkspace,
            selectedKey,
            editorState,
            selectedWorkspaceId,
          };
        }),

      setRuntime: (id, patch) =>
        set((s) => ({
          runtime: {
            ...s.runtime,
            [id]: { ...(s.runtime[id] ?? DEFAULT_RUNTIME), ...patch },
          },
        })),

      addRecentTool: (serviceId, cmd) =>
        set((s) => {
          const value = cmd.trim();
          if (value === "") return {};
          const prev = s.recentTools[serviceId] ?? [];
          const next = [value, ...prev.filter((c) => c !== value)].slice(0, 5);
          return { recentTools: { ...s.recentTools, [serviceId]: next } };
        }),

      clearCreateError: () => set({ createError: undefined }),

      addWorkspace: (ws) => {
        const id = ws.id ?? newId();
        set((s) => ({ workspaces: [...s.workspaces, { ...ws, id }] }));
        return id;
      },

      updateWorkspace: (id, patch) =>
        set((s) => ({
          workspaces: s.workspaces.map((w) =>
            w.id === id ? { ...w, ...patch } : w,
          ),
        })),

      removeWorkspace: (id) =>
        set((s) => {
          const workspaces = s.workspaces.filter((w) => w.id !== id);
          const dropByWs = <V>(m: Record<string, V>) =>
            Object.fromEntries(
              Object.entries(m).filter(([k]) => s.taskWorkspace[k] !== id),
            );
          // Titles are keyed the same way as taskWorkspace, so drop titles for
          // tasks that were in this workspace before we forget their mapping.
          const titles = dropByWs(s.titles ?? {});
          const taskWorkspace = Object.fromEntries(
            Object.entries(s.taskWorkspace ?? {}).filter(([, v]) => v !== id),
          );
          const editorState = { ...(s.editorState ?? {}) };
          delete editorState[id];
          const selectedWorkspaceId =
            s.selectedWorkspaceId === id ? undefined : s.selectedWorkspaceId;
          return {
            workspaces,
            taskWorkspace,
            titles,
            editorState,
            selectedWorkspaceId,
          };
        }),

      enqueuePendingWorkspace: (serviceId, workspaceId) =>
        set((s) => ({
          pendingWorkspace: {
            ...s.pendingWorkspace,
            [serviceId]: [...(s.pendingWorkspace[serviceId] ?? []), workspaceId],
          },
        })),

      setTaskTitle: (serviceId, taskId, title) =>
        set((s) => {
          const key = convKey(serviceId, taskId);
          const titles = { ...(s.titles ?? {}) };
          const value = title.trim();
          const conv = s.conversations[key];
          // Clearing the override, or setting it to the server's own title, is a
          // no-op override — drop the key so display falls back to task.title.
          if (value === "" || value === conv?.task.title) delete titles[key];
          else titles[key] = value;
          return { titles };
        }),

      setSidebarCollapsed: (collapsed) =>
        set({ sidebarCollapsed: collapsed }),

      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      setSidebarWidth: (width) =>
        set({ sidebarWidth: Math.min(560, Math.max(180, Math.round(width))) }),

      applyServerMsg: (serviceId, msg) =>
        set((s) => applyMsg(s, serviceId, msg)),

      setCursor: (serviceId, taskId, seq) =>
        set((s) => {
          const key = convKey(serviceId, taskId);
          if (seq <= (s.cursors[key] ?? 0)) return {};
          const conv = s.conversations[key];
          const conversations = conv
            ? { ...s.conversations, [key]: { ...conv, cursor: seq } }
            : s.conversations;
          return { conversations, cursors: { ...s.cursors, [key]: seq } };
        }),

      select: (key) =>
        set({ selectedKey: key, selectedWorkspaceId: undefined }),

      selectWorkspace: (id) =>
        set({ selectedWorkspaceId: id, selectedKey: undefined }),

      patchEditorState: (workspaceId, patch) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const existing = editorState[workspaceId] ?? emptyEditorState();
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...existing, ...patch },
            },
          };
        }),

      openTab: (workspaceId, file) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const cur = editorState[workspaceId] ?? emptyEditorState();
          // Tolerate editorState persisted by an older single-file version,
          // which has no `openTabs`.
          const tabs = cur.openTabs ?? [];
          const key = tabKey(file);
          const exists = tabs.some((t) => tabKey(t) === key);
          const openTabs = exists ? tabs : [...tabs, file];
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...cur, openTabs, activeTab: key },
            },
          };
        }),

      closeTab: (workspaceId, key) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const cur = editorState[workspaceId];
          if (!cur) return {};
          const tabs = cur.openTabs ?? [];
          const idx = tabs.findIndex((t) => tabKey(t) === key);
          if (idx === -1) return {};
          const openTabs = tabs.filter((_, i) => i !== idx);
          let activeTab = cur.activeTab;
          if (activeTab === key) {
            // Focus the tab that slid into this slot, else the previous one.
            const neighbour = openTabs[idx] ?? openTabs[idx - 1];
            activeTab = neighbour ? tabKey(neighbour) : undefined;
          }
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...cur, openTabs, activeTab },
            },
          };
        }),

      moveTab: (workspaceId, fromKey, toKey) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const cur = editorState[workspaceId];
          if (!cur) return {};
          const tabs = cur.openTabs ?? [];
          const from = tabs.findIndex((t) => tabKey(t) === fromKey);
          const to = tabs.findIndex((t) => tabKey(t) === toKey);
          if (from === -1 || to === -1 || from === to) return {};
          const openTabs = [...tabs];
          const [moved] = openTabs.splice(from, 1);
          openTabs.splice(to, 0, moved);
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...cur, openTabs },
            },
          };
        }),

      closeOtherTabs: (workspaceId, key) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const cur = editorState[workspaceId];
          if (!cur) return {};
          const tabs = cur.openTabs ?? [];
          const openTabs = tabs.filter((t) => tabKey(t) === key);
          if (openTabs.length === tabs.length) return {};
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...cur, openTabs, activeTab: key },
            },
          };
        }),

      closeTabsToRight: (workspaceId, key) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const cur = editorState[workspaceId];
          if (!cur) return {};
          const tabs = cur.openTabs ?? [];
          const idx = tabs.findIndex((t) => tabKey(t) === key);
          if (idx === -1 || idx === tabs.length - 1) return {};
          const openTabs = tabs.slice(0, idx + 1);
          // If the active tab was among those closed, focus the anchor tab.
          const activeTab = openTabs.some((t) => tabKey(t) === cur.activeTab)
            ? cur.activeTab
            : key;
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...cur, openTabs, activeTab },
            },
          };
        }),

      closeAllTabs: (workspaceId) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const cur = editorState[workspaceId];
          if (!cur || (cur.openTabs ?? []).length === 0) return {};
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...cur, openTabs: [], activeTab: undefined },
            },
          };
        }),

      closeTabsUnder: (workspaceId, path) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const cur = editorState[workspaceId];
          if (!cur) return {};
          const tabs = cur.openTabs ?? [];
          const prefix = `${path}/`;
          const affected = (t: OpenFile) =>
            t.path === path || t.path.startsWith(prefix);
          const openTabs = tabs.filter((t) => !affected(t));
          if (openTabs.length === tabs.length) return {};
          // Keep the active tab unless it was one of the closed ones.
          const activeStillOpen = openTabs.some(
            (t) => tabKey(t) === cur.activeTab,
          );
          const activeTab = activeStillOpen
            ? cur.activeTab
            : openTabs.length
              ? tabKey(openTabs[openTabs.length - 1])
              : undefined;
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...cur, openTabs, activeTab },
            },
          };
        }),

      setActiveTab: (workspaceId, key) =>
        set((s) => {
          const editorState = s.editorState ?? {};
          const cur = editorState[workspaceId];
          if (!cur) return {};
          return {
            editorState: {
              ...editorState,
              [workspaceId]: { ...cur, activeTab: key },
            },
          };
        }),

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
      name: "switchboard",
      storage: createJSONStorage(() => persistStorage),
      partialize: (s) => ({
        services: s.services,
        workspaces: s.workspaces,
        taskWorkspace: s.taskWorkspace,
        titles: s.titles,
        recentTools: s.recentTools,
        sidebarCollapsed: s.sidebarCollapsed,
        sidebarWidth: s.sidebarWidth,
        selectedWorkspaceId: s.selectedWorkspaceId,
        editorState: s.editorState,
      }),
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
      const selectedKey = s.selectedKey === key ? undefined : s.selectedKey;
      return { conversations, cursors, taskWorkspace, titles, selectedKey };
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
