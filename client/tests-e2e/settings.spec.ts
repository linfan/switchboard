import { expect, test } from "@playwright/test";

// The dialog is reachable from the sidebar gear on every platform (the macOS
// menu item drives the same store flag, which no browser test can click).
const open = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  return page.getByRole("dialog", { name: "Settings" });
};

const field = (dialog: import("@playwright/test").Locator, label: string) =>
  dialog.getByLabel(label, { exact: true });

test("edits persist across a reload", async ({ page }) => {
  await page.goto("/");

  let dialog = await open(page);
  await field(dialog, "Image").fill("64");
  await field(dialog, "Terminal").fill("17");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  dialog = await open(page);
  await expect(field(dialog, "Image")).toHaveValue("64");
  await expect(field(dialog, "Terminal")).toHaveValue("17");
});

// Both default to 50; the tree's selection cap and the upload picker read them.
test("the batch transfer caps are editable and ship at 50", async ({
  page,
}) => {
  await page.goto("/");

  let dialog = await open(page);
  await expect(field(dialog, "Max files per upload")).toHaveValue("50");
  await expect(field(dialog, "Max files per download")).toHaveValue("50");
  await field(dialog, "Max files per upload").fill("8");
  await dialog.getByRole("button", { name: "Save" }).click();

  await page.reload();
  dialog = await open(page);
  await expect(field(dialog, "Max files per upload")).toHaveValue("8");
});

test("Cancel discards edits", async ({ page }) => {
  await page.goto("/");

  let dialog = await open(page);
  const before = await field(dialog, "Directory budget").inputValue();
  await field(dialog, "Directory budget").fill("999");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  dialog = await open(page);
  await expect(field(dialog, "Directory budget")).toHaveValue(before);
});

test("blocks Save on an out-of-range value", async ({ page }) => {
  await page.goto("/");

  const dialog = await open(page);
  const save = dialog.getByRole("button", { name: "Save" });
  await field(dialog, "Maximum depth").fill("0"); // below its minimum of 1
  await expect(save).toBeDisabled();
  await expect(dialog.locator(".hint--error")).toBeVisible();

  await field(dialog, "Maximum depth").fill("8");
  await expect(save).toBeEnabled();
});

// A heartbeat timeout at or above the interval would be re-armed by the next
// ping before it could fire, silently disabling dead-link detection.
test("blocks Save when the heartbeat timeout would never fire", async ({
  page,
}) => {
  await page.goto("/");

  const dialog = await open(page);
  const save = dialog.getByRole("button", { name: "Save" });
  await field(dialog, "Heartbeat interval").fill("10000");
  await field(dialog, "Heartbeat timeout").fill("10000");
  await expect(save).toBeDisabled();
  await expect(
    dialog.getByText("must be shorter than the heartbeat interval", {
      exact: false,
    }),
  ).toBeVisible();

  await field(dialog, "Heartbeat timeout").fill("9000");
  await expect(save).toBeEnabled();
});

test("the Hotkeys tab lists the shortcuts and keeps pending edits", async ({
  page,
}) => {
  await page.goto("/");

  const dialog = await open(page);
  await field(dialog, "Image").fill("64");

  await dialog.getByRole("tab", { name: "Hotkeys" }).click();
  await expect(dialog.getByText("Zoom in (larger font)")).toBeVisible();
  await expect(field(dialog, "Image")).toHaveCount(0);

  await dialog.getByRole("tab", { name: "General" }).click();
  await expect(field(dialog, "Image")).toHaveValue("64");
});

test("Restore defaults refills the form but needs a Save to stick", async ({
  page,
}) => {
  await page.goto("/");

  let dialog = await open(page);
  const image = field(dialog, "Image");
  const shipped = await image.inputValue();
  await image.fill("64");
  await dialog.getByRole("button", { name: "Save" }).click();

  dialog = await open(page);
  await expect(field(dialog, "Image")).toHaveValue("64");
  await dialog.getByRole("button", { name: "Restore defaults" }).click();
  await expect(field(dialog, "Image")).toHaveValue(shipped);

  // Cancelling out leaves the saved value alone — defaults were only previewed.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  dialog = await open(page);
  await expect(field(dialog, "Image")).toHaveValue("64");
});
