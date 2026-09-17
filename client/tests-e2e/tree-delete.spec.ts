import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// Deleting is destructive, so a menu row only fires on its second click — and a
// batch is no exception, except that its confirm names how many files are about
// to go. The client sends one delete per path, so these also pin down that a
// path the host refuses costs only itself.
let dir: string;

const names = ["gone-a.txt", "gone-b.txt", "keep.txt"];

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-delete-"));
  for (const name of names) writeFileSync(join(dir, name), "x");

  await page.addInitScript(
    ([http, token, cwd]) => {
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            workspaces: [
              { id: "pw-ws", serviceId: "pw-svc", name: "del", cwd },
            ],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-delete-client");
    },
    [HTTP, TOKEN, dir],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

const row = (page: Page, name: string) =>
  page.locator(".weditor__row--file", { hasText: name });

test("a multi-selection deletes as a batch", async ({ page }) => {
  await row(page, "gone-a.txt").click();
  await row(page, "gone-b.txt").click({ modifiers: ["Meta"] });
  await expect(page.locator(".weditor__row--file.is-selected")).toHaveCount(2);

  await row(page, "gone-b.txt").click({ button: "right" });
  await page.locator(".menu__item", { hasText: "Delete 2 files" }).click();
  // The first click only arms the row: nothing has been deleted yet.
  await expect(row(page, "gone-a.txt")).toHaveCount(1);
  await page
    .locator(".menu__item", { hasText: "Click again to delete 2 files" })
    .click();

  await expect(row(page, "gone-a.txt")).toHaveCount(0);
  await expect(row(page, "gone-b.txt")).toHaveCount(0);
  await expect.poll(() => readdirSync(dir)).toEqual(["keep.txt"]);
  // The paths a batch retired shouldn't stay picked, so the tree drops them.
  await expect(page.locator(".weditor__row--file.is-selected")).toHaveCount(0);
  await expect(page.locator(".hint--error")).toHaveCount(0);
});

test("one row still deletes on its own", async ({ page }) => {
  await row(page, "keep.txt").click({ button: "right" });
  await page.locator(".menu__item", { hasText: "Delete" }).first().click();
  await page
    .locator(".menu__item", { hasText: "Click again to delete" })
    .click();

  await expect(row(page, "keep.txt")).toHaveCount(0);
  await expect.poll(() => readdirSync(dir)).toEqual(names.slice(0, 2));
});

test("a refused path doesn't stop the rest of the batch", async ({ page }) => {
  // Stand in for a delete the host won't do (a busy folder, a vanished file).
  let refuse = true;
  await page.route("**/api/fs/delete", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (refuse && String(body.path).endsWith("gone-a.txt")) {
      refuse = false;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ message: "busy" }),
      });
      return;
    }
    await route.continue();
  });

  await row(page, "gone-a.txt").click();
  await row(page, "gone-b.txt").click({ modifiers: ["Meta"] });
  await row(page, "gone-b.txt").click({ button: "right" });
  await page.locator(".menu__item", { hasText: "Delete 2 files" }).click();
  await page
    .locator(".menu__item", { hasText: "Click again to delete 2 files" })
    .click();

  // The one that went is gone; the one that didn't is named, and still there.
  await expect(row(page, "gone-a.txt")).toHaveCount(1);
  await expect(row(page, "gone-b.txt")).toHaveCount(0);
  await expect(page.locator(".hint--error")).toHaveText(
    "Deleted 1 of 2 — gone-a.txt: busy",
  );
});
