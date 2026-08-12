import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/** Short commit of the checkout being built, or `"unknown"` outside a repo. */
function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

// Tauri expects a fixed port and hides Vite's own errors behind its window.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Baked into the bundle and surfaced by the About dialog (see src/buildInfo.ts).
  // In `vite dev` these are stamped when the dev server boots, not per reload.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __GIT_COMMIT__: JSON.stringify(gitCommit()),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2020",
    outDir: "dist",
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
