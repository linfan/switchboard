import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store/store";
import type { PortForward, Service } from "../store/types";
import {
  nativeConfig,
  PortForwardCoordinator,
  type PortForwardBridge,
} from "./portForwards";

const service: Service = {
  id: "s1",
  name: "Worker",
  url: "https://worker.test",
  token: "secret",
  certFingerprint: "aabb",
};

const forward: PortForward = {
  id: "f1",
  serviceId: service.id,
  localPort: 5433,
  remotePort: 5432,
  enabled: true,
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  useStore.setState({
    services: [],
    portForwards: [],
    portForwardRuntime: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nativeConfig", () => {
  it("derives native credentials from the service without persisting them in a mapping", () => {
    expect(nativeConfig(forward, service)).toEqual({
      id: "f1",
      localPort: 5433,
      remotePort: 5432,
      serviceUrl: "https://worker.test",
      token: "secret",
      certFingerprint: "aabb",
    });
  });
});

describe("PortForwardCoordinator", () => {
  it("starts enabled mappings, publishes native connection counts, and stops disabled mappings", async () => {
    const bridge: PortForwardBridge = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      list: vi.fn(async () => [
        {
          id: "f1",
          localPort: 5433,
          remotePort: 5432,
          activeConnections: 3,
          connected: true,
          lastError: null,
        },
      ]),
    };
    const coordinator = new PortForwardCoordinator({
      bridge,
      desktop: () => true,
      pollMs: 60_000,
    });
    const state = useStore.getState();
    state.addService(service);
    state.addPortForward(forward);

    coordinator.start();
    await settle();

    expect(bridge.start).toHaveBeenCalledWith(nativeConfig(forward, service));
    expect(useStore.getState().portForwardRuntime.f1).toEqual({
      status: "active",
      activeConnections: 3,
    });

    useStore.getState().updatePortForward("f1", { enabled: false });
    await settle();

    expect(bridge.stop).toHaveBeenCalledWith("f1");
    expect(useStore.getState().portForwardRuntime.f1).toEqual({
      status: "stopped",
      activeConnections: 0,
    });
    coordinator.stop();
  });

  it("stops a listener whose asynchronous startup outlives the coordinator", async () => {
    let resolveStarted = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveStart: (() => void) | undefined;
    const bridge: PortForwardBridge = {
      start: vi.fn(() => {
        resolveStarted();
        return new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
      }),
      stop: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    };
    const coordinator = new PortForwardCoordinator({
      bridge,
      desktop: () => true,
      pollMs: 60_000,
    });
    const state = useStore.getState();
    state.addService(service);
    state.addPortForward(forward);

    coordinator.start();
    await started;
    coordinator.stop();
    resolveStart?.();
    await settle();

    expect(bridge.stop).toHaveBeenCalledWith("f1");
  });

  it("marks mappings unavailable outside the desktop shell", async () => {
    const bridge: PortForwardBridge = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      list: vi.fn(async () => []),
    };
    const coordinator = new PortForwardCoordinator({
      bridge,
      desktop: () => false,
      pollMs: 60_000,
    });
    const state = useStore.getState();
    state.addService(service);
    state.addPortForward(forward);

    coordinator.start();
    await settle();

    expect(bridge.start).not.toHaveBeenCalled();
    expect(useStore.getState().portForwardRuntime.f1).toEqual({
      status: "unavailable",
      activeConnections: 0,
    });
    coordinator.stop();
  });

  it("reports a live listener with a dropped link as reconnecting and surfaces the error", async () => {
    const bridge: PortForwardBridge = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      list: vi.fn(async () => [
        {
          id: "f1",
          localPort: 5433,
          remotePort: 5432,
          activeConnections: 2,
          connected: false,
          lastError: "connect timed out after 10s",
        },
      ]),
    };
    const coordinator = new PortForwardCoordinator({
      bridge,
      desktop: () => true,
      pollMs: 60_000,
    });
    const state = useStore.getState();
    state.addService(service);
    state.addPortForward(forward);

    coordinator.start();
    await settle();

    expect(useStore.getState().portForwardRuntime.f1).toEqual({
      status: "reconnecting",
      activeConnections: 2,
      error: "connect timed out after 10s",
    });
    coordinator.stop();
  });
});
