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
  tag: "worker-a",
  certFingerprint: "aabb",
};

const forward: PortForward = {
  id: "f1",
  serviceId: service.id,
  localPort: 5433,
  remoteHost: "127.0.0.1",
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
      remoteHost: "127.0.0.1",
      remotePort: 5432,
      serviceUrl: "https://worker.test",
      token: "secret",
      tag: "worker-a",
      certFingerprint: "aabb",
    });
  });

  it("passes a configured non-loopback remote host to the native listener", () => {
    expect(
      nativeConfig({ ...forward, remoteHost: "10.0.0.12" }, service).remoteHost,
    ).toBe("10.0.0.12");
  });

  it("keeps TAG absent for direct services", () => {
    expect(nativeConfig(forward, { ...service, tag: undefined }).tag).toBe(
      undefined,
    );
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

  it("stops and rebuilds the native session when the service TAG changes", async () => {
    const bridge: PortForwardBridge = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      list: vi.fn(async () => [
        {
          id: "f1",
          localPort: 5433,
          remotePort: 5432,
          activeConnections: 0,
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
    useStore.getState().addService(service);
    useStore.getState().addPortForward(forward);
    coordinator.start();
    await settle();

    useStore.setState((state) => ({
      services: state.services.map((item) => ({ ...item, tag: "worker-b" })),
    }));
    await settle();

    expect(bridge.stop).toHaveBeenCalledWith("f1");
    expect(bridge.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ tag: "worker-b" }),
    );
    coordinator.stop();
  });

  it("stops and rebuilds the native session when the remote host changes", async () => {
    const bridge: PortForwardBridge = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      list: vi.fn(async () => [
        {
          id: "f1",
          localPort: 5433,
          remotePort: 5432,
          activeConnections: 0,
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
    useStore.getState().addService(service);
    useStore.getState().addPortForward(forward);
    coordinator.start();
    await settle();

    useStore.getState().updatePortForward("f1", { remoteHost: "10.0.0.12" });
    await settle();

    expect(bridge.stop).toHaveBeenCalledWith("f1");
    expect(bridge.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ remoteHost: "10.0.0.12" }),
    );
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
