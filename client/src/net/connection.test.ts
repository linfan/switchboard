import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerMsg } from "../protocol";
import type { ConnStatus } from "../store/types";
import {
  ConnectionManager,
  toWsUrl,
  type WebSocketLike,
} from "./connection";

/** In-memory WebSocket the tests drive by hand. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  static last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }
  sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  // --- test drivers ---
  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emitMessage(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  emitClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  parsed(): any[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  find(type: string): any {
    return this.parsed().find((m) => m.type === type);
  }
}

function mkManager(over: Partial<Parameters<typeof makeDeps>[0]> = {}) {
  const state = makeDeps(over);
  const mgr = new ConnectionManager(state.deps);
  return { mgr, ...state };
}

function makeDeps(over: {
  cursors?: Record<string, number>;
  now?: () => number;
}) {
  const messages: ServerMsg[] = [];
  const statuses: ConnStatus[] = [];
  const cursors = over.cursors ?? {};
  const deps = {
    clientId: "c1",
    url: "http://host:8787",
    token: "tok",
    getCursors: () => cursors,
    onMessage: (m: ServerMsg) => messages.push(m),
    onStatus: (s: ConnStatus) => statuses.push(s),
    wsFactory: (u: string) => new FakeSocket(u) as unknown as WebSocketLike,
    now: over.now ?? (() => 1000),
    reconnect: { baseDelayMs: 1000, factor: 2, jitter: 0, maxDelayMs: 30000 },
    heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
    wake: { checkMs: 2000, driftMs: 5000 },
  };
  return { deps, messages, statuses };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("toWsUrl", () => {
  it("maps http->ws and https->wss and appends token", () => {
    expect(toWsUrl("http://127.0.0.1:8787", "t k")).toBe(
      "ws://127.0.0.1:8787/ws?token=t%20k",
    );
    expect(toWsUrl("https://host/", "abc")).toBe("wss://host/ws?token=abc");
  });
});

describe("handshake", () => {
  it("connects, sends Hello with cursors, goes online", () => {
    const { mgr } = mkManager({ cursors: { t1: 5 } });
    mgr.start();
    expect(mgr.getStatus()).toBe("connecting");
    const s = FakeSocket.last();
    s.emitOpen();
    expect(mgr.getStatus()).toBe("online");
    expect(s.find("hello")).toEqual({
      type: "hello",
      client_id: "c1",
      cursors: { t1: 5 },
    });
    mgr.stop();
  });

  it("acks each message it receives", () => {
    const { mgr, messages } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen();
    s.emitMessage({
      type: "message",
      task_id: "t1",
      seq: 6,
      event: { kind: "assistant", text: "hi", raw: {} },
    });
    expect(messages).toHaveLength(1);
    expect(s.find("ack")).toEqual({ type: "ack", task_id: "t1", seq: 6 });
    mgr.stop();
  });
});

describe("auto-reconnect", () => {
  it("schedules a backoff reconnect after an unexpected close", () => {
    const { mgr } = mkManager();
    mgr.start();
    const s1 = FakeSocket.last();
    s1.emitOpen();
    s1.emitClose();
    expect(mgr.getStatus()).toBe("reconnecting");

    const count = FakeSocket.instances.length;
    // Nothing before the base delay.
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances.length).toBe(count);
    // Reconnect fires at baseDelayMs.
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(count + 1);
    mgr.stop();
  });

  it("grows the delay exponentially across consecutive failures", () => {
    const { mgr } = mkManager();
    mgr.start();
    FakeSocket.last().emitOpen();
    FakeSocket.last().emitClose(); // attempt 0 -> delay 1000
    vi.advanceTimersByTime(1000);
    // The reconnect opened a socket; fail it again before it opens.
    FakeSocket.last().emitClose(); // attempt 1 -> delay 2000
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances.length).toBe(count);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances.length).toBe(count + 1);
    mgr.stop();
  });

  it("manual reconnectNow opens immediately and resets backoff", () => {
    const { mgr } = mkManager();
    mgr.start();
    FakeSocket.last().emitOpen();
    FakeSocket.last().emitClose();
    const count = FakeSocket.instances.length;
    mgr.reconnectNow();
    expect(FakeSocket.instances.length).toBe(count + 1);
    expect(mgr.getStatus()).toBe("connecting");
    mgr.stop();
  });
});

describe("heartbeat", () => {
  it("declares the link dead when no Pong arrives", () => {
    const { mgr } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen();
    vi.advanceTimersByTime(15000); // ping
    expect(s.find("ping")).toBeTruthy();
    vi.advanceTimersByTime(10000); // pong deadline elapses
    expect(mgr.getStatus()).toBe("reconnecting");
    mgr.stop();
  });

  it("stays online when a Pong arrives in time", () => {
    const { mgr } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen();
    vi.advanceTimersByTime(15000);
    s.emitMessage({ type: "pong", ts: 1000 });
    vi.advanceTimersByTime(10000);
    expect(mgr.getStatus()).toBe("online");
    mgr.stop();
  });
});

describe("network + wake", () => {
  it("goes offline and suppresses reconnects on network down", () => {
    const { mgr } = mkManager();
    mgr.start();
    FakeSocket.last().emitOpen();
    mgr.notifyOffline();
    expect(mgr.getStatus()).toBe("offline");
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.instances.length).toBe(count); // no retry while offline
    mgr.notifyOnline();
    expect(FakeSocket.instances.length).toBe(count + 1); // reconnect on restore
    mgr.stop();
  });

  it("force-reconnects after a detected sleep gap", () => {
    let now = 1000;
    const { mgr } = mkManager({ now: () => now });
    mgr.start();
    const s1 = FakeSocket.last();
    s1.emitOpen();
    const count = FakeSocket.instances.length;
    // Simulate suspend: wall clock jumps far beyond the tick cadence.
    now = 1000 + 2000 + 6000; // elapsed 8000 > check(2000)+drift(5000)
    vi.advanceTimersByTime(2000); // fire one wake tick
    expect(FakeSocket.instances.length).toBe(count + 1);
    expect(FakeSocket.last()).not.toBe(s1);
    mgr.stop();
  });

  it("does not false-trigger sleep on normal ticks", () => {
    const { mgr } = mkManager(); // now is constant 1000
    mgr.start();
    FakeSocket.last().emitOpen();
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(20000); // many wake ticks, no clock drift
    expect(FakeSocket.instances.length).toBe(count);
    mgr.stop();
  });
});
