import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// A markdown tab renders its document (sanitized HTML, images fetched through
// the authenticated preview path) with the raw source one toggle away. The
// rendered-vs-source choice belongs to the tab and is forgotten when it closes.
let dir: string;

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
            workspaces: [{ id: "pw-ws", serviceId: "pw-svc", name: "md", cwd }],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-md-client");
    },
    [HTTP, TOKEN, dir],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
}

const viewRadio = (page: Page, name: "Preview" | "Source"): Locator =>
  page.getByRole("radio", { name });
/** The active tab's rendered pane — only it is attached while previewing. */
const preview = (page: Page): Locator => page.locator(".weditor__md");
/** The active tab's editor content — the source view behind the pane. */
const source = (page: Page): Locator =>
  page.locator(".weditor__cm .cm-content");

const openFile = async (page: Page, name: string) => {
  await page
    .locator(".weditor__panel--tree .weditor__row--file", { hasText: name })
    .click();
};

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-md-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("renders markdown by default and toggles to the source", async ({
  page,
}) => {
  writeFileSync(
    join(dir, "README.md"),
    [
      "# Switchboard",
      "",
      "See the [notes](notes.txt) file.",
      "",
      "- one",
      "- two",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "```rs",
      "fn main() {}",
      "```",
    ].join("\n"),
  );
  writeFileSync(join(dir, "notes.txt"), "hello note\n");
  await boot(page);

  await openFile(page, "README.md");
  await expect(preview(page)).toBeVisible();
  await expect(preview(page).locator("h1")).toHaveText("Switchboard");
  await expect(preview(page).getByRole("listitem")).toHaveCount(2);
  await expect(preview(page).locator("th")).toHaveCount(2);
  await expect(preview(page).locator("td")).toHaveCount(2);
  await expect(preview(page).locator("pre code")).toHaveText("fn main() {}");
  // Rendered by default; the editor view waits hidden behind the pane.
  await expect(viewRadio(page, "Preview")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(source(page)).toBeHidden();

  // A relative link opens the target as an editor tab, not a navigation.
  await preview(page).getByRole("link", { name: "notes" }).click();
  await expect(source(page)).toBeVisible();
  await expect(source(page)).toContainText("hello note");
  await expect(
    page.locator(".weditor__tab", { hasText: "notes.txt" }),
  ).toHaveClass(/is-active/);

  // Back on README: toggle to the source and edit; the pane renders the live
  // buffer, unsaved edits included.
  await page.locator(".weditor__tab", { hasText: "README.md" }).click();
  await viewRadio(page, "Source").click();
  await expect(source(page)).toBeVisible();
  await expect(preview(page)).toHaveCount(0);
  await expect(viewRadio(page, "Source")).toHaveAttribute(
    "aria-checked",
    "true",
  );

  await source(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("# Rewritten\n");
  await viewRadio(page, "Preview").click();
  await expect(preview(page).locator("h1")).toHaveText("Rewritten");

  // A plain text tab gets no view toggle — and its own controls come back.
  await page.locator(".weditor__tab", { hasText: "notes.txt" }).click();
  await expect(viewRadio(page, "Preview")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Auto-wrap" })).toBeVisible();
});

test("the rendered-vs-source choice belongs to the tab", async ({ page }) => {
  writeFileSync(join(dir, "alpha.md"), "# Alpha\n");
  writeFileSync(join(dir, "beta.md"), "# Beta\n");
  await boot(page);

  await openFile(page, "alpha.md");
  await expect(preview(page).locator("h1")).toHaveText("Alpha");
  await viewRadio(page, "Source").click();
  await expect(source(page)).toBeVisible();

  // beta starts rendered, untouched by alpha's choice.
  await openFile(page, "beta.md");
  await expect(preview(page).locator("h1")).toHaveText("Beta");

  // alpha kept its choice across the switch (its view is re-parented).
  await page.locator(".weditor__tab", { hasText: "alpha.md" }).click();
  await expect(source(page)).toBeVisible();

  // Closing the tab forgets it: a reopen starts rendered again.
  await page
    .locator(".weditor__tab", { hasText: "alpha.md" })
    .locator(".weditor__tab-close")
    .click();
  await openFile(page, "alpha.md");
  await expect(preview(page).locator("h1")).toHaveText("Alpha");
});

test("renders relative images fetched through the signed API", async ({
  page,
}) => {
  writeFileSync(join(dir, "pic.png"), Buffer.from(PNG_1PX, "base64"));
  writeFileSync(
    join(dir, "README.md"),
    "# Shots\n\n![tiny](pic.png)\n\n![gone](missing.png)\n",
  );
  await boot(page);

  await openFile(page, "README.md");
  // The relative src is swapped for an authenticated preview URL (a blob: URL
  // in the browser build) and actually decodes.
  const img = preview(page).locator('img[alt="tiny"]');
  await expect
    .poll(() => img.evaluate((el) => el.src.startsWith("blob:")))
    .toBe(true);
  await expect
    .poll(() => img.evaluate((el) => el.naturalWidth))
    .toBeGreaterThan(0);
  // A missing image keeps its alt text instead of failing the render.
  await expect(preview(page).locator('img[alt="gone"]')).toHaveCount(1);
});
