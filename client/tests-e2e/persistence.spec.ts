import { expect, test } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// Reproduces the user-reported bug: after deleting a service and "restarting"
// the client (page reload), the deleted service must NOT reappear.
test("a deleted service stays deleted across a reload", async ({ page }) => {
  await page.addInitScript((id) => {
    localStorage.setItem("switchboard-client-id", id);
  }, "pw-persist-client");

  await page.goto("/");

  // Add a service through the real UI flow.
  await page.getByTitle("Add service").click();
  await page.getByRole("textbox").first().fill("Demo");
  // URL + token fields come pre-filled; point them at the live PW host.
  const inputs = page.locator(".modal input");
  await inputs.nth(1).fill(HTTP);
  await inputs.nth(2).fill(TOKEN);
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
