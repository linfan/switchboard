import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// Seed a registered service so the pool dials our live host on load.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([http, token]) => {
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            cursors: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-client");
    },
    [HTTP, TOKEN],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
});

// Open the "Add workspace" dialog via the service's ⋯ actions menu.
async function openAddWorkspace(page: import("@playwright/test").Page) {
  // The ⋯ trigger is hidden until its row is hovered; reveal it, then click it
  // by title (its accessible name is the "⋯" text, not the title).
  await page.locator(".service__head").hover();
  await page.getByTitle("Service actions").click();
  await page.getByRole("menuitem", { name: "Add workspace" }).click();
}

test("clicking outside the dialog does not close it; ESC does", async ({
  page,
}) => {
  await openAddWorkspace(page);
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await expect(dialog).toBeVisible();

  // A stray click on the backdrop outside the dialog is ignored — a half-filled
  // form isn't discarded by a misclick.
  await dialog.getByPlaceholder("my-project").fill("keep-me");
  await page.locator(".modal__scrim").click({ position: { x: 5, y: 5 } });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder("my-project")).toHaveValue("keep-me");

  // ESC still closes it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a non-existent folder prompts to create it before the workspace is added", async ({
  page,
}) => {
  // A path that definitely doesn't exist on the host yet (with a missing parent,
  // so create_dir_all must build the whole chain).
  const root = join(tmpdir(), `swb-e2e-mkdir-${Date.now()}`);
  const target = join(root, "nested");
  expect(existsSync(target)).toBe(false);

  try {
    await openAddWorkspace(page);
    const dialog = page.getByRole("dialog", { name: "Add workspace" });
    await expect(dialog).toBeVisible();

    await dialog.getByPlaceholder("my-project").fill("fresh");
    await dialog.getByPlaceholder("/path/to/project").fill(target);
    await dialog.getByRole("button", { name: "Add" }).click();

    // The missing-folder confirmation appears instead of creating the workspace.
    const confirm = page.getByRole("dialog", { name: "Create folder?" });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText(target)).toBeVisible();
    // Nothing created yet: the workspace list is still empty.
    await expect(page.locator(".workspace")).toHaveCount(0);

    await confirm.getByRole("button", { name: "Create folder" }).click();

    // The folder was created on the host and the workspace committed.
    await expect(confirm).toBeHidden();
    await expect(dialog).toBeHidden();
    await expect(
      page.locator(".workspace", { hasText: "fresh" }),
    ).toBeVisible();
    expect(existsSync(target)).toBe(true);
  } finally {
    // Clean up the directory tree the test created on the shared filesystem.
    rmSync(root, { recursive: true, force: true });
  }
});
