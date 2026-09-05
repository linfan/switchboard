import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// Long-line wrap belongs to a tab, not to the app: the Auto-wrap/No-wrap
// toggle flips the live view in place, a tab starts from the persisted default,
// closing a tab forgets its choice, and read-only diff tabs (including a layout
// switch, which rebuilds the view) honour it too.
let dir: string;

const longLine = (tag: string) => `${tag} ${"word ".repeat(300)}`;

/** Seed one service + workspace over `dir` and open the app on it. */
async function boot(page: Page, state: Record<string, unknown> = {}) {
  await page.addInitScript(
    ([http, token, cwd, extra]) => {
      // Runs on every navigation, so it must not overwrite what the app has
      // since persisted — a reload is how the last test checks durability.
      if (localStorage.getItem("switchboard")) return;
      localStorage.setItem(
        "switchboard",
        JSON.stringify({
          state: {
            services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            workspaces: [
              { id: "pw-ws", serviceId: "pw-svc", name: "wrap", cwd },
            ],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
            ...extra,
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-wrap-client");
    },
    [HTTP, TOKEN, dir, state],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
}

const wrapRadio = (page: Page, name: "Auto-wrap" | "No-wrap"): Locator =>
  page.getByRole("radio", { name });
/** The active tab's editor content — only that view is attached to the DOM. */
const content = (page: Page): Locator =>
  page.locator(".weditor__cm .cm-content");

const openFile = async (page: Page, name: string) => {
  await page
    .locator(".weditor__panel--tree .weditor__row--file", { hasText: name })
    .click();
  await expect(content(page)).toBeVisible();
};

/** True while the longest line is wider than the pane, i.e. nothing wraps. */
const overflows = (page: Page) =>
  page
    .locator(".weditor__cm .cm-scroller")
    .evaluate((el) => el.scrollWidth > el.clientWidth + 8);

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-wrap-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("wraps only the tab it was toggled on", async ({ page }) => {
  writeFileSync(join(dir, "alpha.txt"), longLine("alpha"));
  writeFileSync(join(dir, "beta.txt"), longLine("beta"));
  await boot(page);

  await openFile(page, "alpha.txt");
  await expect(wrapRadio(page, "Auto-wrap")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(content(page)).not.toHaveClass(/cm-lineWrapping/);
  await expect.poll(() => overflows(page)).toBe(true);

  await wrapRadio(page, "Auto-wrap").click();
  await expect(wrapRadio(page, "Auto-wrap")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(content(page)).toHaveClass(/cm-lineWrapping/);
  await expect.poll(() => overflows(page)).toBe(false);

  // beta is seeded from the default, not from alpha's choice.
  await openFile(page, "beta.txt");
  await expect(wrapRadio(page, "Auto-wrap")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(content(page)).not.toHaveClass(/cm-lineWrapping/);

  // alpha kept its choice across the tab switch (its view is re-parented).
  await page.locator(".weditor__tab", { hasText: "alpha.txt" }).click();
  await expect(content(page)).toHaveClass(/cm-lineWrapping/);

  // Closing the tab forgets it: a reopen starts from the default again.
  await page
    .locator(".weditor__tab", { hasText: "alpha.txt" })
    .locator(".weditor__tab-close")
    .click();
  await openFile(page, "alpha.txt");
  await expect(wrapRadio(page, "Auto-wrap")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(content(page)).not.toHaveClass(/cm-lineWrapping/);
});

test("the settings default seeds tabs opened after it", async ({ page }) => {
  writeFileSync(join(dir, "alpha.txt"), longLine("alpha"));
  writeFileSync(join(dir, "beta.txt"), longLine("beta"));
  await boot(page);

  // Off by default, and the already-open editor is left alone.
  await openFile(page, "alpha.txt");
  await expect(content(page)).not.toHaveClass(/cm-lineWrapping/);

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByLabel("Wrap text", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toHaveCount(0);

  // alpha was built before the change, so it keeps its state...
  await expect(content(page)).not.toHaveClass(/cm-lineWrapping/);
  // ...while a tab opened now is seeded wrapped.
  await openFile(page, "beta.txt");
  await expect(wrapRadio(page, "Auto-wrap")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(content(page)).toHaveClass(/cm-lineWrapping/);

  // The per-tab toggle still overrides the default.
  await wrapRadio(page, "No-wrap").click();
  await expect(content(page)).not.toHaveClass(/cm-lineWrapping/);

  // The default survives a reload (it is persisted).
  await page.reload();
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
  await openFile(page, "alpha.txt");
  await expect(content(page)).toHaveClass(/cm-lineWrapping/);
});

test("diff tabs wrap too and keep it across a layout switch", async ({
  page,
}) => {
  writeFileSync(join(dir, "alpha.txt"), longLine("alpha"));
  execSync(
    "git init -q . && git add -A && " +
      "git -c user.email=pw@local -c user.name=pw commit -qm init",
    { cwd: dir },
  );
  writeFileSync(join(dir, "alpha.txt"), `${longLine("alpha")}\nmodified`);
  await boot(page);

  await page
    .locator(".weditor__commit", { hasText: "Uncommitted changes" })
    .click();
  await page
    .locator(".weditor__panel--changes .weditor__row--file", {
      hasText: "alpha.txt",
    })
    .click();
  await expect(content(page)).toBeVisible();

  await wrapRadio(page, "Auto-wrap").click();
  await expect(content(page)).toHaveClass(/cm-lineWrapping/);

  // The layout switch rebuilds the view from cache; the choice must come with it.
  await page.getByRole("radio", { name: "Side-by-side" }).click();
  const panes = content(page);
  await expect(panes).toHaveCount(2);
  await expect(panes).toHaveClass([/cm-lineWrapping/, /cm-lineWrapping/]);

  await wrapRadio(page, "No-wrap").click();
  await expect(panes).not.toHaveClass([/cm-lineWrapping/, /cm-lineWrapping/]);
});
