import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// SVG files open as editable text tabs with a rendered preview: Preview is the
// default, Source exposes the CodeMirror buffer (saved like any file), and the
// preview follows that live buffer when toggled back.

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">',
  '  <rect width="40" height="20" fill="#ff3366"/>',
  "</svg>",
].join("\n");

const WIDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><rect width="80" height="20" fill="#3366ff"/></svg>';

let dir: string;

/** Seed one service + workspace over `dir` and open the app on it. */
async function boot(page: Page) {
  await page.addInitScript(
    ([http, token, cwd]) => {
      if (localStorage.getItem("switchboard")) return;
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            workspaces: [
              { id: "pw-ws", serviceId: "pw-svc", name: "svg", cwd },
            ],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-svg-client");
    },
    [HTTP, TOKEN, dir],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
}

const viewRadio = (page: Page, name: "Preview" | "Source"): Locator =>
  page.getByRole("radio", { name });
const preview = (page: Page): Locator => page.locator(".weditor__svg img");
const source = (page: Page): Locator =>
  page.locator(".weditor__cm .cm-content");

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-svg-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("previews SVG by default and toggles to an editable source", async ({
  page,
}) => {
  writeFileSync(join(dir, "logo.svg"), SVG);
  await boot(page);

  await page
    .locator(".weditor__panel--tree .weditor__row--file", {
      hasText: "logo.svg",
    })
    .click();

  // Preview is the default: the buffer renders as an image, not source text.
  await expect(viewRadio(page, "Preview")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(preview(page)).toBeVisible();
  await expect
    .poll(() => preview(page).evaluate((el) => el.naturalWidth))
    .toBe(40);
  await expect(page.locator(".weditor__cm")).toBeHidden();

  await expect(page.getByRole("group", { name: "Image zoom" })).toBeVisible();
  const zoomLabel = page.locator(".weditor__zoom-pct");
  await expect(zoomLabel).toHaveText("100%");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomLabel).toHaveText("150%");

  // Source exposes the editable CodeMirror buffer; image-only controls go away.
  await viewRadio(page, "Source").click();
  await expect(viewRadio(page, "Source")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(preview(page)).toHaveCount(0);
  await expect(page.locator(".weditor__cm")).toBeVisible();
  await expect(source(page)).toContainText("<svg");
  await expect(page.getByRole("group", { name: "Image zoom" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Auto-wrap" })).toBeVisible();

  // An unsaved edit is marked dirty and feeds the preview when toggled back.
  await source(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(WIDER_SVG);
  await expect(
    page.locator(".weditor__tab", { hasText: "logo.svg" }),
  ).toContainText("●");
  await viewRadio(page, "Preview").click();
  await expect(preview(page)).toBeVisible();
  await expect
    .poll(() => preview(page).evaluate((el) => el.naturalWidth))
    .toBe(80);

  // The preview pane still saves the buffer like any other edit tab.
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    page.locator(".weditor__tab", { hasText: "logo.svg" }),
  ).not.toContainText("●");

  // Source keeps the same live buffer, not a reload from disk.
  await viewRadio(page, "Source").click();
  await expect(source(page)).toContainText('width="80"');
});
