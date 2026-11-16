import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionDeps } from "./connection";

const fake = vi.hoisted(() => ({
  managers: [] as {
    deps: ConnectionDeps;
    started: boolean;
    stopped: boolean;
  }[],
}));

vi.mock("./connection", () => ({
  DEFAULT_RECONNECT: {
    baseDelayMs: 1000,
    maxDelayMs: 30000,
    factor: 2,
    jitter: 0.2,
  },
  DEFAULT_HEARTBEAT: { intervalMs: 15000, timeoutMs: 10000 },
  DEFAULT_HANDSHAKE: { timeoutMs: 10000 },
  ConnectionManager: class {
    deps: ConnectionDeps;
    started = false;
    stopped = false;

    constructor(deps: ConnectionDeps) {
      this.deps = deps;
      fake.managers.push(this);
    }

    start() {
      this.started = true;
    }

    stop() {
      this.stopped = true;
    }
  },
}));

vi.mock("./terminals", () => ({
  setSinks: vi.fn(),
  resync: vi.fn(),
  cancelHistoryForService: vi.fn(),
  beginHistory: vi.fn(),
  finishHistory: vi.fn(),
  failHistory: vi.fn(),
  dispose: vi.fn(),
  writeHistory: vi.fn(),
  write: vi.fn(),
}));
vi.mock("./tauri", () => ({ isTauri: false }));
vi.mock("./tauriSocket", () => ({ makeTauriWsFactory: vi.fn() }));

import { useStore } from "../store/store";
import { ConnectionPool } from "./pool";

let pool: ConnectionPool | undefined;

beforeEach(() => {
  fake.managers = [];
  localStorage.clear();
  useStore.setState({ services: [] });
});

afterEach(() => {
  pool?.stop();
  pool = undefined;
});

describe("ConnectionPool service TAGs", () => {
  it("passes TAG into the connection manager and preserves direct configs", () => {
    useStore.getState().addService({
      id: "tagged",
      name: "Tagged",
      url: "http://same",
      token: "t",
      tag: "worker-A",
    });
    useStore.getState().addService({
      id: "direct",
      name: "Direct",
      url: "http://same",
      token: "t",
    });
    pool = new ConnectionPool();
    pool.start();

    expect(fake.managers.map((manager) => manager.deps.tag)).toEqual([
      "worker-A",
      undefined,
    ]);
  });

  it("stops and rebuilds a manager when its TAG identity changes", () => {
    useStore.getState().addService({
      id: "svc",
      name: "Service",
      url: "http://same",
      token: "t",
      tag: "worker-A",
    });
    pool = new ConnectionPool();
    pool.start();
    const first = fake.managers[0];

    useStore.setState((state) => ({
      services: state.services.map((service) => ({
        ...service,
        tag: "worker-B",
      })),
    }));

    expect(first.stopped).toBe(true);
    expect(fake.managers).toHaveLength(2);
    expect(fake.managers[1].deps.tag).toBe("worker-B");
    expect(fake.managers[1].started).toBe(true);
  });
});
