import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// SVG files preview as images like the raster formats do: an `<img>` fed by the
// signed download endpoint, with the image zoom controls — not a CodeMirror tab.

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20">',
  '  <rect width="40" height="20" fill="#ff3366"/>',
  "</svg>",
].join("\n");

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

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-svg-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("previews SVG as an image with zoom controls", async ({ page }) => {
  writeFileSync(join(dir, "logo.svg"), SVG);
  await boot(page);

  await page
    .locator(".weditor__panel--tree .weditor__row--file", {
      hasText: "logo.svg",
    })
    .click();

  const img = page.locator(".weditor__media");
  await expect(img).toBeVisible();
  // The bytes decoded as an image, not shown as source text.
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(40);
  await expect.poll(() => img.evaluate((el) => el.naturalHeight)).toBe(20);
  await expect(page.locator(".weditor__cm .cm-content")).toHaveCount(0);

  await expect(page.getByRole("group", { name: "Image zoom" })).toBeVisible();
  const zoomLabel = page.locator(".weditor__zoom-pct");
  await expect(zoomLabel).toHaveText("100%");
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomLabel).toHaveText("150%");
});
