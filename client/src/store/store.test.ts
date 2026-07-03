import { beforeEach, describe, expect, it } from "vitest";

import { applyMsg, useStore, type AppState } from "./store";
import { convKey } from "./types";

function baseState(): AppState {
  return useStore.getState();
}

beforeEach(() => {
  useStore.setState({
    services: [],
    runtime: {},
    conversations: {},
    cursors: {},
    selectedKey: undefined,
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
