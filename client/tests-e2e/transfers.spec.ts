import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// A byte transfer has to be visible and stoppable while it is still running,
// which is exactly the window a normal fast localhost download never shows. The
// tests hold the download response open through `page.route` so the strip can be
// inspected mid-flight.
let dir: string;

/** Open the app against `cwd` as its only workspace, with these settings. */
async function seed(page: Page, cwd: string, settings: object = {}) {
  await page.addInitScript(
    ([http, token, path, opts]) => {
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            workspaces: [
              { id: "pw-ws", serviceId: "pw-svc", name: "xfer", cwd: path },
            ],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
            settings: opts,
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-xfer-client");
    },
    [HTTP, TOKEN, cwd, settings],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
}

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-xfer-"));
  writeFileSync(join(dir, "big.bin"), "x".repeat(512 * 1024));
  // Two small siblings, so a selection has something to extend across.
  writeFileSync(join(dir, "one.txt"), "1");
  writeFileSync(join(dir, "two.txt"), "2");
  await seed(page, dir);
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

const file = (page: Page, name: string) =>
  page.locator(".weditor__row--file", { hasText: name });

test("a multi-selection downloads as one batch", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/fs/download**", async (route) => {
    await held;
    await route.continue();
  });

  await file(page, "one.txt").click();
  await file(page, "two.txt").click({ modifiers: ["Meta"] });
  await expect(page.locator(".weditor__row--file.is-selected")).toHaveCount(2);

  // Right-clicking a row that's already picked acts on the whole selection.
  await file(page, "two.txt").click({ button: "right" });
  await page.locator(".menu__item", { hasText: "Download 2 files" }).click();

  // One row per file, up front, so each can be watched — and stopped — alone.
  const rows = page.locator(".weditor__xfer");
  await expect(rows).toHaveCount(2);
  await rows.first().locator(".weditor__xfer-cancel").click();
  await expect(rows).toHaveCount(1);

  release();
  await expect(page.locator(".weditor__transfers")).toHaveCount(0);
  await expect(page.locator(".hint--error")).toHaveCount(0);
});

test("the selection stops at the configured cap", async ({ page }) => {
  await seed(page, dir, { downloadMaxFiles: 1 });

  await file(page, "one.txt").click();
  await file(page, "two.txt").click({ modifiers: ["Meta"] });

  await expect(page.locator(".weditor__row--file.is-selected")).toHaveCount(1);
  await expect(page.getByText("At most 1 file per download")).toBeVisible();
});
