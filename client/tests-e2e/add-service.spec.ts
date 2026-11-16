import { expect, test } from "@playwright/test";

import { HOST, HTTP, PORT, TOKEN } from "./constants";

// Start with no registered services so the +svc dialog drives the whole flow.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("switchboard-client-id", "pw-client");
  });
  await page.goto("/");
});

test("a wrong token is rejected and blocks the Add dialog", async ({
  page,
}) => {
  await page.getByTitle("Add service").click();
  const dialog = page.getByRole("dialog", { name: "Add hosting service" });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder("Laptop / prod-box").fill("PW Host");
  // Harness server runs plain http, so pick the http protocol.
  await dialog.getByRole("radio", { name: "http", exact: true }).check();
  await dialog.getByPlaceholder("hostname or IP").fill(HOST);
  await dialog.getByPlaceholder("8787").fill(PORT);
  // Token field is the only password input in the dialog.
  await dialog.locator('input[type="password"]').fill("wrong-token");
  await dialog.getByRole("button", { name: "Add" }).click();

  // The error is reported and the dialog stays open — nothing was registered.
  await expect(dialog.locator(".hint--error")).toHaveText("Invalid token.");
  await expect(dialog).toBeVisible();
  await expect(page.locator(".service")).toHaveCount(0);

  // Correcting the token lets it through: the dialog closes and dials online.
  await dialog.locator('input[type="password"]').fill(TOKEN);
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
});

test("a tagged service connects, persists, displays its TAG, and keeps it read-only", async ({
  page,
}) => {
  await page.getByTitle("Add service").click();
  const dialog = page.getByRole("dialog", { name: "Add hosting service" });
  await dialog.getByPlaceholder("Laptop / prod-box").fill("Tagged PW Host");
  await dialog.getByRole("radio", { name: "http", exact: true }).check();
  await dialog.getByPlaceholder("hostname or IP").fill(HOST);
  await dialog.getByPlaceholder("8787").fill(PORT);
  await dialog.locator('input[type="password"]').fill(TOKEN);

  await dialog.getByLabel("TAG", { exact: true }).fill("bad tag");
  await expect(dialog.getByRole("button", { name: "Add" })).toBeDisabled();
  await dialog.getByLabel("TAG", { exact: true }).fill("worker-A");
  await dialog.getByRole("button", { name: "Add" }).click();

  await expect(dialog).toBeHidden();
  const service = page.locator(".service", { hasText: "Tagged PW Host" });
  await expect(service.locator(".dot--online")).toBeVisible({ timeout: 15000 });
  await service.locator(".service__name").click();
  await expect(
    page.locator(".service-panel__row", { hasText: "TAG" }),
  ).toContainText("worker-A");

  await page.reload();
  const persisted = page.locator(".service", { hasText: "Tagged PW Host" });
  await expect(persisted.locator(".dot--online")).toBeVisible({
    timeout: 15000,
  });
  const stored = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("switchboard")!).state;
    return state.services[0];
  });
  expect(stored).toMatchObject({ name: "Tagged PW Host", tag: "worker-A" });

  await persisted.locator(".service__head").hover();
  await persisted.getByTitle("Service actions").click();
  await page.getByRole("menuitem", { name: "Edit service" }).click();
  const edit = page.getByRole("dialog", { name: "Edit hosting service" });
  const tag = edit.getByLabel("TAG", { exact: true });
  await expect(tag).toHaveValue("worker-A");
  await expect(tag).toHaveAttribute("readonly", "");
  await expect(tag).not.toBeEditable();
  await expect(edit).toContainText(
    "To connect to another TAG, create a new service",
  );

  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(persisted.locator(".dot--online")).toBeVisible({
    timeout: 15000,
  });
  const afterEdit = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("switchboard")!).state;
    return state.services[0];
  });
  expect(afterEdit.tag).toBe("worker-A");
});

test("editing a service's token rebuilds the connection", async ({ page }) => {
  // Seed a service whose token is wrong, so it can never connect: it should be
  // registered but offline. Editing it to the right token must rebuild the pool
  // manager (which captured the bad token at construction) and come online.
  await page.addInitScript(
    ([http]) => {
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [
              { id: "pw-svc", name: "PW Host", url: http, token: "stale" },
            ],
          },
          version: 0,
        }),
      );
    },
    [HTTP],
  );
  await page.reload();

  const svc = page.locator(".service");
  await expect(svc).toHaveCount(1);
  await expect(svc.locator(".dot--online")).toHaveCount(0);

  // Open the edit dialog (via the service's ⋯ menu): fields are pre-filled.
  await page.locator(".service__head").hover();
  await page.getByTitle("Service actions").click();
  await page.getByRole("menuitem", { name: "Edit service" }).click();
  const edit = page.getByRole("dialog", { name: "Edit hosting service" });
  await expect(edit.getByPlaceholder("hostname or IP")).toHaveValue(HOST);
  await expect(edit.getByPlaceholder("8787")).toHaveValue(PORT);

  // A still-wrong token is rejected inline.
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit.locator(".hint--error")).toHaveText("Invalid token.");

  // Fixing the token verifies, saves, and the rebuilt manager dials online.
  await edit.locator('input[type="password"]').fill(TOKEN);
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(edit).toBeHidden();
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
});
