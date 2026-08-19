import { beforeEach, describe, expect, it } from "vitest";

import { applyMsg } from "./reducer";
import { useStore, type AppState } from "./store";
import { convKey } from "./types";

function baseState(): AppState {
  return useStore.getState();
}

beforeEach(() => {
  useStore.setState({
    services: [],
    workspaces: [],
    taskWorkspace: {},
    titles: {},
    pendingWorkspace: {},
    sidebarCollapsed: false,
    runtime: {},
    conversations: {},
    cursors: {},
    recentTools: {},
    selectedKey: undefined,
    selectedWorkspaceId: undefined,
    editorState: {},
    createError: undefined,
    transfers: [],
  });
});

function seedTask(svc: string, id: string) {
  useStore.getState().applyServerMsg(svc, {
    type: "task_created",
    task: {
      id,
      tool: "claude",
      title: `T-${id}`,
      status: { state: "running" },
      created_at: 0,
      last_seq: 0,
    },
  });
}

describe("recent tools", () => {
  it("prepends, dedupes, and caps at 5 per service", () => {
    const { addRecentTool } = useStore.getState();
    for (const c of ["a", "b", "c", "a", "d", "e", "f"]) addRecentTool("s1", c);
    // "a" moved to front on reuse; only the 5 most recent are kept.
    expect(useStore.getState().recentTools.s1).toEqual(["f", "e", "d", "a", "c"]);
  });

  it("ignores blank commands and scopes per service", () => {
    const { addRecentTool } = useStore.getState();
    addRecentTool("s1", "  ");
    addRecentTool("s1", "claude");
    addRecentTool("s2", "bash");
    expect(useStore.getState().recentTools.s1).toEqual(["claude"]);
    expect(useStore.getState().recentTools.s2).toEqual(["bash"]);
  });
});

describe("create errors", () => {
  it("surfaces a create_failed error message and clears it", () => {
    useStore.getState().applyServerMsg("s1", {
      type: "error",
      task_id: null,
      code: "create_failed",
      message: "command 'nope' not found on this host",
    });
    expect(useStore.getState().createError).toBe(
      "command 'nope' not found on this host",
    );
    useStore.getState().clearCreateError();
    expect(useStore.getState().createError).toBeUndefined();
  });

  it("ignores errors with other codes", () => {
    useStore.getState().applyServerMsg("s1", {
      type: "error",
      task_id: "t1",
      code: "terminate_failed",
      message: "nope",
    });
    expect(useStore.getState().createError).toBeUndefined();
  });
});

describe("applyServerMsg", () => {
  it("welcome marks the service online and seeds conversations", () => {
    const svc = "s1";
    useStore.getState().applyServerMsg(svc, {
      type: "welcome",
      service: { name: "h", version: "1", tools: [] },
      tasks: [
        {
          id: "t1",
          tool: "claude",
          title: "T1",
          status: { state: "running" },
          created_at: 0,
          last_seq: 0,
        },
      ],
    });
    const s = useStore.getState();
    expect(s.runtime[svc].status).toBe("online");
    expect(s.conversations[convKey(svc, "t1")]).toBeTruthy();
  });

  it("task_state updates the conversation's status", () => {
    const svc = "s1";
    const st = useStore.getState();
    st.applyServerMsg(svc, {
      type: "task_created",
      task: {
        id: "t1",
        tool: "claude",
        title: "T1",
        status: { state: "running" },
        created_at: 0,
        last_seq: 0,
      },
    });
    st.applyServerMsg(svc, {
      type: "task_state",
      task_id: "t1",
      status: { state: "exited", code: 0 },
    });
    const c = useStore.getState().conversations[convKey(svc, "t1")];
    expect(c.task.status.state).toBe("exited");
  });

  it("task_deleted drops the conversation, cursor, and selection", () => {
    const svc = "s1";
    const st = useStore.getState();
    st.applyServerMsg(svc, {
      type: "task_created",
      task: {
        id: "t1",
        tool: "claude",
        title: "T1",
        status: { state: "running" },
        created_at: 0,
        last_seq: 0,
      },
    });
    st.setCursor(svc, "t1", 4);
    st.select(convKey(svc, "t1"));

    st.applyServerMsg(svc, { type: "task_deleted", task_id: "t1" });

    const s = useStore.getState();
    expect(s.conversations[convKey(svc, "t1")]).toBeUndefined();
    expect(s.cursors[convKey(svc, "t1")]).toBeUndefined();
    expect(s.selectedKey).toBeUndefined();
  });
});

describe("setCursor", () => {
  it("advances the durable cursor as data-plane frames are applied", () => {
    const svc = "s1";
    const st = useStore.getState();
    st.setCursor(svc, "t1", 1);
    st.setCursor(svc, "t1", 3);
    const key = convKey(svc, "t1");
    expect(useStore.getState().cursors[key]).toBe(3);
  });

  it("never moves the cursor backwards (dedup on replay)", () => {
    const svc = "s1";
    const st = useStore.getState();
    st.setCursor(svc, "t1", 5);
    st.setCursor(svc, "t1", 2); // stale replay
    expect(useStore.getState().cursors[convKey(svc, "t1")]).toBe(5);
  });

  it("updates the conversation cursor when the task exists", () => {
    const svc = "s1";
    const st = useStore.getState();
    st.applyServerMsg(svc, {
      type: "task_created",
      task: {
        id: "t1",
        tool: "claude",
        title: "T1",
        status: { state: "running" },
        created_at: 0,
        last_seq: 0,
      },
    });
    st.setCursor(svc, "t1", 7);
    expect(useStore.getState().conversations[convKey(svc, "t1")].cursor).toBe(7);
  });

  it("cursorsFor returns task->seq scoped to one service", () => {
    const st = useStore.getState();
    st.setCursor("s1", "t1", 4);
    st.setCursor("s2", "t9", 7);
    expect(useStore.getState().cursorsFor("s1")).toEqual({ t1: 4 });
    expect(useStore.getState().cursorsFor("s2")).toEqual({ t9: 7 });
  });
});

describe("applyMsg", () => {
  it("is a pure transition that does not mutate the input state", () => {
    const s = baseState();
    const patch = applyMsg(s, "s1", {
      type: "task_created",
      task: {
        id: "t1",
        tool: "claude",
        title: "T1",
        status: { state: "running" },
        created_at: 0,
        last_seq: 0,
      },
    });
    expect(s.conversations).toEqual({});
    expect(patch.conversations?.[convKey("s1", "t1")]).toBeTruthy();
  });
});

describe("removeService", () => {
  it("removes the service and all associated state", () => {
    const st = useStore.getState();
    st.addService({ id: "s1", name: "S1", url: "http://a", token: "t" });
    st.addService({ id: "s2", name: "S2", url: "http://b", token: "t" });
    st.applyServerMsg("s1", {
      type: "welcome",
      service: { name: "h", version: "1", tools: [] },
      tasks: [
        { id: "t1", tool: "claude", title: "T1", status: { state: "running" }, created_at: 0, last_seq: 0 },
      ],
    });
    st.setCursor("s1", "t1", 5);
    st.select(convKey("s1", "t1"));

    useStore.getState().removeService("s1");

    const s = useStore.getState();
    expect(s.services.find((sv) => sv.id === "s1")).toBeUndefined();
    expect(s.services.find((sv) => sv.id === "s2")).toBeTruthy();
    expect(s.runtime["s1"]).toBeUndefined();
    expect(s.conversations[convKey("s1", "t1")]).toBeUndefined();
    expect(s.cursors[convKey("s1", "t1")]).toBeUndefined();
    expect(s.selectedKey).toBeUndefined();
  });

  it("does not clear selectedKey when it points to a different service", () => {
    const st = useStore.getState();
    st.addService({ id: "s1", name: "S1", url: "http://a", token: "t" });
    st.addService({ id: "s2", name: "S2", url: "http://b", token: "t" });
    st.applyServerMsg("s2", {
      type: "task_created",
      task: { id: "t2", tool: "claude", title: "T2", status: { state: "running" }, created_at: 0, last_seq: 0 },
    });
    st.select(convKey("s2", "t2"));

    useStore.getState().removeService("s1");
    expect(useStore.getState().selectedKey).toBe(convKey("s2", "t2"));
  });

  it("removeService also drops that service's workspaces and mappings", () => {
    const st = useStore.getState();
    st.addService({ id: "s1", name: "S1", url: "http://a", token: "t" });
    const ws = st.addWorkspace({ serviceId: "s1", name: "W", cwd: "/w" });
    st.enqueuePendingWorkspace("s1", ws);
    seedTask("s1", "t1");
    st.setTaskTitle("s1", "t1", "renamed");

    useStore.getState().removeService("s1");

    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(0);
    expect(s.taskWorkspace[convKey("s1", "t1")]).toBeUndefined();
    expect(s.titles[convKey("s1", "t1")]).toBeUndefined();
    expect(s.pendingWorkspace["s1"]).toBeUndefined();
  });
});

describe("workspaces", () => {
  it("attributes a created task to the queued workspace and clears the queue", () => {
    const st = useStore.getState();
    const ws = st.addWorkspace({ serviceId: "s1", name: "W", cwd: "/w" });
    st.enqueuePendingWorkspace("s1", ws);
    seedTask("s1", "t1");

    const s = useStore.getState();
    expect(s.taskWorkspace[convKey("s1", "t1")]).toBe(ws);
    expect(s.pendingWorkspace["s1"]).toEqual([]);
  });

  it("leaves tasks unmapped when no workspace is queued (ungrouped)", () => {
    seedTask("s1", "t1");
    expect(useStore.getState().taskWorkspace[convKey("s1", "t1")]).toBeUndefined();
  });

  it("a failed create clears the pending queue so it can't steal a later task", () => {
    const st = useStore.getState();
    const ws = st.addWorkspace({ serviceId: "s1", name: "W", cwd: "/w" });
    st.enqueuePendingWorkspace("s1", ws);

    st.applyServerMsg("s1", {
      type: "error",
      task_id: null,
      code: "create_failed",
      message: "nope",
    });
    expect(useStore.getState().pendingWorkspace["s1"]).toEqual([]);

    // A later task (e.g. from another client) is not attributed to the workspace.
    seedTask("s1", "t9");
    expect(useStore.getState().taskWorkspace[convKey("s1", "t9")]).toBeUndefined();
  });

  it("removeWorkspace forgets its task mappings and titles but not the server task", () => {
    const st = useStore.getState();
    const ws = st.addWorkspace({ serviceId: "s1", name: "W", cwd: "/w" });
    st.enqueuePendingWorkspace("s1", ws);
    seedTask("s1", "t1");
    st.setTaskTitle("s1", "t1", "renamed");

    useStore.getState().removeWorkspace(ws);

    const s = useStore.getState();
    expect(s.workspaces).toHaveLength(0);
    expect(s.taskWorkspace[convKey("s1", "t1")]).toBeUndefined();
    expect(s.titles[convKey("s1", "t1")]).toBeUndefined();
    // The conversation itself survives (deletion is a separate server round-trip).
    expect(s.conversations[convKey("s1", "t1")]).toBeTruthy();
  });

  it("setTaskTitle overrides, and blank/identical clears the override", () => {
    const st = useStore.getState();
    seedTask("s1", "t1");
    st.setTaskTitle("s1", "t1", "custom");
    expect(useStore.getState().titles[convKey("s1", "t1")]).toBe("custom");
    st.setTaskTitle("s1", "t1", "   ");
    expect(useStore.getState().titles[convKey("s1", "t1")]).toBeUndefined();
    // Setting it back to the server title is a no-op override.
    st.setTaskTitle("s1", "t1", "custom");
    st.setTaskTitle("s1", "t1", "T-t1");
    expect(useStore.getState().titles[convKey("s1", "t1")]).toBeUndefined();
  });

  it("task_deleted clears the workspace mapping and title override", () => {
    const st = useStore.getState();
    const ws = st.addWorkspace({ serviceId: "s1", name: "W", cwd: "/w" });
    st.enqueuePendingWorkspace("s1", ws);
    seedTask("s1", "t1");
    st.setTaskTitle("s1", "t1", "renamed");

    st.applyServerMsg("s1", { type: "task_deleted", task_id: "t1" });

    const s = useStore.getState();
    expect(s.taskWorkspace[convKey("s1", "t1")]).toBeUndefined();
    expect(s.titles[convKey("s1", "t1")]).toBeUndefined();
  });
});

describe("workspace editor selection", () => {
  it("selectWorkspace and select are mutually exclusive", () => {
    const st = useStore.getState();
    st.selectWorkspace("w1");
    expect(useStore.getState().selectedWorkspaceId).toBe("w1");
    expect(useStore.getState().selectedKey).toBeUndefined();

    st.select(convKey("s1", "t1"));
    expect(useStore.getState().selectedKey).toBe(convKey("s1", "t1"));
    expect(useStore.getState().selectedWorkspaceId).toBeUndefined();

    st.selectWorkspace("w2");
    expect(useStore.getState().selectedWorkspaceId).toBe("w2");
    expect(useStore.getState().selectedKey).toBeUndefined();
  });

  it("patchEditorState merges into a workspace's editor state", () => {
    const st = useStore.getState();
    st.patchEditorState("w1", { expandedDirs: ["/w/src"] });
    st.patchEditorState("w1", { selectedCommit: "abc123" });
    const es = useStore.getState().editorState["w1"];
    expect(es.expandedDirs).toEqual(["/w/src"]);
    expect(es.selectedCommit).toBe("abc123");
    expect(es.openTabs).toEqual([]);
  });

  it("openTab adds/focuses tabs, dedupes, and closeTab focuses a neighbour", () => {
    const st = useStore.getState();
    st.openTab("w1", { path: "/w/a.ts", mode: "edit" });
    st.openTab("w1", { path: "/w/b.ts", mode: "edit" });
    // Re-opening an existing file focuses it without duplicating.
    st.openTab("w1", { path: "/w/a.ts", mode: "edit" });
    let es = useStore.getState().editorState["w1"];
    expect(es.openTabs.map((t) => t.path)).toEqual(["/w/a.ts", "/w/b.ts"]);
    expect(es.activeTab).toBe("edit::/w/a.ts");

    // A diff of the same path is a distinct tab.
    st.openTab("w1", { path: "/w/a.ts", mode: "diff", commit: "WORKING" });
    es = useStore.getState().editorState["w1"];
    expect(es.openTabs).toHaveLength(3);

    // Closing the active tab focuses the neighbour that slides into its slot.
    st.setActiveTab("w1", "edit::/w/a.ts");
    st.closeTab("w1", "edit::/w/a.ts");
    es = useStore.getState().editorState["w1"];
    expect(es.openTabs.map((t) => t.path)).toEqual(["/w/b.ts", "/w/a.ts"]);
    expect(es.activeTab).toBe("edit::/w/b.ts");

    // Closing the last remaining tabs clears the active tab.
    st.closeTab("w1", "edit::/w/b.ts");
    st.closeTab("w1", "diff:WORKING:/w/a.ts");
    es = useStore.getState().editorState["w1"];
    expect(es.openTabs).toEqual([]);
    expect(es.activeTab).toBeUndefined();
  });

  it("moveTab reorders open tabs without changing the active tab", () => {
    const st = useStore.getState();
    st.openTab("w1", { path: "/w/a.ts", mode: "edit" });
    st.openTab("w1", { path: "/w/b.ts", mode: "edit" });
    st.openTab("w1", { path: "/w/c.ts", mode: "edit" });
    st.setActiveTab("w1", "edit::/w/b.ts");

    // Move the first tab to the last tab's slot.
    st.moveTab("w1", "edit::/w/a.ts", "edit::/w/c.ts");
    const es = useStore.getState().editorState["w1"];
    expect(es.openTabs.map((t) => t.path)).toEqual([
      "/w/b.ts",
      "/w/c.ts",
      "/w/a.ts",
    ]);
    expect(es.activeTab).toBe("edit::/w/b.ts");
  });

  it("closeOthers/closeToRight/closeAll prune the tab list", () => {
    const open = () => {
      const st = useStore.getState();
      st.closeAllTabs("w1");
      st.openTab("w1", { path: "/w/a.ts", mode: "edit" });
      st.openTab("w1", { path: "/w/b.ts", mode: "edit" });
      st.openTab("w1", { path: "/w/c.ts", mode: "edit" });
    };

    // Close others keeps only the target and makes it active.
    open();
    useStore.getState().setActiveTab("w1", "edit::/w/a.ts");
    useStore.getState().closeOtherTabs("w1", "edit::/w/b.ts");
    let es = useStore.getState().editorState["w1"];
    expect(es.openTabs.map((t) => t.path)).toEqual(["/w/b.ts"]);
    expect(es.activeTab).toBe("edit::/w/b.ts");

    // Close to the right drops tabs after the anchor; active falls back to it.
    open();
    useStore.getState().setActiveTab("w1", "edit::/w/c.ts");
    useStore.getState().closeTabsToRight("w1", "edit::/w/a.ts");
    es = useStore.getState().editorState["w1"];
    expect(es.openTabs.map((t) => t.path)).toEqual(["/w/a.ts"]);
    expect(es.activeTab).toBe("edit::/w/a.ts");

    // Close all empties the list and clears the active tab.
    open();
    useStore.getState().closeAllTabs("w1");
    es = useStore.getState().editorState["w1"];
    expect(es.openTabs).toEqual([]);
    expect(es.activeTab).toBeUndefined();
  });

  it("closeTabsUnder closes a path and its descendants", () => {
    const st = useStore.getState();
    st.closeAllTabs("w1");
    st.openTab("w1", { path: "/w/a.ts", mode: "edit" });
    st.openTab("w1", { path: "/w/sub/b.ts", mode: "edit" });
    st.openTab("w1", { path: "/w/sub/c.ts", mode: "edit" });

    // Closing the folder closes both descendants, keeps the sibling file.
    st.setActiveTab("w1", "edit::/w/sub/b.ts");
    st.closeTabsUnder("w1", "/w/sub");
    let es = useStore.getState().editorState["w1"];
    expect(es.openTabs.map((t) => t.path)).toEqual(["/w/a.ts"]);
    expect(es.activeTab).toBe("edit::/w/a.ts");

    // Closing an exact file path closes just that tab.
    st.openTab("w1", { path: "/w/a.ts.bak", mode: "edit" });
    st.closeTabsUnder("w1", "/w/a.ts");
    es = useStore.getState().editorState["w1"];
    expect(es.openTabs.map((t) => t.path)).toEqual(["/w/a.ts.bak"]);
  });

  it("setSidebarWidth clamps to the allowed range", () => {
    const st = useStore.getState();
    st.setSidebarWidth(50);
    expect(useStore.getState().sidebarWidth).toBe(180);
    st.setSidebarWidth(9999);
    expect(useStore.getState().sidebarWidth).toBe(560);
    st.setSidebarWidth(320);
    expect(useStore.getState().sidebarWidth).toBe(320);
  });

  it("removeWorkspace drops its editor state and clears selection", () => {
    const st = useStore.getState();
    const ws = st.addWorkspace({ serviceId: "s1", name: "W", cwd: "/w" });
    st.openTab(ws, { path: "/w/a.ts", mode: "edit" });
    st.selectWorkspace(ws);

    useStore.getState().removeWorkspace(ws);

    const s = useStore.getState();
    expect(s.editorState[ws]).toBeUndefined();
    expect(s.selectedWorkspaceId).toBeUndefined();
  });

  it("removeService drops editor state for its workspaces and clears selection", () => {
    const st = useStore.getState();
    st.addService({ id: "s1", name: "S1", url: "http://a", token: "t" });
    const ws = st.addWorkspace({ serviceId: "s1", name: "W", cwd: "/w" });
    st.patchEditorState(ws, { selectedCommit: "WORKING" });
    st.selectWorkspace(ws);

    useStore.getState().removeService("s1");

    const s = useStore.getState();
    expect(s.editorState[ws]).toBeUndefined();
    expect(s.selectedWorkspaceId).toBeUndefined();
  });
});

describe("file transfers", () => {
  it("tracks a transfer from start through progress to end", () => {
    const st = useStore.getState();
    st.startTransfer({
      id: 1,
      kind: "download",
      workspaceId: "w1",
      name: "big.bin",
      done: 0,
    });
    st.startTransfer({
      id: 2,
      kind: "upload",
      workspaceId: "w2",
      name: "up.bin",
      done: 0,
      total: 50,
    });

    // A first tick can supply the total the start didn't know yet.
    useStore.getState().progressTransfer(1, 25, 100);
    expect(useStore.getState().transfers).toEqual([
      { id: 1, kind: "download", workspaceId: "w1", name: "big.bin", done: 25, total: 100 },
      { id: 2, kind: "upload", workspaceId: "w2", name: "up.bin", done: 0, total: 50 },
    ]);

    // A later tick without a total keeps the known one.
    useStore.getState().progressTransfer(1, 60);
    expect(useStore.getState().transfers[0]).toMatchObject({ done: 60, total: 100 });

    useStore.getState().endTransfer(1);
    expect(useStore.getState().transfers.map((t) => t.id)).toEqual([2]);
  });

  it("ignores progress and end for an unknown transfer", () => {
    const st = useStore.getState();
    st.progressTransfer(99, 10, 20);
    st.endTransfer(99);
    expect(useStore.getState().transfers).toEqual([]);
  });
});
