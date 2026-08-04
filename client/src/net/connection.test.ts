import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerMsg } from "../protocol";
import type { ConnStatus } from "../store/types";
import {
  ConnectionManager,
  toWsUrl,
  type WebSocketLike,
} from "./connection";

// WebCrypto (crypto.subtle) resolves on the libuv threadpool, not a timer or a
// microtask, so it never settles under vitest fake timers via
// `advanceTimersByTimeAsync`. Capture the real setTimeout before faking and
// yield to a genuine macrotask to let the handshake HMAC complete.
const realSetTimeout = globalThis.setTimeout;
function settleCrypto(): Promise<void> {
  return new Promise((r) => realSetTimeout(r, 0));
}

/** In-memory WebSocket the tests drive by hand. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  static last(): FakeSocket {
    return FakeSocket.instances[FakeSocket.instances.length - 1];
  }
  sent: string[] = [];
  sentBinary: Uint8Array[] = [];
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") this.sent.push(data);
    else if (data instanceof Uint8Array) this.sentBinary.push(data);
    else if (ArrayBuffer.isView(data)) {
      const v = data as ArrayBufferView;
      this.sentBinary.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    } else this.sentBinary.push(new Uint8Array(data as ArrayBufferLike));
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
  emitBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
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

/**
 * Drive the SWB-WS-v1 handshake to completion: open, answer the server's
 * challenge, and accept. `auth_ok` is applied synchronously, so afterwards the
 * manager is online with the heartbeat running. The interleaved
 * `advanceTimersByTimeAsync(0)` lets the async WebCrypto HMAC settle.
 */
async function driveHandshake(s: FakeSocket): Promise<void> {
  s.emitOpen();
  s.emitMessage({ type: "auth_challenge", server_nonce: "11".repeat(32) });
  await settleCrypto();
  s.emitMessage({ type: "auth_ok" });
}

function makeDeps(over: {
  cursors?: Record<string, number>;
  now?: () => number;
  wake?: { checkMs: number; driftMs: number };
  heartbeat?: { intervalMs: number; timeoutMs: number };
}) {
  const messages: ServerMsg[] = [];
  const binaries: Uint8Array[] = [];
  const statuses: ConnStatus[] = [];
  const cursors = over.cursors ?? {};
  const deps = {
    clientId: "c1",
    url: "http://host:8787",
    token: "tok",
    getCursors: () => cursors,
    onMessage: (m: ServerMsg) => messages.push(m),
    onBinary: (b: Uint8Array) => binaries.push(b),
    onStatus: (s: ConnStatus) => statuses.push(s),
    wsFactory: (u: string) => new FakeSocket(u) as unknown as WebSocketLike,
    now: over.now ?? (() => 1000),
    reconnect: { baseDelayMs: 1000, factor: 2, jitter: 0, maxDelayMs: 30000 },
    heartbeat: over.heartbeat ?? { intervalMs: 15000, timeoutMs: 10000 },
    wake: over.wake ?? { checkMs: 2000, driftMs: 5000 },
  };
  return { deps, messages, binaries, statuses };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("toWsUrl", () => {
  it("maps http->ws and https->wss with no token in the URL", () => {
    expect(toWsUrl("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/ws");
    expect(toWsUrl("https://host/")).toBe("wss://host/ws");
  });
});

describe("handshake", () => {
  it("stays connecting until the auth handshake completes", async () => {
    const { mgr } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen();
    // No Hello and not online until the challenge is answered and accepted.
    expect(mgr.getStatus()).toBe("connecting");
    expect(s.find("hello")).toBeUndefined();
    s.emitMessage({ type: "auth_challenge", server_nonce: "11".repeat(32) });
    await settleCrypto();
    expect(s.find("auth_response")).toMatchObject({
      type: "auth_response",
      client_nonce: expect.any(String),
      mac: expect.any(String),
    });
    expect(mgr.getStatus()).toBe("connecting"); // still awaiting auth_ok
    s.emitMessage({ type: "auth_ok" });
    expect(mgr.getStatus()).toBe("online");
    mgr.stop();
  });

  it("connects, sends Hello with cursors, goes online", async () => {
    const { mgr } = mkManager({ cursors: { t1: 5 } });
    mgr.start();
    expect(mgr.getStatus()).toBe("connecting");
    const s = FakeSocket.last();
    await driveHandshake(s);
    expect(mgr.getStatus()).toBe("online");
    expect(s.find("hello")).toEqual({
      type: "hello",
      client_id: "c1",
      cursors: { t1: 5 },
    });
    mgr.stop();
  });

  it("reconnects when the server rejects the handshake", async () => {
    const { mgr } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen();
    const count = FakeSocket.instances.length;
    s.emitMessage({ type: "auth_error", message: "bad token" });
    expect(mgr.getStatus()).toBe("reconnecting");
    expect(s.find("hello")).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances.length).toBe(count + 1);
    mgr.stop();
  });

  it("sets binaryType to arraybuffer on the socket", () => {
    const { mgr } = mkManager();
    mgr.start();
    expect(FakeSocket.last().binaryType).toBe("arraybuffer");
    mgr.stop();
  });

  it("delivers binary data-plane frames via onBinary", () => {
    const { mgr, binaries, messages } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen();
    s.emitBinary(new Uint8Array([1, 2, 3, 4]));
    expect(messages).toHaveLength(0);
    expect(binaries).toHaveLength(1);
    expect(Array.from(binaries[0])).toEqual([1, 2, 3, 4]);
    mgr.stop();
  });

  it("sends raw bytes over the socket via sendBytes", () => {
    const { mgr } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen();
    expect(mgr.sendBytes(new Uint8Array([9, 8, 7]))).toBe(true);
    expect(s.sentBinary).toHaveLength(1);
    expect(Array.from(s.sentBinary[0])).toEqual([9, 8, 7]);
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
  it("declares the link dead when no Pong arrives", async () => {
    const { mgr } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    await driveHandshake(s);
    vi.advanceTimersByTime(15000); // ping
    expect(s.find("ping")).toBeTruthy();
    vi.advanceTimersByTime(10000); // pong deadline elapses
    expect(mgr.getStatus()).toBe("reconnecting");
    mgr.stop();
  });

  it("fully tears down the socket on heartbeat timeout so it can't double-deliver", async () => {
    // Regression: a pong timeout must detach the dead socket's handlers and
    // close it, not just drop the reference. A live-but-orphaned socket keeps
    // its onmessage bound to the manager and would deliver a second copy of
    // every server frame into the same terminal after reconnect (doubled output
    // / keystroke echo).
    const { mgr, binaries } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    await driveHandshake(s);
    vi.advanceTimersByTime(15000); // ping
    vi.advanceTimersByTime(10000); // pong deadline elapses -> declared dead
    expect(mgr.getStatus()).toBe("reconnecting");
    expect(s.readyState).toBe(3); // closed
    expect(s.onmessage).toBeNull(); // handler detached
    // A frame arriving on the orphaned socket must not reach onBinary.
    s.onmessage?.({ data: new Uint8Array([1, 2, 3]).buffer });
    expect(binaries).toHaveLength(0);
    mgr.stop();
  });

  it("stays online when a Pong arrives in time", async () => {
    const { mgr } = mkManager();
    mgr.start();
    const s = FakeSocket.last();
    await driveHandshake(s);
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

  it("leaves an in-flight handshake alone on a wake gap", async () => {
    // A busy main thread (another service's replay burst) produces the same
    // clock gap as a sleep. A socket that is open but not yet authenticated is
    // presumed to be waiting on the thread, not dead: don't abort its handshake
    // here — the handshake watchdog owns that decision.
    let now = 1000;
    const { mgr } = mkManager({ now: () => now });
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen(); // open, mid-handshake
    const count = FakeSocket.instances.length;
    now = 1000 + 2000 + 6000; // elapsed 8000 > check(2000)+drift(5000)
    vi.advanceTimersByTime(2000); // fire one wake tick
    expect(FakeSocket.instances.length).toBe(count); // handshake not aborted
    expect(FakeSocket.last()).toBe(s);
    // The delayed handshake still completes on the very same socket.
    s.emitMessage({ type: "auth_challenge", server_nonce: "11".repeat(32) });
    await settleCrypto();
    s.emitMessage({ type: "auth_ok" });
    expect(mgr.getStatus()).toBe("online");
    mgr.stop();
  });

  it("does not false-trigger sleep on normal ticks", async () => {
    const { mgr } = mkManager(); // now is constant 1000
    mgr.start();
    await driveHandshake(FakeSocket.last());
    const count = FakeSocket.instances.length;
    vi.advanceTimersByTime(14000); // many wake ticks, no clock drift, no ping
    expect(FakeSocket.instances.length).toBe(count);
    mgr.stop();
  });

  it("wake gap probes a live authed socket instead of tearing it down", async () => {
    // A blocked main thread (e.g. a large replay burst) produces the same clock
    // gap as a real sleep. On a healthy authed socket we must probe, not
    // reconnect — reconnecting would re-replay and block the thread again.
    let now = 1000;
    const { mgr } = mkManager({ now: () => now });
    mgr.start();
    const s = FakeSocket.last();
    await driveHandshake(s);
    const count = FakeSocket.instances.length;
    now = 1000 + 2000 + 6000; // elapsed 8000 > check(2000)+drift(5000)
    vi.advanceTimersByTime(2000); // fire one wake tick
    expect(FakeSocket.instances.length).toBe(count); // no reconnect
    expect(FakeSocket.last()).toBe(s); // same socket, untouched
    expect(s.find("ping")).toBeTruthy(); // probed instead
    s.emitMessage({ type: "pong", ts: now }); // probe answered
    expect(mgr.getStatus()).toBe("online");
    mgr.stop();
  });
});

describe("handshake watchdog", () => {
  it("reconnects a handshake that never completes", () => {
    let now = 1000;
    const { mgr } = mkManager({ now: () => now });
    mgr.start();
    const s1 = FakeSocket.last();
    s1.emitOpen(); // open, but auth_challenge never arrives
    const count = FakeSocket.instances.length;
    // Deadline passes with the clock advancing normally (thread not blocked):
    // the socket is genuinely stuck/dead, so drop it and back off.
    now = 1000 + 10000 + 1;
    vi.advanceTimersByTime(10000); // fire the handshake watchdog
    expect(mgr.getStatus()).toBe("reconnecting");
    vi.advanceTimersByTime(1000); // backoff reconnect fires
    expect(FakeSocket.instances.length).toBe(count + 1);
    expect(FakeSocket.last()).not.toBe(s1);
    mgr.stop();
  });

  it("re-arms instead of tearing down when the timer fired late", async () => {
    // The watchdog timer running far past its deadline means the main thread was
    // blocked, not that the socket is dead — re-arm and let the queued handshake
    // finish rather than reconnecting (which would re-replay and re-block).
    let now = 1000;
    const { mgr } = mkManager({ now: () => now });
    mgr.start();
    const s = FakeSocket.last();
    s.emitOpen();
    const count = FakeSocket.instances.length;
    now = 1000 + 10000 + 6000; // 6s past deadline > drift(5000)
    vi.advanceTimersByTime(10000); // fire the watchdog
    expect(FakeSocket.instances.length).toBe(count); // not torn down
    expect(FakeSocket.last()).toBe(s); // same socket
    expect(mgr.getStatus()).not.toBe("reconnecting");
    // The delayed handshake completes on the same socket.
    s.emitMessage({ type: "auth_challenge", server_nonce: "11".repeat(32) });
    await settleCrypto();
    s.emitMessage({ type: "auth_ok" });
    expect(mgr.getStatus()).toBe("online");
    mgr.stop();
  });
});

describe("starvation-safe heartbeat", () => {
  it("re-probes instead of dying when the pong timer fires late", async () => {
    // Wake watchdog disabled so only the heartbeat timers fire here.
    let now = 0;
    const { mgr } = mkManager({
      now: () => now,
      wake: { checkMs: 10_000_000, driftMs: 5000 },
      heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
    });
    mgr.start();
    const s = FakeSocket.last();
    await driveHandshake(s);
    now = 15000;
    vi.advanceTimersByTime(15000); // heartbeat ping; pong deadline = 25000
    const ping = (): number =>
      s.parsed().filter((m) => m.type === "ping").length;
    expect(ping()).toBe(1);
    // The main thread was blocked: the pong timer runs 6s past its deadline.
    now = 25000 + 6000;
    vi.advanceTimersByTime(10000); // fire the pong timer at sim-time 25000
    expect(mgr.getStatus()).toBe("online"); // re-probed, not torn down
    expect(ping()).toBe(2);
    mgr.stop();
  });
});
