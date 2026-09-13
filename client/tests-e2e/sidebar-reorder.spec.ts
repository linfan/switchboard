import { expect, test, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// Seed the live host plus an unreachable one, so the sidebar has a pair of
// service rows to reorder without booting a second host. The two workspaces are
// seeded rather than created through the dialog: this suite is about their order,
// not about adding them (add-workspace.spec covers that).
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([http, token]) => {
      // Seed a fresh profile only: this runs on every navigation, and the reload
      // in the task-order test must not wipe what the app has since persisted.
      if (localStorage.getItem("switchboard")) return;
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [
              { id: "pw-svc", name: "PW Host", url: http, token },
              {
                id: "dead-svc",
                name: "Dead Host",
                url: "http://127.0.0.1:1",
                token,
              },
            ],
            workspaces: [
              {
                id: "w-alpha",
                serviceId: "pw-svc",
                name: "Alpha",
                cwd: "/tmp",
              },
              { id: "w-beta", serviceId: "pw-svc", name: "Beta", cwd: "/tmp" },
            ],
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

/** The persisted slice of store state, read back out of localStorage. */
async function persistedState(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("switchboard") ?? "{}").state as {
        services: { id: string }[];
        workspaces: { id: string }[];
        taskOrder: Record<string, string[]>;
      },
  );
}

test("dragging a service row reorders the service list", async ({ page }) => {
  const heads = page.locator(".service__head");
  await expect(heads).toHaveCount(2);
  await expect(heads.first()).toContainText("PW Host");

  // Dropping the second row on the first takes the first row's slot.
  await heads.nth(1).dragTo(heads.first());

  await expect(heads.first()).toContainText("Dead Host");
  expect((await persistedState(page)).services.map((s) => s.id)).toEqual([
    "dead-svc",
    "pw-svc",
  ]);
});

test("dragging a workspace row reorders only its own service", async ({
  page,
}) => {
  const heads = page.locator(".workspace__head");
  await expect(heads.first()).toContainText("Alpha");

  await heads.nth(1).dragTo(heads.first());

  await expect(heads.first()).toContainText("Beta");
  expect((await persistedState(page)).workspaces.map((w) => w.id)).toEqual([
    "w-beta",
    "w-alpha",
  ]);
});

// Create a task under a workspace from its ⋯ menu (the fake agent on PATH stands
// in for a real CLI — cf. new-task.spec).
async function addTask(page: Page, workspace: string) {
  const head = page.locator(".workspace__head").filter({ hasText: workspace });
  await head.hover();
  await head.getByTitle("Workspace actions").click();
  await page.getByRole("menuitem", { name: "New task" }).click();

  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByPlaceholder("claude, bash, python3 -m http.server, …")
    .fill("claude");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(dialog).toBeHidden();
}

test("dragging a task row reorders the tasks in its workspace", async ({
  page,
}) => {
  await addTask(page, "Alpha");
  await addTask(page, "Alpha");

  // Scoped to the Alpha group: tasks an earlier spec left on this host render
  // under "Ungrouped" and are none of this test's business.
  const alpha = page.locator(".workspace", { hasText: "Alpha" });
  const titles = alpha.locator(".conv__title");
  await expect(alpha.locator(".conv")).toHaveCount(2);
  const before = await titles.allTextContents();
  expect(new Set(before).size).toBe(2);

  await alpha.locator(".conv").nth(1).dragTo(alpha.locator(".conv").first());
  await expect(titles).toHaveText([before[1], before[0]]);

  // The order is a local override kept separately from the task list, so a reload
  // — which rebuilds the tasks from the server in creation order — has to bring
  // the arrangement back.
  await page.reload();
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
  await expect(
    page.locator(".workspace", { hasText: "Alpha" }).locator(".conv__title"),
  ).toHaveText([before[1], before[0]]);
});
