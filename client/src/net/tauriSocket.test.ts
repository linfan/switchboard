//! Outbound ordering on the webview → Rust IPC hop.
//!
//! Every keystroke the terminal emits becomes one `invoke("ws_send", ...)`.
//! Tauri runs each invocation as its own task on a multi-threaded runtime, and
//! the webview issues each one as an independent `fetch`, so neither hop
//! preserves dispatch order. `TauriWebSocket.send` therefore chains them, and
//! these tests hold that chain to its contract. The Rust-side counterpart —
//! which shows the reorder is real, at ~63% of adjacent pairs over 4000 frames —
//! lives in `src-tauri/tests/ws_send_order.rs`.

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WebSocketLike } from "./connection";
import { makeTauriWsFactory } from "./tauriSocket";

/**
 * Handle on the mocked IPC bridge. `vi.hoisted` because the `vi.mock` factory
 * below is hoisted above ordinary imports and still needs to close over it.
 */
const bridge = vi.hoisted(() => ({
  handler: null as
    | null
    | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock("./tauri", () => ({
  isTauri: true,
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    bridge.handler
      ? bridge.handler(cmd, args)
      : Promise.reject(new Error(`unhandled invoke: ${cmd}`)),
  listen: () => Promise.resolve(() => {}),
  assetUrl: (p: string) => Promise.resolve(`asset://localhost/${p}`),
}));

// Imported lazily by `connect()` to build the inbound frame channel.
vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: ((msg: T) => void) | null = null;
  }
  return { Channel };
});

const CONN_ID = 7;
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** One issued invocation whose completion the test controls. */
interface Gate {
  args?: Record<string, unknown>;
  resolve: (value?: unknown) => void;
  reject: (e: unknown) => void;
}

let connect: Gate | null = null;
let sends: Gate[] = [];
let closes: Array<Record<string, unknown> | undefined> = [];
/** How `ws_send` behaves; swapped per test via the helpers below. */
let wsSend: (args?: Record<string, unknown>) => Promise<unknown>;

/** Never completes on its own, so "how many are in flight" is observable. */
function gatedSends(): void {
  wsSend = (args) =>
    new Promise<unknown>((resolve, reject) => {
      sends.push({ args, resolve, reject });
    });
}

/** Completes immediately, so a whole burst drains through the chain. */
function autoSends(): void {
  wsSend = (args) => {
    sends.push({ args, resolve: () => {}, reject: () => {} });
    return Promise.resolve(undefined);
  };
}

/** Rejects — what `net.rs` returns once the connection id is gone. */
function failingSends(): void {
  wsSend = (args) => {
    sends.push({ args, resolve: () => {}, reject: () => {} });
    return Promise.reject(new Error(`connection ${CONN_ID} is closed`));
  };
}

function sentTexts(): unknown[] {
  return sends.map((s) => s.args?.text);
}

beforeEach(() => {
  connect = null;
  sends = [];
  closes = [];
  gatedSends();
  bridge.handler = (cmd, args) => {
    switch (cmd) {
      case "ws_connect":
        return new Promise<unknown>((resolve, reject) => {
          connect = { args, resolve, reject };
        });
      case "ws_send":
        return wsSend(args);
      case "ws_close":
        closes.push(args);
        return Promise.resolve(undefined);
      case "frontend_log":
        return Promise.resolve(undefined);
      default:
        return Promise.reject(new Error(`unexpected invoke: ${cmd}`));
    }
  };
});

/** Let every pending microtask and dynamic import settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Open a socket and drive it to OPEN, as `ConnectionManager.open` would. */
async function openSocket(): Promise<WebSocketLike> {
  const ws = makeTauriWsFactory("ab".repeat(32))("wss://host/ws");
  await settle();
  expect(connect, "ws_connect was never issued").not.toBeNull();
  connect!.resolve(CONN_ID);
  await settle();
  expect(ws.readyState).toBe(OPEN);
  return ws;
}

describe("outbound serialization", () => {
  it("holds a single ws_send in flight so frames cannot overtake each other", async () => {
    const ws = await openSocket();

    ws.send("a");
    ws.send("b");
    ws.send("c");
    // Each chain link runs on a microtask, so let the first one start.
    await settle();
    // Fire-and-forget invokes would all three be on the bridge by now, and their
    // completion order would then be up to the scheduler.
    expect(sends).toHaveLength(1);
    expect(sends[0].args).toMatchObject({ id: CONN_ID, text: "a", binaryB64: null });

    sends[0].resolve();
    await settle();
    expect(sends).toHaveLength(2);
    expect(sends[1].args).toMatchObject({ id: CONN_ID, text: "b" });

    sends[1].resolve();
    await settle();
    expect(sends).toHaveLength(3);
    expect(sends[2].args).toMatchObject({ id: CONN_ID, text: "c" });
  });

  it("keeps a typed burst in order all the way to the bridge", async () => {
    autoSends();
    const ws = await openSocket();

    const typed = "ls -la && git status\r".split("");
    for (const ch of typed) ws.send(ch);
    await settle();

    expect(sentTexts()).toEqual(typed);
  });

  it("base64-encodes binary frames for the JSON IPC args", async () => {
    const ws = await openSocket();

    ws.send(new Uint8Array([0x10, 0x11]));
    await settle();

    expect(sends[0].args).toMatchObject({ id: CONN_ID, text: null, binaryB64: "EBE=" });
  });

  it("drops sends issued after close()", async () => {
    const ws = await openSocket();

    ws.close();
    ws.send("a");
    await settle();

    expect(sends).toHaveLength(0);
  });
});

describe("send failure", () => {
  it("reports a rejected ws_send as a close so the manager reconnects at once", async () => {
    failingSends();
    const ws = await openSocket();
    let closed = 0;
    ws.onclose = () => {
      closed += 1;
    };

    ws.send("a");
    await settle();

    // Rust drops the connection id the moment the socket dies, but our
    // readyState would otherwise stay OPEN until the close frame round-trips —
    // during which every keystroke is silently discarded.
    expect(ws.readyState).toBe(CLOSED);
    expect(closed).toBe(1);
  });

  it("keeps sending after a rejection instead of stalling forever", async () => {
    failingSends();
    const ws = await openSocket();

    ws.send("a");
    await settle();
    expect(sends).toHaveLength(1);

    // A handler attached outside the chain link would let this rejection poison
    // it, and every keystroke after the first would silently no-op forever.
    ws.send("b");
    await settle();
    expect(sends, "the rejected send poisoned the chain").toHaveLength(2);
    expect(sends[1].args).toMatchObject({ text: "b" });
  });

  it("keeps the chain usable across a mid-burst failure", async () => {
    autoSends();
    const ws = await openSocket();
    ws.send("a");
    ws.send("b");
    await settle();
    expect(sentTexts()).toEqual(["a", "b"]);

    failingSends();
    ws.send("c");
    await settle();
    expect(ws.readyState).toBe(CLOSED);

    autoSends();
    ws.send("d");
    await settle();
    expect(sentTexts()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("connect lifecycle", () => {
  it("does not report OPEN before the connection id is known", async () => {
    // ConnectionManager writes only to an OPEN *and* authenticated socket, so a
    // frame can never reach `send()` while `id` is still null — which is why
    // this class needs no outbound queue to buffer pre-open frames.
    const ws = makeTauriWsFactory()("wss://host/ws");
    await settle();

    expect(connect, "ws_connect was never issued").not.toBeNull();
    expect(ws.readyState).toBe(CONNECTING);

    connect!.resolve(CONN_ID);
    await settle();
    expect(ws.readyState).toBe(OPEN);
  });

  it("closes a socket whose connect resolved after close()", async () => {
    const ws = makeTauriWsFactory()("wss://host/ws");
    await settle();

    ws.close();
    // No id yet, so there is nothing to close on the Rust side.
    expect(closes).toHaveLength(0);

    connect!.resolve(CONN_ID);
    await settle();
    expect(closes).toEqual([{ id: CONN_ID }]);
  });

  it("reports a failed connect as error + close and never opens", async () => {
    const ws = makeTauriWsFactory()("wss://host/ws");
    await settle();
    let errored = 0;
    let closed = 0;
    ws.onerror = () => {
      errored += 1;
    };
    ws.onclose = () => {
      closed += 1;
    };

    connect!.reject(new Error("tls pin mismatch"));
    await settle();

    expect(ws.readyState).toBe(CLOSED);
    expect(errored).toBe(1);
    expect(closed).toBe(1);
    expect(sends).toHaveLength(0);
  });
});
