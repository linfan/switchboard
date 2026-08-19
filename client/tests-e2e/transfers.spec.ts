import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// A byte transfer has to be visible and stoppable while it is still running,
// which is exactly the window a normal fast localhost download never shows. Both
// tests hold the download response open through `page.route` so the strip can be
// inspected mid-flight.
let dir: string;

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-xfer-"));
  writeFileSync(join(dir, "big.bin"), "x".repeat(512 * 1024));

  await page.addInitScript(
    ([http, token, cwd]) => {
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            workspaces: [
              { id: "pw-ws", serviceId: "pw-svc", name: "xfer", cwd },
            ],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-xfer-client");
    },
    [HTTP, TOKEN, dir],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a download shows a progress row until it finishes", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/fs/download**", async (route) => {
    await held;
    await route.continue();
  });

  const saved = page.waitForEvent("download");
  await page.locator(".weditor__row--file", { hasText: "big.bin" }).click({
    button: "right",
  });
  await page.locator(".menu__item", { hasText: "Download" }).click();

  // The row is up before any byte moves; with no Content-Length yet the bar is
  // indeterminate and the label counts bytes instead of percent.
  const row = page.locator(".weditor__xfer");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("big.bin");
  await expect(row.locator(".weditor__xfer-pct")).toHaveText("0 B");
  await expect(row.locator(".weditor__xfer-bar")).toHaveClass(/is-waiting/);

  release();
  expect((await saved).suggestedFilename()).toBe("big.bin");
  await expect(page.locator(".weditor__transfers")).toHaveCount(0);
  await expect(page.locator(".hint--error")).toHaveCount(0);
});

test("cancelling a download drops the row without an error", async ({
  page,
}) => {
  // Never answered, so the transfer can only end by being cancelled.
  await page.route("**/api/fs/download**", () => {});

  await page.locator(".weditor__row--file", { hasText: "big.bin" }).click({
    button: "right",
  });
  await page.locator(".menu__item", { hasText: "Download" }).click();

  const row = page.locator(".weditor__xfer");
  await expect(row).toContainText("big.bin");
  await row.locator(".weditor__xfer-cancel").click();

  await expect(page.locator(".weditor__transfers")).toHaveCount(0);
  await expect(page.locator(".hint--error")).toHaveCount(0);
});
