import { beforeEach, describe, expect, it } from "vitest";

import { applyMsg, useStore, type AppState } from "./store";
import { convKey } from "./types";

function baseState(): AppState {
  return useStore.getState();
}

function msg(taskId: string, seq: number, text: string) {
  return {
    type: "message" as const,
    task_id: taskId,
    seq,
    event: { kind: "assistant", text, raw: {} },
  };
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

  it("appends messages and advances the cursor", () => {
    const svc = "s1";
    const st = useStore.getState();
    st.applyServerMsg(svc, msg("t1", 1, "a"));
    st.applyServerMsg(svc, msg("t1", 2, "b"));
    const s = useStore.getState();
    const key = convKey(svc, "t1");
    expect(s.conversations[key].messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(s.conversations[key].cursor).toBe(2);
    expect(s.cursors[key]).toBe(2);
  });

  it("dedups replays at or below the cursor (no message loss, no dupes)", () => {
    const svc = "s1";
    const st = useStore.getState();
    st.applyServerMsg(svc, msg("t1", 1, "a"));
    st.applyServerMsg(svc, msg("t1", 2, "b"));
    // Simulate a reconnect replay that re-sends 1 and 2, then a new 3.
    st.applyServerMsg(svc, msg("t1", 1, "a"));
    st.applyServerMsg(svc, msg("t1", 2, "b"));
    st.applyServerMsg(svc, msg("t1", 3, "c"));
    const key = convKey(svc, "t1");
    const seqs = useStore.getState().conversations[key].messages.map((m) => m.seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it("cursorsFor returns task->seq scoped to one service", () => {
    const st = useStore.getState();
    st.applyServerMsg("s1", msg("t1", 4, "x"));
    st.applyServerMsg("s2", msg("t9", 7, "y"));
    expect(useStore.getState().cursorsFor("s1")).toEqual({ t1: 4 });
    expect(useStore.getState().cursorsFor("s2")).toEqual({ t9: 7 });
  });

  it("applyMsg is a pure transition", () => {
    const s = baseState();
    const patch = applyMsg(s, "s1", msg("t1", 1, "a"));
    // Original state object is not mutated.
    expect(s.conversations).toEqual({});
    expect(patch.cursors).toEqual({ [convKey("s1", "t1")]: 1 });
  });
});
