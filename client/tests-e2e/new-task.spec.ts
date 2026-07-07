import { expect, test, type Page } from "@playwright/test";

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

// Create a workspace by browsing the server's filesystem and picking a folder.
async function addWorkspace(page: Page, name: string) {
  await page.getByTitle("Add workspace").click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("my-project").fill(name);

  await dialog.getByRole("button", { name: "Browse…" }).click();
  const picker = page.getByRole("dialog", { name: "Choose working directory" });
  await expect(picker).toBeVisible();
  // The default listing (server $HOME) resolves and shows its canonical path.
  await expect(picker.locator(".fs-picker__path")).not.toHaveText("…", {
    timeout: 15000,
  });
  await picker.getByRole("button", { name: "Select this folder" }).click();
  await expect(picker).toBeHidden();

  // The chosen path landed in the working-dir input.
  await expect(dialog.getByPlaceholder("/path/to/project")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
}

test("a workspace groups tasks and a task inherits its folder", async ({
  page,
}) => {
  await addWorkspace(page, "proj");
  await expect(page.locator(".workspace", { hasText: "proj" })).toBeVisible();

  // New task under the workspace: only the command is asked for (no folder).
  await page.getByTitle("New task").click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder("/path/to/project")).toHaveCount(0);

  await dialog
    .getByPlaceholder("claude, bash, python3 -m http.server, …")
    .fill("claude");
  await dialog.getByRole("button", { name: "Create" }).click();

  // A conversation appears under the workspace; open it and confirm boot.
  const conv = page.locator(".conv").first();
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();
  await expect(page.locator(".xterm-rows")).toContainText("AGENT-READY", {
    timeout: 15000,
  });
});

test("a command not found on the host surfaces inline and keeps the dialog open", async ({
  page,
}) => {
  await addWorkspace(page, "proj");

  await page.getByTitle("New task").click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();

  await dialog
    .getByPlaceholder("claude, bash, python3 -m http.server, …")
    .fill("nope-zzz-not-a-real-binary");
  await dialog.getByRole("button", { name: "Create" }).click();

  // The server rejects it; the error is shown inline and the dialog stays open.
  await expect(dialog.locator(".hint--error")).toContainText(
    "command 'nope-zzz-not-a-real-binary' not found on this host",
    { timeout: 15000 },
  );
  await expect(dialog).toBeVisible();
});
