#!/usr/bin/env node
// End-to-end test of the full stack: a real server binary supervising a real
// (fake) agent process, driven by real WebSocket clients. Proves the crown-jewel
// guarantee: after a disconnect, a reconnecting client receives EXACTLY the
// messages it missed — gap-free, no loss, no duplicates.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.AGENT_MANAGE_BIN ??
  resolve(HERE, "..", "target", "debug", "agent-manage-server");
const FAKE_AGENT_DIR = join(HERE, "fake-agent");

const ADDR = "127.0.0.1:8799";
const TOKEN = "e2e-token";
const HTTP = `http://${ADDR}`;
const WS_URL = `ws://${ADDR}/ws?token=${TOKEN}`;

const dbDir = mkdtempSync(join(tmpdir(), "agent-manage-e2e-"));
const serverLog = [];

function log(...a) {
  console.log("[e2e]", ...a);
}
function fail(msg) {
  console.error("\n[e2e] FAILED:", msg);
  console.error("[e2e] --- server output (tail) ---");
  console.error(serverLog.slice(-40).join("\n"));
  process.exitCode = 1;
  throw new Error(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function eq(a, b, msg) {
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  if (as !== bs) fail(`${msg}: expected ${bs}, got ${as}`);
}

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.msgs = [];
    this.pending = [];
    this.opened = new Promise((res, rej) => {
      this.ws.on("open", res);
      this.ws.on("error", rej);
    });
    this.ws.on("message", (data) => {
      this.msgs.push(JSON.parse(data.toString()));
      this.pending = this.pending.filter((p) => {
        if (p.pred()) {
          p.res();
          return false;
        }
        return true;
      });
    });
  }
  open() {
    return this.opened;
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  close() {
    return new Promise((res) => {
      this.ws.on("close", res);
      this.ws.close();
    });
  }
  waitUntil(pred, desc, timeout = 10000) {
    return new Promise((res, rej) => {
      if (pred()) return res();
      const p = { pred, res };
      this.pending.push(p);
      setTimeout(() => {
        this.pending = this.pending.filter((x) => x !== p);
        rej(new Error(`timeout waiting for ${desc}`));
      }, timeout);
    });
  }
  seqsFor(taskId) {
    return this.msgs
      .filter((m) => m.type === "message" && m.task_id === taskId)
      .map((m) => m.seq);
  }
  has(pred) {
    return this.msgs.some(pred);
  }
}

function startServer() {
  const child = spawn(BIN, [], {
    env: {
      ...process.env,
      AGENT_MANAGE_ADDR: ADDR,
      AGENT_MANAGE_TOKEN: TOKEN,
      AGENT_MANAGE_DB: join(dbDir, "e2e.db"),
      AGENT_MANAGE_NAME: "e2e-host",
      AGENT_MANAGE_PERMISSION_MODE: "default",
      RUST_LOG: "info",
      PATH: `${FAKE_AGENT_DIR}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => serverLog.push(d.toString().trimEnd()));
  child.stderr.on("data", (d) => serverLog.push(d.toString().trimEnd()));
  return child;
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${HTTP}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  fail("server did not become healthy in time");
}

async function main() {
  log(`server binary: ${BIN}`);
  const server = startServer();
  try {
    await waitForHealth();
    log("server healthy");

    // 1. First client: handshake + create a task.
    const c1 = new Client(WS_URL);
    await c1.open();
    c1.send({ type: "hello", client_id: "c1", cursors: {} });
    await c1.waitUntil(() => c1.has((m) => m.type === "welcome"), "c1 welcome");
    log("c1 welcomed");

    c1.send({
      type: "create_task",
      tool: "claude",
      title: "E2E",
      cwd: null,
      initial_prompt: null,
    });
    await c1.waitUntil(
      () => c1.has((m) => m.type === "task_created"),
      "task_created",
    );
    const taskId = c1.msgs.find((m) => m.type === "task_created").task.id;
    log(`task created: ${taskId}`);

    // 2. Two user turns -> 4 sequenced messages (echo + reply each).
    c1.send({ type: "user_input", task_id: taskId, text: "m1" });
    await c1.waitUntil(() => c1.seqsFor(taskId).length >= 2, "m1 round-trip");
    c1.send({ type: "user_input", task_id: taskId, text: "m2" });
    await c1.waitUntil(() => c1.seqsFor(taskId).length >= 4, "m2 round-trip");

    const seqs = c1.seqsFor(taskId);
    eq(seqs, [1, 2, 3, 4], "c1 must see gap-free seq 1..4");
    const cursor = Math.max(...seqs);
    log(`c1 durably applied up to seq ${cursor}`);

    // 3. Drop c1 (simulate network loss / app close).
    await c1.close();
    log("c1 disconnected");

    // 4. While c1 is gone, another client drives more output on the same task.
    const c2 = new Client(WS_URL);
    await c2.open();
    c2.send({ type: "hello", client_id: "c2", cursors: {} });
    await c2.waitUntil(() => c2.has((m) => m.type === "welcome"), "c2 welcome");
    c2.send({ type: "user_input", task_id: taskId, text: "m3" });
    await c2.waitUntil(
      () =>
        c2.seqsFor(taskId).includes(cursor + 1) &&
        c2.seqsFor(taskId).includes(cursor + 2),
      "m3 produced while c1 offline",
    );
    log(`produced seq ${cursor + 1}, ${cursor + 2} while c1 offline`);

    // 5. Reconnect c1 with its durable cursor. It MUST replay only the missed
    //    messages, gap-free, nothing at or below the cursor.
    const c1b = new Client(WS_URL);
    await c1b.open();
    c1b.send({ type: "hello", client_id: "c1", cursors: { [taskId]: cursor } });
    await c1b.waitUntil(
      () => c1b.has((m) => m.type === "replay_done" && m.task_id === taskId),
      "c1 reconnect replay_done",
    );
    const replayed = c1b.seqsFor(taskId);
    eq(
      replayed,
      [cursor + 1, cursor + 2],
      "reconnect must replay exactly the missed messages",
    );
    assert(
      replayed.every((s) => s > cursor),
      "no message at or below the cursor may be replayed",
    );
    log(`reconnect replayed exactly [${replayed.join(", ")}] — no loss, no dupes`);

    // 6. Terminate the task and observe the terminal state.
    c1b.send({ type: "terminate_task", task_id: taskId });
    await c1b.waitUntil(
      () =>
        c1b.has(
          (m) =>
            m.type === "task_state" &&
            m.task_id === taskId &&
            m.status.state === "terminated",
        ),
      "task terminated",
    );
    log("task terminated");

    await c1b.close();
    await c2.close();
    log("ALL CHECKS PASSED");
  } finally {
    server.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error("[e2e]", e.message);
  process.exit(1);
});
