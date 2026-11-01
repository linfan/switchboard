import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

// The Changes panel reads `git status` output, which is easy to get wrong for
// two kinds of names: non-ASCII paths (git octal-escapes them unless asked not
// to) and paths inside a brand-new directory (git collapses them into a single
// "dir/" entry unless asked to expand).
let dir: string;

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
              { id: "pw-ws", serviceId: "pw-svc", name: "gitp", cwd },
            ],
            selectedWorkspaceId: "pw-ws",
            editorState: {},
          },
          version: 0,
        }),
      );
      localStorage.setItem("switchboard-client-id", "pw-git-client");
    },
    [HTTP, TOKEN, dir],
  );
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
}

const changedFile = (page: Page, path: string): Locator =>
  page.locator(`.weditor__panel--changes .weditor__row--file[title="${path}"]`);

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "swb-e2e-git-"));
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("uncommitted lists new files by name, including non-ASCII paths", async ({
  page,
}) => {
  writeFileSync(join(dir, "中文.txt"), "one\n");
  execSync(
    "git init -q . && git add -A && " +
      "git -c user.email=pw@local -c user.name=pw commit -qm init",
    { cwd: dir },
  );
  writeFileSync(join(dir, "中文.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "全新.txt"), "new\n");
  mkdirSync(join(dir, "新目录"));
  writeFileSync(join(dir, "新目录", "内文件.txt"), "inner\n");

  await boot(page);
  await page
    .locator(".weditor__commit", { hasText: "Uncommitted changes" })
    .click();

  // Names are UTF-8, not octal-escaped `\346…` sequences.
  await expect(changedFile(page, "中文.txt")).toContainText("中文.txt");
  await expect(changedFile(page, "全新.txt")).toContainText("全新.txt");
  // The untracked directory is expanded, so its file has a name of its own
  // instead of a bare "??" row for "新目录/".
  await expect(changedFile(page, "新目录/内文件.txt")).toContainText(
    "内文件.txt",
  );
  await expect(page.locator(".weditor__panel--changes")).not.toContainText(
    "\\3",
  );

  // Untracked files read as added, not as the raw porcelain "??".
  await expect(
    changedFile(page, "全新.txt").locator(".weditor__status"),
  ).toHaveText("A");
  await expect(page.locator(".weditor__panel--changes")).not.toContainText(
    "??",
  );
});
