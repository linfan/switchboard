// Builds and boots a real hosting-service binary (with the fake PTY agent on
// PATH) for the Playwright suite, then waits for it to be healthy. The pid is
// written to a state file so global-teardown can stop it.
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ADDR, HTTP, TOKEN } from "./constants";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const BIN = join(ROOT, "target", "debug", "switchboard-server");
const FAKE_AGENT_DIR = join(ROOT, "e2e", "fake-agent");
export const STATE_FILE = join(HERE, ".server.json");

export default async function globalSetup() {
  execSync("cargo build -p switchboard-server", { cwd: ROOT, stdio: "inherit" });

  const dbDir = mkdtempSync(join(tmpdir(), "switchboard-pw-"));
  const child = spawn(BIN, [], {
    env: {
      ...process.env,
      SWITCHBOARD_ADDR: ADDR,
      SWITCHBOARD_TOKEN: TOKEN,
      SWITCHBOARD_DB: join(dbDir, "pw.db"),
      SWITCHBOARD_NAME: "pw-host",
      SWITCHBOARD_PERMISSION_MODE: "default",
      RUST_LOG: "warn",
      PATH: `${FAKE_AGENT_DIR}:${process.env.PATH}`,
    },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  writeFileSync(STATE_FILE, JSON.stringify({ pid: child.pid }));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${HTTP}/health`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Playwright: hosting service did not become healthy in time");
}
