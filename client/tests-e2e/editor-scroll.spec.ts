import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// A tab's scroll position and caret must survive switching away and back:
// the live view is re-parented, and detaching a node resets its scroll offsets.
let dir: string;

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-scroll-"));
  const long = (tag: string) =>
    Array.from({ length: 400 }, (_, i) => `${tag} line ${i + 1}`).join("\n");
  writeFileSync(join(dir, "alpha.txt"), long("alpha"));
  writeFileSync(join(dir, "beta.txt"), long("beta"));

  await page.addInitScript(
    ([http, token, cwd]) => {
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            workspaces: [
              { id: "pw-ws", serviceId: "pw-svc", name: "scroll", cwd },
            ],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-scroll-client");
    },
    [HTTP, TOKEN, dir],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("switching tabs keeps each file's scroll position and caret", async ({
  page,
}) => {
  const openFile = async (name: string) => {
    await page.locator(".weditor__row--file", { hasText: name }).click();
    await expect(page.locator(".weditor__cm .cm-content")).toBeVisible();
  };

  await openFile("alpha.txt");
  await openFile("beta.txt");
  await page.locator(".weditor__tab", { hasText: "alpha.txt" }).click();

  // Put the caret deep into alpha, which scrolls the view down with it.
  await page.locator(".weditor__cm .cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
  const scroller = page.locator(".weditor__cm .cm-scroller");
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  const before = await scroller.evaluate((el) => el.scrollTop);
  await expect(page.locator(".weditor__cm .cm-activeLine")).toContainText(
    "alpha line 400",
  );

  // Away to beta (which is still at the top) and back to alpha.
  await page.locator(".weditor__tab", { hasText: "beta.txt" }).click();
  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeLessThan(10);
  await page.locator(".weditor__tab", { hasText: "alpha.txt" }).click();

  await expect
    .poll(() => scroller.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(before - 5);
  await expect(page.locator(".weditor__cm .cm-activeLine")).toContainText(
    "alpha line 400",
  );
});
