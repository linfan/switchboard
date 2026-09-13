import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// "Copy path" is a two-level menu: the row only slides out "Absolute path" and
// "Relative path", and picking one is what writes the clipboard. The relative
// form is measured from the workspace root as the host spelled it, which on a
// symlinked directory differs from the cwd the client stores.
let dir: string;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-copypath-"));
  mkdirSync(join(dir, "src", "net"), { recursive: true });
  writeFileSync(join(dir, "src", "net", "pool.ts"), "export {};\n");

  await page.addInitScript(
    ([http, token, cwd]) => {
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            workspaces: [{ id: "pw-ws", serviceId: "pw-svc", name: "cp", cwd }],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-copypath-client");
    },
    [HTTP, TOKEN, dir],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  await page.locator(".weditor__row--dir", { hasText: "src" }).click();
  await page.locator(".weditor__row--dir", { hasText: "net" }).click();
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function openCopyMenu(page: import("@playwright/test").Page) {
  await page
    .locator(".weditor__row--file", { hasText: "pool.ts" })
    .click({ button: "right" });
  await expect(page.locator(".menu__item--sub")).toHaveText("Copy file path");
  await page.locator(".menu__item--sub").hover();
  await expect(page.locator(".menu--sub")).toBeVisible();
}

test("hovering the row slides out both path flavours", async ({ page }) => {
  await openCopyMenu(page);
  await expect(page.locator(".menu--sub .menu__item")).toHaveText([
    "Absolute path",
    "Relative path",
  ]);
});

test("the relative item copies the path from the workspace root down", async ({
  page,
}) => {
  await openCopyMenu(page);
  await page.locator(".menu--sub .menu__item", { hasText: "Relative" }).click();
  await expect(page.locator(".menu")).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "src/net/pool.ts",
  );
});

test("the absolute item copies the host path", async ({ page }) => {
  await openCopyMenu(page);
  await page.locator(".menu--sub .menu__item", { hasText: "Absolute" }).click();
  await expect(page.locator(".menu")).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    join(realpathSync(dir), "src/net/pool.ts"),
  );
});

test("leaving the row closes the submenu without copying", async ({ page }) => {
  await page.evaluate(() => navigator.clipboard.writeText("sentinel"));
  await openCopyMenu(page);
  await page.locator(".menu__item", { hasText: "Rename" }).hover();
  await expect(page.locator(".menu--sub")).toHaveCount(0, { timeout: 3000 });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "sentinel",
  );
});

test("a folder row copies its own relative path", async ({ page }) => {
  await page
    .locator(".weditor__row--dir", { hasText: "net" })
    .click({ button: "right" });
  await expect(page.locator(".menu__item--sub")).toHaveText("Copy folder path");
  await page.locator(".menu__item--sub").hover();
  await page.locator(".menu--sub .menu__item", { hasText: "Relative" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "src/net",
  );
});

test("the workspace root itself copies '.' as its relative path", async ({
  page,
}) => {
  await page
    .locator(".weditor__tree")
    .click({ button: "right", position: { x: 20, y: 260 } });
  await expect(page.locator(".menu__item--sub")).toHaveText("Copy folder path");
  await page.locator(".menu__item--sub").hover();
  await page.locator(".menu--sub .menu__item", { hasText: "Relative" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(".");
});
