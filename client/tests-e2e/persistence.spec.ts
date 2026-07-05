import { expect, test } from "@playwright/test";

import { HOST, PORT, TOKEN } from "./constants";

// Reproduces the user-reported bug: after deleting a service and "restarting"
// the client (page reload), the deleted service must NOT reappear.
test("a deleted service stays deleted across a reload", async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem("switchboard-client-id", id);
  }, "pw-persist-client");

  await page.goto("/");

  // Add a service through the real UI flow.
  await page.getByTitle("Add service").click();
  const dialog = page.getByRole("dialog", { name: "Add hosting service" });
  await dialog.getByPlaceholder("Laptop / prod-box").fill("Demo");
  // Harness server runs plain http; point the fields at the live PW host.
  await dialog.getByRole("radio", { name: "http", exact: true }).check();
  await dialog.getByPlaceholder("hostname or IP").fill(HOST);
  await dialog.getByPlaceholder("8787").fill(PORT);
  await dialog.locator('input[type="password"]').fill(TOKEN);
  await page.getByRole("button", { name: "Add" }).click();

  const service = page.locator(".service", { hasText: "Demo" });
  await expect(service).toBeVisible();

  // Sanity: it persists across a reload while it still exists.
  await page.reload();
  await expect(page.locator(".service", { hasText: "Demo" })).toBeVisible();

  // Delete it via the two-click "Sure?" confirm. Locate the button by position
  // (last button in the service header) since its title/text flip when armed.
  const del = page
    .locator(".service", { hasText: "Demo" })
    .locator(".service__head")
    .getByRole("button")
    .last();
  await del.click(); // arm
  await del.click(); // confirm
  await expect(page.locator(".service", { hasText: "Demo" })).toHaveCount(0);

  // The crux: after a reload it must not come back.
  await page.reload();
  await expect(page.locator(".service", { hasText: "Demo" })).toHaveCount(0);
});
