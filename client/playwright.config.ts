import { defineConfig, devices } from "@playwright/test";

// Boots the real hosting-service binary (global-setup) and the Vite dev server,
// then drives the app in a real browser against a live PTY backend.
export default defineConfig({
  testDir: "./tests-e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  globalSetup: "./tests-e2e/global-setup.ts",
  globalTeardown: "./tests-e2e/global-teardown.ts",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
