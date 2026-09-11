import { expect, test, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// Create a workspace (name + a real server folder) so tasks have a home. Tasks
// inherit its folder, so the New-task dialog no longer prompts for one.
async function addWorkspace(page: Page, name: string) {
  // The row's ⋯ trigger only appears on hover.
  await page.locator(".service__head").hover();
  await page.getByTitle("Service actions").click();
  await page.getByRole("menuitem", { name: "Add workspace" }).click();
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

// Both the workspace's New-task action and the service's Reconnect live in the
// row's ⋯ menu, which is only rendered while the row is hovered.
async function openNewTask(page: Page, workspace: string) {
  const head = page.locator(".workspace__head").filter({ hasText: workspace });
  await head.hover();
  await head.getByTitle("Workspace actions").click();
  await page.getByRole("menuitem", { name: "New task" }).click();
}

async function reconnect(page: Page) {
  await page.locator(".service__head").hover();
  await page.getByTitle("Service actions").click();
  await page.getByRole("menuitem", { name: "Reconnect now" }).click();
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
  await openNewTask(page, "proj");
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
  await reconnect(page);
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
  await openNewTask(page, "proj");
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

test("scrolling away from the last line pauses auto-follow and offers a jump back", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill("follow-task");
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: "follow-task" });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  const rows = page.locator(".xterm-rows");
  const screen = page.locator(".xterm-screen");
  const jump = page.locator(".term-jump");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });

  // Fill the scrollback (each line comes back as an echo plus a reply) so the
  // viewport can actually leave the last line.
  await screen.click();
  await page.keyboard.type(
    Array.from({ length: 100 }, (_, i) => `filler${i}`).join("\n") + "\n",
    { delay: 1 },
  );
  const last = "reply:filler99";
  await expect(rows).toContainText(last, { timeout: 15000 });
  // Riding the bottom: no affordance.
  await expect(jump).toBeHidden();

  // Wheel up to read history.
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -2000);
  await expect(jump).toBeVisible();
  await expect(rows).not.toContainText(last);

  // Scrolling back down by hand resumes following and hides the button again.
  await page.mouse.wheel(0, 2000);
  await expect(jump).toBeHidden();
  await expect(rows).toContainText(last);

  // The button lands on the latest output in one click, and resumes following.
  await page.mouse.wheel(0, -2000);
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(jump).toBeHidden();
  await expect(rows).toContainText(last);
});

test("hosting service reports healthy over REST", async ({ request }) => {
  const res = await request.get(`${HTTP}/health`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.status).toBe("ok");
});
