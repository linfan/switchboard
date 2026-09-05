import { useStore } from "../store/store";
import type { PortForward, PortForwardRuntime, Service } from "../store/types";
import { invoke, isTauri } from "./tauri";

const POLL_MS = 2000;

export interface NativePortForwardConfig {
  id: string;
  localPort: number;
  remotePort: number;
  serviceUrl: string;
  token: string;
  certFingerprint?: string;
}

export interface NativePortForwardStatus {
  id: string;
  localPort: number;
  remotePort: number;
  activeConnections: number;
}

export interface PortForwardBridge {
  start(config: NativePortForwardConfig): Promise<void>;
  stop(id: string): Promise<void>;
  list(): Promise<NativePortForwardStatus[]>;
}

const nativeBridge: PortForwardBridge = {
  start: (config) => invoke("start_port_forward", { config }),
  stop: (id) => invoke("stop_port_forward", { id }),
  list: () => invoke("list_port_forwards"),
};

export function nativeConfig(
  forward: PortForward,
  service: Service,
): NativePortForwardConfig {
  return {
    id: forward.id,
    localPort: forward.localPort,
    remotePort: forward.remotePort,
    serviceUrl: service.url,
    token: service.token,
    certFingerprint: service.certFingerprint,
  };
}

function configKey(forward: PortForward, service: Service): string {
  return [
    forward.localPort,
    forward.remotePort,
    service.url,
    service.token,
    service.certFingerprint ?? "",
  ].join(" ");
}

function unavailable(): PortForwardRuntime {
  return { status: "unavailable", activeConnections: 0 };
}

interface CoordinatorDeps {
  bridge: PortForwardBridge;
  desktop: () => boolean;
  pollMs: number;
}

export class PortForwardCoordinator {
  private readonly bridge: PortForwardBridge;
  private readonly desktop: () => boolean;
  private readonly pollMs: number;
  private active = new Map<string, string>();
  private unsub: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private syncing = false;
  private resync = false;

  constructor({
    bridge = nativeBridge,
    desktop = () => isTauri,
    pollMs = POLL_MS,
  }: Partial<CoordinatorDeps> = {}) {
    this.bridge = bridge;
    this.desktop = desktop;
    this.pollMs = pollMs;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.requestSync();
    this.unsub = useStore.subscribe((state, previous) => {
      if (
        state.portForwards !== previous.portForwards ||
        state.services !== previous.services
      ) {
        this.requestSync();
      }
    });
    this.poll = setInterval(() => void this.refresh(), this.pollMs);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.unsub?.();
    this.unsub = null;
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
    const ids = [...this.active.keys()];
    this.active.clear();
    if (this.desktop()) void Promise.all(ids.map((id) => this.bridge.stop(id)));
  }

  private requestSync(): void {
    if (!this.started) return;
    if (this.syncing) {
      this.resync = true;
      return;
    }
    void this.sync();
  }

  private async sync(): Promise<void> {
    this.syncing = true;
    do {
      this.resync = false;
      await this.syncOnce();
    } while (this.resync && this.started);
    this.syncing = false;
  }

  private async syncOnce(): Promise<void> {
    if (!this.started) return;
    const { portForwards, services } = useStore.getState();
    if (!this.desktop()) {
      for (const forward of portForwards) {
        useStore.getState().setPortForwardRuntime(forward.id, unavailable());
      }
      return;
    }

    const servicesById = new Map(
      services.map((service) => [service.id, service]),
    );
    const desired = new Map<
      string,
      { forward: PortForward; service: Service; key: string }
    >();
    for (const forward of portForwards) {
      const service = servicesById.get(forward.serviceId);
      if (forward.enabled && service) {
        desired.set(forward.id, {
          forward,
          service,
          key: configKey(forward, service),
        });
      } else {
        useStore.getState().setPortForwardRuntime(forward.id, {
          status: "stopped",
          activeConnections: 0,
        });
      }
    }

    for (const [id, key] of this.active) {
      const next = desired.get(id);
      if (next && next.key === key) continue;
      try {
        await this.bridge.stop(id);
      } catch {
        // A missing native listener is already stopped for reconciliation purposes.
      }
      if (!this.started) return;
      this.active.delete(id);
    }

    for (const [id, target] of desired) {
      if (!this.started) return;
      if (this.active.has(id)) continue;
      useStore.getState().setPortForwardRuntime(id, {
        status: "starting",
        activeConnections: 0,
      });
      try {
        await this.bridge.start(nativeConfig(target.forward, target.service));
        if (!this.started) {
          try {
            await this.bridge.stop(id);
          } catch {
            // The listener may already have been stopped during shutdown.
          }
          return;
        }
        this.active.set(id, target.key);
        useStore.getState().setPortForwardRuntime(id, {
          status: "active",
          activeConnections: 0,
        });
      } catch (error) {
        useStore.getState().setPortForwardRuntime(id, {
          status: "error",
          activeConnections: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.refresh();
  }

  private async refresh(): Promise<void> {
    if (!this.started || !this.desktop()) return;
    let statuses: NativePortForwardStatus[];
    try {
      statuses = await this.bridge.list();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const id of this.active.keys()) {
        useStore.getState().setPortForwardRuntime(id, {
          status: "error",
          activeConnections: 0,
          error: message,
        });
      }
      return;
    }

    const byId = new Map(statuses.map((status) => [status.id, status]));
    let restart = false;
    for (const [id] of this.active) {
      const status = byId.get(id);
      if (!status) {
        this.active.delete(id);
        useStore.getState().setPortForwardRuntime(id, {
          status: "stopped",
          activeConnections: 0,
        });
        restart = true;
        continue;
      }
      useStore.getState().setPortForwardRuntime(id, {
        status: "active",
        activeConnections: status.activeConnections,
      });
    }
    if (restart) this.requestSync();
  }
}

export const portForwards = new PortForwardCoordinator();
