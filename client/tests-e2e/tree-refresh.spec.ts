import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// The tree caches each folder's listing until a filesystem op succeeds. The
// refresh button is the way out when that cache disagrees with the disk: it
// drops the cached rows first, then re-reads the folder from the host.
let dir: string;

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-refresh-"));
  writeFileSync(join(dir, "keep.txt"), "x");

  await page.addInitScript(
    ([http, token, cwd]) => {
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            workspaces: [{ id: "pw-ws", serviceId: "pw-svc", name: "rf", cwd }],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-refresh-client");
    },
    [HTTP, TOKEN, dir],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (page: Page, name: string) =>
  page.locator(".weditor__row--file", { hasText: name });

const refresh = (page: Page) =>
  page.getByRole("button", { name: "Refresh file tree" });

test("refresh re-reads the folder from disk", async ({ page }) => {
  await expect(row(page, "keep.txt")).toHaveCount(1);

  // A change made behind the tree's back stays invisible until a re-list.
  writeFileSync(join(dir, "added-elsewhere.txt"), "y");
  await expect(row(page, "added-elsewhere.txt")).toHaveCount(0);

  await refresh(page).click();
  await expect(row(page, "added-elsewhere.txt")).toHaveCount(1);
});

test("refresh drops the cached rows before the new listing lands", async ({
  page,
}) => {
  await expect(row(page, "keep.txt")).toHaveCount(1);
  rmSync(join(dir, "keep.txt"));

  // Hold the listing the refresh starts, so only the cache drop can explain the
  // stale row going away before any new data arrives.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/fs\?/, async (route) => {
    await held;
    await route.continue();
  });

  try {
    await refresh(page).click();
    await expect(row(page, "keep.txt")).toHaveCount(0);
    await expect(
      page.locator(".weditor__row--hint", { hasText: "loading…" }),
    ).toHaveCount(1);
  } finally {
    release();
  }
});
