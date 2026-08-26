#!/usr/bin/env node
// End-to-end upgrade-survival test: drives REAL self-upgrades (upload + the
// in-place re-exec) while a WebSocket client stays attached to the task,
// reconnects after the exec, and keeps driving the same agent. Unlike
// e2e.mjs — which kills and respawns the server — this exercises the actual
// upgrade path (binary swap + execve) that production takes, with the WS
// reconnect/replay interplay a REST-only driver cannot see. The regression it
// pins: tasks used to come back Detached (macOS, intermittent) or Exited
// (Windows, always) after an upgrade.
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocket } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN =
  process.env.SWITCHBOARD_BIN ??
  resolve(HERE, "..", "target", "debug", "switchboard-server");
const ADDR = "127.0.0.1:8813";
const [HOST, PORT] = ADDR.split(":");
const TOKEN = "repro-token";
const ITERATIONS = Number(process.env.ITERATIONS ?? 5);
const WS_URL = `ws://${ADDR}/ws`;

const dir = mkdtempSync(join(tmpdir(), "swb-ws-"));
const agentDir = join(dir, "bin");
mkdirSync(agentDir);
writeFileSync(join(agentDir, "claude"), readFileSync(join(HERE, "fake-agent", "claude")));
chmodSync(join(agentDir, "claude"), 0o755);

const serverLog = [];
let server = null;

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

function request(method, path, body = null) {
  return new Promise((res, rej) => {
    const bodyBuf = body === null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const ts = Date.now();
    const nonce = randomBytes(16);
    const macHex = mac(Buffer.from(TOKEN), Buffer.from("SWB-REST-v1"), [
      Buffer.from(method),
      Buffer.from(path),
      (() => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(ts)); return b; })(),
      nonce,
      createHash("sha256").update(bodyBuf).digest(),
      Buffer.alloc(0),
    ]).toString("hex");
    const req = http.request(
      { host: HOST, port: PORT, method, path, headers: {
        "x-swb-ts": String(ts),
        "x-swb-nonce": nonce.toString("hex"),
        "x-swb-mac": macHex,
        ...(body !== null && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}),
        "content-length": bodyBuf.length,
      } },
      (r) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (r.statusCode >= 400) return rej(new Error(`${method} ${path} -> ${r.statusCode}: ${text.slice(0, 300)}`));
          res(text ? JSON.parse(text) : null);
        });
      },
    );
    req.on("error", (e) => rej(new Error(`${method} ${path} transport: ${e.message}`)));
    if (bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

function startServer() {
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("SWITCHBOARD_") && k !== "RUST_LOG") cleanEnv[k] = v;
  }
  const child = spawn(BIN, [], {
    env: {
      ...cleanEnv,
      SWITCHBOARD_ADDR: ADDR,
      SWITCHBOARD_TLS: "0",
      SWITCHBOARD_TOKEN: TOKEN,
      SWITCHBOARD_DB: join(dir, "repro.db"),
      SWITCHBOARD_NAME: "repro-ws",
      SWITCHBOARD_PERMISSION_MODE: "default",
      RUST_LOG: "info,switchboard_server=debug",
      PATH: `${agentDir}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => serverLog.push(d.toString().trimEnd()));
  child.stderr.on("data", (d) => serverLog.push(d.toString().trimEnd()));
  return child;
}

async function waitHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited rc=${server.exitCode}`);
    try {
      const ok = await new Promise((res) => {
        http.get({ host: HOST, port: PORT, path: "/health" }, (r) => { r.resume(); res(r.statusCode === 200); }).on("error", () => res(false));
      });
      if (ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("health timeout");
}

// --- SWB-WS-v1 client (mirror of e2e.mjs) -----------------------------------
const WS_DOMAIN = Buffer.from("SWB-WS-v1");
const CHANNEL_BINDING = Buffer.alloc(0);
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
  return null;
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
        if (p.pred()) { p.res(); return false; }
        return true;
      });
    });
    this.closed = new Promise((res) => this.ws.on("close", res));
  }
  open() { return this.opened; }
  async auth() {
    await this.waitUntil(() => this.hasText((m) => m.type === "auth_challenge"), "auth_challenge");
    const serverNonce = Buffer.from(this.text.find((m) => m.type === "auth_challenge").server_nonce, "hex");
    const clientNonce = randomBytes(32);
    this.send({
      type: "auth_response",
      client_nonce: clientNonce.toString("hex"),
      mac: mac(Buffer.from(TOKEN), WS_DOMAIN, [serverNonce, clientNonce, CHANNEL_BINDING]).toString("hex"),
    });
    await this.waitUntil(() => this.hasText((m) => m.type === "auth_ok"), "auth_ok");
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  sendInput(taskId, text) { this.ws.send(encodeInput(taskId, text)); }
  close() {
    return new Promise((res) => { this.ws.on("close", res); this.ws.close(); });
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
  hasText(pred) { return this.text.some(pred); }
  screen(taskId) {
    return Buffer.concat(
      this.frames.filter((f) => f.taskId === taskId).map((f) => Buffer.from(f.data)),
    ).toString("utf8");
  }
}

// Connect + auth + hello, retrying while the server is down (as the real client does).
async function reconnect(cursors, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = new Client(WS_URL);
    try {
      await c.open();
      await c.auth();
      c.send({ type: "hello", client_id: "repro", cursors });
      await c.waitUntil(() => c.hasText((m) => m.type === "welcome"), "welcome", 10000);
      return c;
    } catch {
      try { c.ws.terminate(); } catch {}
      if (Date.now() > deadline) throw new Error("could not reconnect after upgrade");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

function dumpDiagnostics() {
  console.log("--- server log (tail 120) ---");
  console.log(serverLog.slice(-120).join("\n"));
  const hostsDir = join(dir, "hosts");
  try {
    for (const f of readdirSync(hostsDir)) {
      if (f.endsWith(".log")) {
        console.log(`--- host log ${f} (tail 30) ---`);
        console.log(readFileSync(join(hostsDir, f), "utf8").split("\n").slice(-30).join("\n"));
      }
    }
  } catch {}
}

async function main() {
  const binBytes = readFileSync(BIN);
  console.log(`binary ${BIN}; ${ITERATIONS} upgrade iterations with a live WS client`);

  server = startServer();
  await waitHealth();

  const info = await request("POST", "/api/tasks", { tool: "claude", title: "ws", cwd: null, cols: 80, rows: 24 });
  const taskId = info.id;
  console.log(`created task ${taskId}`);

  let client = await reconnect({});
  const t0 = client.text.find((m) => m.type === "welcome").tasks.find((t) => t.id === taskId);
  if (!t0 || t0.status.state !== "running") {
    console.log(`\n=== FAILURE: task not running right after create: ${JSON.stringify(t0?.status)} ===`);
    dumpDiagnostics();
    process.exitCode = 1;
    return;
  }
  await client.waitUntil(() => client.screen(taskId).includes("AGENT-READY"), "agent banner");
  client.sendInput(taskId, "m0\r");
  await client.waitUntil(() => client.screen(taskId).includes("reply:m0"), "reply m0");
  console.log("client attached and driving the task");

  for (let i = 1; i <= ITERATIONS; i++) {
    await request("POST", "/api/admin/upgrade/upload", binBytes);
    // Keep typing into the dying connection, like a user who doesn't notice.
    client.sendInput(taskId, `m${i}\r`);
    await client.closed;
    // Server re-execs ~800ms after the response; reconnect with retry.
    client = await reconnect({ [taskId]: 0 });
    const welcome = client.text.find((m) => m.type === "welcome");
    const st = welcome.tasks.find((t) => t.id === taskId)?.status?.state;
    console.log(`iter ${i}: task state after reconnect -> ${st}`);
    if (st !== "running") {
      console.log(`\n=== FAILURE at iteration ${i}: state ${st} ===`);
      dumpDiagnostics();
      process.exitCode = 1;
      break;
    }
    // The agent must still answer on the new server.
    client.sendInput(taskId, `p${i}\r`);
    try {
      await client.waitUntil(() => client.screen(taskId).includes(`reply:p${i}`), `reply p${i}`, 15000);
      console.log(`iter ${i}: agent still answering after the upgrade`);
    } catch (e) {
      console.log(`\n=== FAILURE at iteration ${i}: ${e.message} ===`);
      dumpDiagnostics();
      process.exitCode = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!process.exitCode) console.log(`OK: ${ITERATIONS} upgrades survived with a live WS client`);

  // Terminate the task before killing the server: the pty-host outlives the
  // server by design, and killing the server alone would leak it (and the
  // agent) as orphans.
  try {
    client.send({ type: "terminate_task", task_id: taskId });
    await client.waitUntil(
      () =>
        client.hasText(
          (m) =>
            m.type === "task_state" &&
            m.task_id === taskId &&
            m.status.state === "terminated",
        ),
      "task terminated",
      10000,
    );
    console.log("task terminated; pty-hosts will exit on their own");
  } catch {}
  try { await client.close(); } catch {}
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e.message);
  dumpDiagnostics();
  process.exitCode = 1;
})
  .finally(() => { if (server) server.kill("SIGKILL"); });
