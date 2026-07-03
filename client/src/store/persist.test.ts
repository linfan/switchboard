import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "./store";

const KEY = "agent-manage";

function persisted(): { services: unknown[] } {
  return JSON.parse(localStorage.getItem(KEY) ?? '{"state":{"services":[]}}')
    .state;
}

describe("persist round-trip through localStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ services: [], runtime: {}, conversations: {}, cursors: {}, selectedKey: undefined });
  });

  it("writes an added service and removes it on delete", () => {
    const id = useStore.getState().addService({ name: "Demo", url: "http://x", token: "t" });
    expect(persisted().services).toHaveLength(1);

    useStore.getState().removeService(id);
    expect(useStore.getState().services).toHaveLength(0);
    expect(persisted().services).toHaveLength(0);
  });
});
