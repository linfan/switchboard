import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ServerMsg } from "../protocol";
import { applyMsg, DEFAULT_RUNTIME } from "./reducer";
import {
  clampSettings,
  DEFAULT_EDITOR_WRAP,
  DEFAULT_FONT_SIZE,
  DEFAULT_SETTINGS,
  FONT_SIZE_BOUNDS,
  withSettingDefaults,
  type Settings,
} from "./settings";
import { persistStorage } from "./storage";
import {
  convKey,
  sortConversations,
  tabKey,
  type Conversation,
  type OpenFile,
  type PortForward,
  type PortForwardRuntime,
  type Service,
  type ServiceRuntime,
  type Transfer,
  type Workspace,
  type WorkspaceEditorState,
} from "./types";

export interface AppState {
  /** Registered services (persisted). */
  services: Service[];
  /** Work folders grouped under services (persisted). */
  workspaces: Workspace[];
  /** Local-to-remote port mapping specs (persisted; no service credentials copied). */
  portForwards: PortForward[];
  /** Live native listener state by forward id (in-memory). */
  portForwardRuntime: Record<string, PortForwardRuntime>;
  /** Which workspace a task belongs to, keyed by `serviceId::taskId` (persisted). */
  taskWorkspace: Record<string, string>;
  /**
   * Task display order per service, as a list of task ids (persisted). Tasks
   * themselves arrive from the server in creation order and live in an in-memory
   * record, so a drag-to-reorder in the sidebar has to be recorded separately to
   * survive a reconnect or restart. Ids the list doesn't mention sort after the
   * ones it does — see `sortConversations`.
   */
  taskOrder: Record<string, string[]>;
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
  /** Terminal font size in px, adjustable via zoom shortcuts (persisted). */
  terminalFontSize: number;
  /** File-editor font size in px, adjustable via zoom shortcuts (persisted). */
  editorFontSize: number;
  /**
   * Long-line wrap a file-editor tab is seeded with when its view is built
   * (persisted). A tab whose view already exists keeps its own state — its Text
   * Wrap button owns it from then on.
   */
  editorWrapDefault: boolean;
  /** Configurable limits and timings from the settings panel (persisted). */
  settings: Settings;
  /**
   * Whether the settings dialog is showing (in-memory). Kept in the store because
   * two entry points open it — the macOS menu and the sidebar's gear button —
   * and they must drive the same single dialog.
   */
  settingsOpen: boolean;
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
  /** Service whose status page fills the main pane (in-memory). */
  selectedServiceId?: string;
  /** Per-workspace file-editor UI state, keyed by workspace id (persisted). */
  editorState: Record<string, WorkspaceEditorState>;
  /** Last task-creation error surfaced by the server (in-memory, transient). */
  createError?: string;
  /**
   * File transfers in flight, in start order (in-memory, transient). Kept in the
   * store rather than in the Files panel so switching workspace or focusing a
   * terminal mid-transfer doesn't lose track of one.
   */
  transfers: Transfer[];

  // --- service management -------------------------------------------------
  addService: (svc: Omit<Service, "id"> & { id?: string }) => string;
  updateService: (id: string, patch: Partial<Omit<Service, "id">>) => void;
  removeService: (id: string) => void;
  /** Reorder the service list: move `fromId` into `toId`'s slot. */
  moveService: (fromId: string, toId: string) => void;
  setRuntime: (id: string, patch: Partial<ServiceRuntime>) => void;
  /** Record a command used to launch a task on a service (dedup, cap 5). */
  addRecentTool: (serviceId: string, cmd: string) => void;
  /** Clear the transient task-creation error. */
  clearCreateError: () => void;

  // --- file transfers -------------------------------------------------------
  /** Add a transfer row (a download or upload has just begun). */
  startTransfer: (t: Transfer) => void;
  /** Advance a transfer's byte counts; ignored once it has ended. */
  progressTransfer: (id: number, done: number, total?: number) => void;
  /** Drop a transfer row — it completed, failed, or was cancelled. */
  endTransfer: (id: number) => void;

  // --- workspace management -----------------------------------------------
  addWorkspace: (ws: Omit<Workspace, "id"> & { id?: string }) => string;
  updateWorkspace: (id: string, patch: Partial<Omit<Workspace, "id">>) => void;
  /** Remove a workspace and forget its task mappings/titles (does not touch the server). */
  removeWorkspace: (id: string) => void;
  /** Reorder workspaces inside one service: move `fromId` into `toId`'s slot. */
  moveWorkspace: (fromId: string, toId: string) => void;
  /** Queue a workspace to receive the next `task_created` on a service. */
  enqueuePendingWorkspace: (serviceId: string, workspaceId: string) => void;
  /** Set (or clear, when blank) a local title override for a task. */
  setTaskTitle: (serviceId: string, taskId: string, title: string) => void;
  /** Reorder tasks inside one service: move `fromTaskId` into `toTaskId`'s slot. */
  moveTask: (serviceId: string, fromTaskId: string, toTaskId: string) => void;

  // --- port forwarding -----------------------------------------------------
  addPortForward: (
    forward: Omit<PortForward, "id"> & { id?: string },
  ) => string;
  updatePortForward: (
    id: string,
    patch: Partial<Omit<PortForward, "id">>,
  ) => void;
  removePortForward: (id: string) => void;
  setPortForwardRuntime: (id: string, runtime: PortForwardRuntime) => void;

  // --- layout --------------------------------------------------------------
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  /** Set the expanded sidebar width in px. */
  setSidebarWidth: (width: number) => void;
  /** Adjust a pane type's font size by `delta` px (clamped); used by zoom shortcuts. */
  zoomFont: (target: "terminal" | "editor", delta: number) => void;
  /** Set a pane type's font size directly (clamped); used by the settings panel. */
  setFontSize: (target: "terminal" | "editor", px: number) => void;
  /** Set the wrap state a file-editor tab is seeded with when built. */
  setEditorWrapDefault: (wrap: boolean) => void;

  // --- settings ------------------------------------------------------------
  /** Merge a patch into the persisted settings, clamped to their valid ranges. */
  setSettings: (patch: Partial<Settings>) => void;
  setSettingsOpen: (open: boolean) => void;

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
  /** Focus a service's status page; clears terminal and editor selections. */
  selectService: (serviceId: string | undefined) => void;
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

/**
 * Move the item with `fromId` into `toId`'s slot — the semantics the sidebar's
 * drag-to-reorder shares across its three levels (and the editor's tabs). Returns
 * `items` unchanged when either id is missing or the move would be a no-op, so
 * callers can skip writing state.
 */
function moveTo<T>(
  items: T[],
  fromId: string,
  toId: string,
  idOf: (item: T) => string,
): T[] {
  const from = items.findIndex((item) => idOf(item) === fromId);
  const to = items.findIndex((item) => idOf(item) === toId);
  if (from === -1 || to === -1 || from === to) return items;
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function clampFontSize(px: number): number {
  const { min, max } = FONT_SIZE_BOUNDS;
  return Math.min(max, Math.max(min, Math.round(px)));
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      services: [],
      workspaces: [],
      portForwards: [],
      portForwardRuntime: {},
      taskWorkspace: {},
      taskOrder: {},
      titles: {},
      pendingWorkspace: {},
      sidebarCollapsed: false,
      sidebarWidth: 260,
      terminalFontSize: DEFAULT_FONT_SIZE,
      editorFontSize: DEFAULT_FONT_SIZE,
      editorWrapDefault: DEFAULT_EDITOR_WRAP,
      settings: DEFAULT_SETTINGS,
      settingsOpen: false,
      runtime: {},
      conversations: {},
      cursors: {},
      recentTools: {},
      selectedKey: undefined,
      selectedWorkspaceId: undefined,
      selectedServiceId: undefined,
      editorState: {},
      createError: undefined,
      transfers: [],

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
          const removedForwardIds = new Set(
            s.portForwards
              .filter((forward) => forward.serviceId === id)
              .map((forward) => forward.id),
          );
          const portForwards = s.portForwards.filter(
            (forward) => forward.serviceId !== id,
          );
          const portForwardRuntime = { ...s.portForwardRuntime };
          for (const forwardId of removedForwardIds)
            delete portForwardRuntime[forwardId];
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
          const taskOrder = { ...(s.taskOrder ?? {}) };
          delete taskOrder[id];
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
          const selectedServiceId =
            s.selectedServiceId === id ? undefined : s.selectedServiceId;
          return {
            services,
            workspaces,
            portForwards,
            portForwardRuntime,
            runtime,
            conversations,
            cursors,
            taskWorkspace,
            taskOrder,
            titles,
            pendingWorkspace,
            selectedKey,
            editorState,
            selectedWorkspaceId,
            selectedServiceId,
          };
        }),

      moveService: (fromId, toId) =>
        set((s) => ({
          services: moveTo(s.services, fromId, toId, (sv) => sv.id),
        })),

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

      startTransfer: (t) => set((s) => ({ transfers: [...s.transfers, t] })),

      progressTransfer: (id, done, total) =>
        set((s) => ({
          transfers: s.transfers.map((t) =>
            t.id === id ? { ...t, done, total: total ?? t.total } : t,
          ),
        })),

      endTransfer: (id) =>
        set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),

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

      // Every service's workspaces share this one array and the sidebar renders a
      // service's slice in array order, so moving one entry into another's slot
      // reorders that slice and leaves the other services' order intact.
      moveWorkspace: (fromId, toId) =>
        set((s) => ({
          workspaces: moveTo(s.workspaces, fromId, toId, (w) => w.id),
        })),

      enqueuePendingWorkspace: (serviceId, workspaceId) =>
        set((s) => ({
          pendingWorkspace: {
            ...s.pendingWorkspace,
            [serviceId]: [
              ...(s.pendingWorkspace[serviceId] ?? []),
              workspaceId,
            ],
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

      moveTask: (serviceId, fromTaskId, toTaskId) =>
        set((s) => {
          // Seed the list from the current on-screen order the first time, so the
          // move is relative to what the user sees rather than to an empty list
          // that would leave every other task unranked.
          const current = sortConversations(
            Object.values(s.conversations).filter(
              (c) => c.serviceId === serviceId,
            ),
            s.taskOrder?.[serviceId],
          ).map((c) => c.task.id);
          const order = moveTo(current, fromTaskId, toTaskId, (id) => id);
          if (order === current) return {};
          return { taskOrder: { ...s.taskOrder, [serviceId]: order } };
        }),

      addPortForward: (forward) => {
        const id = forward.id ?? newId();
        set((s) => ({ portForwards: [...s.portForwards, { ...forward, id }] }));
        return id;
      },

      updatePortForward: (id, patch) =>
        set((s) => ({
          portForwards: s.portForwards.map((forward) =>
            forward.id === id ? { ...forward, ...patch } : forward,
          ),
        })),

      removePortForward: (id) =>
        set((s) => {
          const portForwardRuntime = { ...s.portForwardRuntime };
          delete portForwardRuntime[id];
          return {
            portForwards: s.portForwards.filter((forward) => forward.id !== id),
            portForwardRuntime,
          };
        }),

      setPortForwardRuntime: (id, runtime) =>
        set((s) => ({
          portForwardRuntime: { ...s.portForwardRuntime, [id]: runtime },
        })),

      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),

      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      setSidebarWidth: (width) =>
        set({ sidebarWidth: Math.min(560, Math.max(180, Math.round(width))) }),

      zoomFont: (target, delta) =>
        set((s) => {
          const current =
            (target === "terminal" ? s.terminalFontSize : s.editorFontSize) ??
            DEFAULT_FONT_SIZE;
          const px = clampFontSize(current + delta);
          return target === "terminal"
            ? { terminalFontSize: px }
            : { editorFontSize: px };
        }),

      setFontSize: (target, px) =>
        set(
          target === "terminal"
            ? { terminalFontSize: clampFontSize(px) }
            : { editorFontSize: clampFontSize(px) },
        ),

      setEditorWrapDefault: (wrap) => set({ editorWrapDefault: wrap }),

      setSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...clampSettings(patch) } })),

      setSettingsOpen: (open) => set({ settingsOpen: open }),

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
        set({
          selectedKey: key,
          selectedWorkspaceId: undefined,
          selectedServiceId: undefined,
        }),

      selectWorkspace: (id) =>
        set({
          selectedWorkspaceId: id,
          selectedKey: undefined,
          selectedServiceId: undefined,
        }),

      selectService: (serviceId) =>
        set({
          selectedServiceId: serviceId,
          selectedKey: undefined,
          selectedWorkspaceId: undefined,
        }),

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
        portForwards: s.portForwards,
        taskWorkspace: s.taskWorkspace,
        taskOrder: s.taskOrder,
        titles: s.titles,
        recentTools: s.recentTools,
        sidebarCollapsed: s.sidebarCollapsed,
        sidebarWidth: s.sidebarWidth,
        terminalFontSize: s.terminalFontSize,
        editorFontSize: s.editorFontSize,
        editorWrapDefault: s.editorWrapDefault,
        settings: s.settings,
        selectedWorkspaceId: s.selectedWorkspaceId,
        editorState: s.editorState,
      }),
      // zustand's default merge spreads the persisted state over the current one
      // at the top level only, so a `settings` object written by an older build
      // would replace the defaults wholesale and leave any setting added since
      // `undefined`. Rebuild it from the defaults instead. `persisted` is absent
      // on a first run, and the result replaces the whole state, so this must
      // return every key.
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...saved,
          settings: withSettingDefaults(saved.settings),
        };
      },
    },
  ),
);
