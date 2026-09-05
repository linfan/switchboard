#!/usr/bin/env node
// End-to-end test of the full v2 stack: a real server binary supervising a real
// (fake) agent on a PTY, driven by real WebSocket clients speaking the hybrid
// transport (JSON control plane + binary data plane). Proves the crown-jewel
// guarantee: after a disconnect, a reconnecting client is fast-forwarded EXACTLY
// the terminal bytes it missed — gap-free, nothing at or below its cursor.
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.SWITCHBOARD_BIN ??
  resolve(HERE, "..", "target", "debug", "switchboard-server");
const FAKE_AGENT_DIR = join(HERE, "fake-agent");

const ADDR = "127.0.0.1:8799";
const TOKEN = "e2e-token";
const HTTP = `http://${ADDR}`;
const WS_URL = `ws://${ADDR}/ws`;

const dbDir = mkdtempSync(join(tmpdir(), "switchboard-e2e-"));
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

// --- SWB-WS-v1 auth (mirror of shared/src/auth.rs) --------------------------
// The token is never transmitted: the client returns an HMAC over both nonces and
// the channel binding. Every field is length-prefixed (u64 big-endian) so no value
// can be confused for another. TLS is off here, so the channel binding is empty.
const WS_DOMAIN = Buffer.from("SWB-WS-v1");
const CHANNEL_BINDING = Buffer.alloc(0);

function mac(key, domain, fields) {
  const h = createHmac("sha256", key);
  for (const field of [domain, ...fields]) {
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(field.length));
    h.update(len);
    h.update(field);
  }
  return h.digest();
}

// --- binary data-plane codec (mirror of shared/src/frame.rs) ----------------
const KIND_OUTPUT = 0x01;
const KIND_SNAPSHOT = 0x02;
const KIND_INPUT = 0x10;

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, "");
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
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
    return {
      kind: kind === KIND_OUTPUT ? "output" : "snapshot",
      taskId,
      seq,
      data,
    };
  }
  return null; // client never receives INPUT frames
}
function encodeInput(taskId, text) {
  return Buffer.concat([
    Buffer.from([KIND_INPUT]),
    uuidToBytes(taskId),
    Buffer.from(text),
  ]);
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
  // Answer the server's challenge, so the connection may proceed to `hello`.
  async auth() {
    await this.waitUntil(
      () => this.hasText((m) => m.type === "auth_challenge"),
      "auth_challenge",
    );
    const serverNonce = Buffer.from(
      this.text.find((m) => m.type === "auth_challenge").server_nonce,
      "hex",
    );
    const clientNonce = randomBytes(32);
    this.send({
      type: "auth_response",
      client_nonce: clientNonce.toString("hex"),
      mac: mac(Buffer.from(TOKEN), WS_DOMAIN, [
        serverNonce,
        clientNonce,
        CHANNEL_BINDING,
      ]).toString("hex"),
    });
    await this.waitUntil(
      () => this.hasText((m) => m.type === "auth_ok"),
      "auth_ok",
    );
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
    return Buffer.concat(
      this.dataFrames(taskId).map((f) => Buffer.from(f.data)),
    ).toString("utf8");
  }
}

function startServer() {
  const child = spawn(BIN, [], {
    env: {
      ...process.env,
      SWITCHBOARD_ADDR: ADDR,
      SWITCHBOARD_TLS: "0", // harness clients speak plain ws over http
      SWITCHBOARD_TOKEN: TOKEN,
      SWITCHBOARD_DB: join(dbDir, "e2e.db"),
      SWITCHBOARD_NAME: "e2e-host",
      SWITCHBOARD_PERMISSION_MODE: "default",
      RUST_LOG: "info",
      PATH: `${FAKE_AGENT_DIR}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => serverLog.push(d.toString().trimEnd()));
  child.stderr.on("data", (d) => serverLog.push(d.toString().trimEnd()));
  return child;
}

async function waitForHealth(server, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Our server dying (a port already in use, say) would otherwise leave the
    // health probe answering from whatever else is listening on ADDR, and the
    // failure would surface much later as an inexplicable protocol timeout.
    if (server.exitCode !== null)
      fail(`server exited with code ${server.exitCode}`);
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
  // Reassigned when the restart step replaces it; `finally` kills whichever
  // process is current.
  let server = startServer();
  try {
    await waitForHealth(server);
    log("server healthy");

    // 1. First client: handshake + create an interactive PTY task.
    const c1 = new Client(WS_URL);
    await c1.open();
    await c1.auth();
    c1.send({ type: "hello", client_id: "c1", cursors: {} });
    await c1.waitUntil(
      () => c1.hasText((m) => m.type === "welcome"),
      "c1 welcome",
    );
    log("c1 welcomed");

    c1.send({
      type: "create_task",
      tool: "claude",
      title: "E2E",
      cwd: null,
      cols: 80,
      rows: 24,
    });
    await c1.waitUntil(
      () => c1.hasText((m) => m.type === "task_created"),
      "task_created",
    );
    const taskId = c1.text.find((m) => m.type === "task_created").task.id;
    log(`task created: ${taskId}`);

    // 2. The PTY program prints its banner as terminal output.
    await c1.waitUntil(
      () => c1.screen(taskId).includes("AGENT-READY"),
      "agent banner",
    );
    log("c1 saw the agent banner over the data plane");

    // 3. Drive two turns; each reply is more terminal output.
    c1.sendInput(taskId, "m1\r");
    await c1.waitUntil(
      () => c1.screen(taskId).includes("reply:m1"),
      "reply m1",
    );
    c1.sendInput(taskId, "m2\r");
    await c1.waitUntil(
      () => c1.screen(taskId).includes("reply:m2"),
      "reply m2",
    );
    const cursor = c1.maxSeq(taskId);
    log(`c1 durably applied up to chunk seq ${cursor}`);

    // 4. Drop c1 (simulate network loss / app close).
    await c1.close();
    log("c1 disconnected");

    // 5. While c1 is gone, another client drives more output on the same task.
    const c2 = new Client(WS_URL);
    await c2.open();
    await c2.auth();
    c2.send({ type: "hello", client_id: "c2", cursors: {} });
    await c2.waitUntil(
      () => c2.hasText((m) => m.type === "welcome"),
      "c2 welcome",
    );
    await c2.waitUntil(
      () => c2.hasText((m) => m.type === "replay_done" && m.task_id === taskId),
      "c2 replay_done",
    );
    c2.sendInput(taskId, "m3\r");
    await c2.waitUntil(
      () => c2.screen(taskId).includes("reply:m3"),
      "reply m3 while c1 offline",
    );
    log("produced reply:m3 while c1 offline");

    // 6. Reconnect c1 with its durable cursor. It MUST be fast-forwarded only the
    //    bytes it missed: gap-free seqs strictly above the cursor, nothing at or
    //    below it, and the missed reply present.
    const c1b = new Client(WS_URL);
    await c1b.open();
    await c1b.auth();
    c1b.send({ type: "hello", client_id: "c1", cursors: { [taskId]: cursor } });
    await c1b.waitUntil(
      () =>
        c1b.hasText((m) => m.type === "replay_done" && m.task_id === taskId),
      "c1 reconnect replay_done",
    );
    const replayed = c1b.seqs(taskId);
    assert(replayed.length > 0, "reconnect must replay the missed bytes");
    assert(
      replayed.every((s) => s > cursor),
      `no chunk at or below the cursor may be replayed (got ${replayed.join(",")}, cursor ${cursor})`,
    );
    for (let i = 1; i < replayed.length; i++) {
      assert(
        replayed[i] === replayed[i - 1] + 1,
        `replay must be gap-free (got ${replayed.join(",")})`,
      );
    }
    assert(
      replayed[0] === cursor + 1,
      `replay must start at cursor+1 (got ${replayed[0]}, cursor ${cursor})`,
    );
    assert(
      c1b.screen(taskId).includes("reply:m3"),
      "reconnect must include the missed reply:m3",
    );
    assert(
      !c1b.screen(taskId).includes("reply:m1"),
      "reconnect must NOT re-send bytes at/below cursor",
    );
    log(
      `reconnect fast-forwarded exactly [${replayed.join(", ")}] — no loss, no dupes`,
    );

    // 7. Replace the server process, exactly as a self-upgrade does. The agent
    //    lives in its own pty-host process, so it must still be running when the
    //    new server comes up — and must still be drivable, which is what proves
    //    the new server re-attached to the PTY rather than merely finding a live
    //    pid in the database.
    await c1b.close();
    await c2.close();
    server.kill("SIGKILL");
    await new Promise((res) => server.on("exit", res));
    log("server killed (stands in for the upgrade re-exec)");

    server = startServer();
    await waitForHealth(server);
    const c4 = new Client(WS_URL);
    await c4.open();
    await c4.auth();
    c4.send({ type: "hello", client_id: "c4", cursors: {} });
    await c4.waitUntil(
      () => c4.hasText((m) => m.type === "welcome"),
      "c4 welcome",
    );
    const survivor = c4.text
      .find((m) => m.type === "welcome")
      .tasks.find((t) => t.id === taskId);
    assert(survivor, "the task must still exist after the server is replaced");
    eq(
      survivor.status.state,
      "running",
      "task must still be running after the restart",
    );
    log("task survived the server restart, still running");

    c4.sendInput(taskId, "m4\r");
    await c4.waitUntil(
      () => c4.screen(taskId).includes("reply:m4"),
      "reply m4 after restart",
    );
    log("the same agent still answers on the new server — PTY re-attached");

    // 8. Terminate the task and observe the terminal state transition.
    c4.send({ type: "terminate_task", task_id: taskId });
    await c4.waitUntil(
      () =>
        c4.hasText(
          (m) =>
            m.type === "task_state" &&
            m.task_id === taskId &&
            m.status.state === "terminated",
        ),
      "task terminated",
    );
    log("task terminated");

    await c4.close();
    log("ALL CHECKS PASSED");
  } finally {
    server.kill("SIGKILL");
  }
}

main().catch((e) => {
  console.error("[e2e]", e.message);
  process.exit(1);
});
