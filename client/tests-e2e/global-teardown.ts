// Stops the hosting-service binary started by global-setup.
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(HERE, ".server.json");

export default async function globalTeardown() {
  try {
    const { pid } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (pid) process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
  try {
    rmSync(STATE_FILE);
  } catch {
    // ignore
  }
}
