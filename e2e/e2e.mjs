#!/usr/bin/env node
// End-to-end test of the full v2 stack: a real server binary supervising a real
// (fake) agent on a PTY, driven by real WebSocket clients speaking the hybrid
// transport (JSON control plane + binary data plane). Proves the crown-jewel
// guarantee: after a disconnect, a reconnecting client is fast-forwarded EXACTLY
// the terminal bytes it missed — gap-free, nothing at or below its cursor.
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

// --- binary data-plane codec (mirror of shared/src/frame.rs) ----------------
const KIND_OUTPUT = 0x01;
const KIND_SNAPSHOT = 0x02;
const KIND_INPUT = 0x10;

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToUuid(buf) {
  const h = Buffer.from(buf).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function decodeFrame(buf) {
  const kind = buf[0];
  if (kind === KIND_OUTPUT || kind === KIND_SNAPSHOT) {
    const taskId = bytesToUuid(buf.subarray(1, 17));
    const seq = buf.readUInt32BE(17) * 2 ** 32 + buf.readUInt32BE(21);
    const data = buf.subarray(25);
    return { kind: kind === KIND_OUTPUT ? "output" : "snapshot", taskId, seq, data };
  }
  return null; // client never receives INPUT frames
}
function encodeInput(taskId, text) {
  return Buffer.concat([Buffer.from([KIND_INPUT]), uuidToBytes(taskId), Buffer.from(text)]);
}

class Client {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.text = [];
    this.frames = [];
    this.pending = [];
    this.opened = new Promise((res, rej) => {
      this.ws.on("open", res);
      this.ws.on("error", rej);
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) {
        const f = decodeFrame(data);
        if (f) this.frames.push(f);
      } else {
        this.text.push(JSON.parse(data.toString()));
      }
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
  sendInput(taskId, text) {
    this.ws.send(encodeInput(taskId, text));
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
  hasText(pred) {
    return this.text.some(pred);
  }
  dataFrames(taskId) {
    return this.frames.filter((f) => f.taskId === taskId);
  }
  seqs(taskId) {
    return this.dataFrames(taskId).map((f) => f.seq);
  }
  maxSeq(taskId) {
    const s = this.seqs(taskId);
    return s.length ? Math.max(...s) : 0;
  }
  // Concatenated bytes of all data-plane frames for a task, as text.
  screen(taskId) {
    return Buffer.concat(this.dataFrames(taskId).map((f) => Buffer.from(f.data))).toString(
      "utf8",
    );
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

    // 1. First client: handshake + create an interactive PTY task.
    const c1 = new Client(WS_URL);
    await c1.open();
    c1.send({ type: "hello", client_id: "c1", cursors: {} });
    await c1.waitUntil(() => c1.hasText((m) => m.type === "welcome"), "c1 welcome");
    log("c1 welcomed");

    c1.send({
      type: "create_task",
      tool: "claude",
      title: "E2E",
      cwd: null,
      cols: 80,
      rows: 24,
    });
    await c1.waitUntil(() => c1.hasText((m) => m.type === "task_created"), "task_created");
    const taskId = c1.text.find((m) => m.type === "task_created").task.id;
    log(`task created: ${taskId}`);

    // 2. The PTY program prints its banner as terminal output.
    await c1.waitUntil(() => c1.screen(taskId).includes("AGENT-READY"), "agent banner");
    log("c1 saw the agent banner over the data plane");

    // 3. Drive two turns; each reply is more terminal output.
    c1.sendInput(taskId, "m1\r");
    await c1.waitUntil(() => c1.screen(taskId).includes("reply:m1"), "reply m1");
    c1.sendInput(taskId, "m2\r");
    await c1.waitUntil(() => c1.screen(taskId).includes("reply:m2"), "reply m2");
    const cursor = c1.maxSeq(taskId);
    log(`c1 durably applied up to chunk seq ${cursor}`);

    // 4. Drop c1 (simulate network loss / app close).
    await c1.close();
    log("c1 disconnected");

    // 5. While c1 is gone, another client drives more output on the same task.
    const c2 = new Client(WS_URL);
    await c2.open();
    c2.send({ type: "hello", client_id: "c2", cursors: {} });
    await c2.waitUntil(() => c2.hasText((m) => m.type === "welcome"), "c2 welcome");
    await c2.waitUntil(
      () => c2.hasText((m) => m.type === "replay_done" && m.task_id === taskId),
      "c2 replay_done",
    );
    c2.sendInput(taskId, "m3\r");
    await c2.waitUntil(() => c2.screen(taskId).includes("reply:m3"), "reply m3 while c1 offline");
    log("produced reply:m3 while c1 offline");

    // 6. Reconnect c1 with its durable cursor. It MUST be fast-forwarded only the
    //    bytes it missed: gap-free seqs strictly above the cursor, nothing at or
    //    below it, and the missed reply present.
    const c1b = new Client(WS_URL);
    await c1b.open();
    c1b.send({ type: "hello", client_id: "c1", cursors: { [taskId]: cursor } });
    await c1b.waitUntil(
      () => c1b.hasText((m) => m.type === "replay_done" && m.task_id === taskId),
      "c1 reconnect replay_done",
    );
    const replayed = c1b.seqs(taskId);
    assert(replayed.length > 0, "reconnect must replay the missed bytes");
    assert(
      replayed.every((s) => s > cursor),
      `no chunk at or below the cursor may be replayed (got ${replayed.join(",")}, cursor ${cursor})`,
    );
    for (let i = 1; i < replayed.length; i++) {
      assert(replayed[i] === replayed[i - 1] + 1, `replay must be gap-free (got ${replayed.join(",")})`);
    }
    assert(
      replayed[0] === cursor + 1,
      `replay must start at cursor+1 (got ${replayed[0]}, cursor ${cursor})`,
    );
    assert(c1b.screen(taskId).includes("reply:m3"), "reconnect must include the missed reply:m3");
    assert(!c1b.screen(taskId).includes("reply:m1"), "reconnect must NOT re-send bytes at/below cursor");
    log(`reconnect fast-forwarded exactly [${replayed.join(", ")}] — no loss, no dupes`);

    // 7. Terminate the task and observe the terminal state transition.
    c1b.send({ type: "terminate_task", task_id: taskId });
    await c1b.waitUntil(
      () =>
        c1b.hasText(
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
