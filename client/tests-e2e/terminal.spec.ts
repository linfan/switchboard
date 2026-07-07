import { expect, test, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// Create a workspace (name + a real server folder) so tasks have a home. Tasks
// inherit its folder, so the New-task dialog no longer prompts for one.
async function addWorkspace(page: Page, name: string) {
  await page.getByTitle("Add workspace").click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByPlaceholder("my-project").fill(name);
  await dialog.getByRole("button", { name: "Browse…" }).click();
  const picker = page.getByRole("dialog", { name: "Choose working directory" });
  await expect(picker.locator(".fs-picker__path")).not.toHaveText("…", {
    timeout: 15000,
  });
  await picker.getByRole("button", { name: "Select this folder" }).click();
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
}

// Seed a registered service into localStorage before the app boots, so the
// connection pool dials our live hosting service on load. Mirrors the zustand
// `persist` shape (partialized to { services, cursors }).
test.beforeEach(async ({ page }) => {
  // Seed only when absent so a reload keeps whatever the app itself persisted
  // (a reload test must observe real persisted state, not a fresh re-seed).
  await page.addInitScript(
    ([http, token]) => {
      if (!localStorage.getItem("switchboard")) {
        localStorage.setItem(
          "switchboard",
          JSON.stringify({
            state: {
              services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            },
            version: 0,
          }),
        );
      }
      localStorage.setItem("switchboard-client-id", "pw-client");
    },
    [HTTP, TOKEN],
  );
});

test("renders a PTY terminal, streams output, echoes input, and survives reconnect", async ({
  page,
}) => {
  await page.goto("/");

  // The pool connects; the service dot goes online.
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  // Create a task under a workspace (tool defaults to first available).
  await addWorkspace(page, "proj");
  await page.getByTitle("New task").click();
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
  await page.getByRole("button", { name: "Create" }).click();

  // A conversation appears in the sidebar; open it.
  const conv = page.locator(".conv").first();
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  // The terminal renders and shows the agent's startup banner.
  const rows = page.locator(".xterm-rows");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });

  // Type a line; the PTY echoes it and the agent replies.
  await page.locator(".xterm-screen").click();
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("reply:hello", { timeout: 15000 });

  // Force a reconnect; the server redraws the screen (snapshot or byte replay),
  // so the prior output must still be present afterwards.
  await page.getByTitle("Reconnect now").click();
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
  await expect(rows).toContainText("reply:hello", { timeout: 15000 });
});

test("terminal screen content is restored after a full client reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  // Create a task under a workspace and drive some output into its terminal.
  // A unique title lets us re-select exactly this task after reload — the shared
  // host DB accumulates tasks across tests, so `.conv first` isn't reliable.
  await addWorkspace(page, "proj");
  await page.getByTitle("New task").click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill("reload-task");
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: "reload-task" });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  const rows = page.locator(".xterm-rows");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });
  await page.locator(".xterm-screen").click();
  await page.keyboard.type("persist-me");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("reply:persist-me", { timeout: 15000 });

  // Fully reload the client (fresh page => empty in-memory xterm buffer). The
  // task must recover AND its screen must be reconstructed from the server,
  // rather than coming back blank/garbled.
  await page.reload();
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
  await page.locator(".conv", { hasText: "reload-task" }).click();
  await expect(page.locator(".xterm-rows")).toContainText("reply:persist-me", {
    timeout: 15000,
  });
});

test("hosting service reports healthy over REST", async ({ request }) => {
  const res = await request.get(`${HTTP}/health`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.status).toBe("ok");
});
