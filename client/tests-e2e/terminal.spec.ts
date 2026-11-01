import { expect, test, type Page } from "@playwright/test";

import { HTTP, TOKEN } from "./constants";

interface TerminalProbe {
  active: boolean;
  topSamples: number[];
  scrollEvents: number;
  mutations: number;
  resizeCallbacks: number;
  resizeMessages: number;
}

type ProbeWindow = Window & { __terminalProbe?: TerminalProbe };

// Create a workspace (name + a real server folder) so tasks have a home. Tasks
// inherit its folder, so the New-task dialog no longer prompts for one.
async function addWorkspace(page: Page, name: string) {
  // The row's ⋯ trigger only appears on hover.
  await page.locator(".service__head").hover();
  await page.getByTitle("Service actions").click();
  await page.getByRole("menuitem", { name: "Add workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByPlaceholder("my-project").fill(name);
  await dialog.getByRole("button", { name: "Browse…" }).click();
  const picker = page.getByRole("dialog", { name: "Choose working directory" });
  await expect(picker.locator(".fs-picker__path")).not.toHaveText("…", {
    timeout: 15000,
  });
  await picker.getByRole("button", { name: "Select this folder" }).click();
  await dialog.getByRole("button", { name: "Add" }).click();
  await expect(dialog).toBeHidden();
}

// Both the workspace's New-task action and the service's Reconnect live in the
// row's ⋯ menu, which is only rendered while the row is hovered.
async function openNewTask(page: Page, workspace: string) {
  const head = page.locator(".workspace__head").filter({ hasText: workspace });
  await head.hover();
  await head.getByTitle("Workspace actions").click();
  await page.getByRole("menuitem", { name: "New task" }).click();
}

async function reconnect(page: Page) {
  await page.locator(".service__head").hover();
  await page.getByTitle("Service actions").click();
  await page.getByRole("menuitem", { name: "Reconnect now" }).click();
}

async function createTerminalTask(page: Page, title: string) {
  const uniqueTitle = `${title}-${Date.now()}-${test.info().repeatEachIndex}`;
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill(uniqueTitle);
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: uniqueTitle });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();
  await expect(page.locator(".xterm-rows")).toContainText("AGENT-READY", {
    timeout: 15000,
  });
}

async function fillScrollback(page: Page, count = 120) {
  const rows = page.locator(".xterm-rows");
  await page.locator(".xterm-screen").click();
  await page.keyboard.type(
    Array.from({ length: count }, (_, i) => `filler${i}`).join("\n") + "\n",
    { delay: 1 },
  );
  await expect(rows).toContainText(`reply:filler${count - 1}`, {
    timeout: 20000,
  });
}

// Seed a registered service into localStorage before the app boots, so the
// connection pool dials our live hosting service on load. Mirrors the zustand
// `persist` shape (partialized to { services, cursors }).
test.beforeEach(async ({ page }) => {
  // Seed only when absent so a reload keeps whatever the app itself persisted
  // (a reload test must observe real persisted state, not a fresh re-seed).
  await page.addInitScript(
    ([http, token]) => {
      if (!localStorage.getItem("switchboard")) {
        localStorage.setItem(
          "switchboard",
          JSON.stringify({
            state: {
              services: [{ id: "pw-svc", name: "PW Host", url: http, token }],
            },
            version: 0,
          }),
        );
      }
      localStorage.setItem("switchboard-client-id", "pw-client");
    },
    [HTTP, TOKEN],
  );
});

test("renders a PTY terminal, streams output, echoes input, and survives reconnect", async ({
  page,
}) => {
  await page.goto("/");

  // The pool connects; the service dot goes online.
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  // Create a task under a workspace (tool defaults to first available).
  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
  await page.getByRole("button", { name: "Create" }).click();

  // A conversation appears in the sidebar; open it.
  const conv = page.locator(".conv").first();
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  // The terminal renders and shows the agent's startup banner.
  const rows = page.locator(".xterm-rows");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });

  // Type a line; the PTY echoes it and the agent replies.
  await page.locator(".xterm-screen").click();
  await page.keyboard.type("hello");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("reply:hello", { timeout: 15000 });

  // Force a reconnect; the server redraws the screen (snapshot or byte replay),
  // so the prior output must still be present afterwards.
  await reconnect(page);
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
  await expect(rows).toContainText("reply:hello", { timeout: 15000 });
});

test("terminal screen content is restored after a full client reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  // Create a task under a workspace and drive some output into its terminal.
  // A unique title lets us re-select exactly this task after reload — the shared
  // host DB accumulates tasks across tests, so `.conv first` isn't reliable.
  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill("reload-task");
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: "reload-task" });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  const rows = page.locator(".xterm-rows");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });
  await page.locator(".xterm-screen").click();
  await page.keyboard.type("persist-me");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("reply:persist-me", { timeout: 15000 });

  // Fully reload the client (fresh page => empty in-memory xterm buffer). The
  // task must recover AND its screen must be reconstructed from the server,
  // rather than coming back blank/garbled.
  await page.reload();
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });
  await page.locator(".conv", { hasText: "reload-task" }).click();
  await expect(page.locator(".xterm-rows")).toContainText("reply:persist-me", {
    timeout: 15000,
  });
});

test("scrolling away from the last line pauses auto-follow and the lock button changes state", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill("follow-task");
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: "follow-task" });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  const rows = page.locator(".xterm-rows");
  const screen = page.locator(".xterm-screen");
  const jump = page.locator(".term-jump");
  const lockedClass = "term-jump--locked";
  const alertClass = "term-jump--alert";
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });

  // Fill the scrollback (each line comes back as an echo plus a reply) so the
  // viewport can actually leave the last line.
  await screen.click();
  await page.keyboard.type(
    Array.from({ length: 100 }, (_, i) => `filler${i}`).join("\n") + "\n",
    { delay: 1 },
  );
  const last = "reply:filler99";
  await expect(rows).toContainText(last, { timeout: 15000 });
  // Riding the bottom: lock button shows locked state.
  await expect(jump).toHaveClass(new RegExp(lockedClass));
  await expect(jump).not.toHaveClass(new RegExp(alertClass));

  // Wheel up to read history.
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -2000);
  await expect(jump).toHaveClass(new RegExp(alertClass));
  await expect(rows).not.toContainText(last);

  // Scrolling back down by hand resumes following and shows locked state again.
  await page.mouse.wheel(0, 2000);
  await expect(jump).toHaveClass(new RegExp(lockedClass));
  await expect(jump).not.toHaveClass(new RegExp(alertClass));
  await expect(rows).toContainText(last);

  // The button lands on the latest output in one click, and resumes following.
  await page.mouse.wheel(0, -2000);
  await expect(jump).toHaveClass(new RegExp(alertClass));
  await jump.click();
  await expect(jump).toHaveClass(new RegExp(lockedClass));
  await expect(jump).not.toHaveClass(new RegExp(alertClass));
  await expect(rows).toContainText(last);
});

test("control shortcuts while scrolled up leave the viewport alone, typing jumps back", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill("shortcut-task");
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: "shortcut-task" });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  const rows = page.locator(".xterm-rows");
  const screen = page.locator(".xterm-screen");
  const jump = page.locator(".term-jump");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });

  // Fill the scrollback so the viewport can leave the last line.
  await screen.click();
  await page.keyboard.type(
    Array.from({ length: 100 }, (_, i) => `filler${i}`).join("\n") + "\n",
    { delay: 1 },
  );
  const last = "reply:filler99";
  await expect(rows).toContainText(last, { timeout: 15000 });

  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -2000);
  await expect(jump).toHaveClass(/term-jump--alert/);

  // Control shortcuts (interrupt, copy) are commands sent while reading
  // history — they must not yank the viewport back to the bottom.
  await page.keyboard.press("Meta+c");
  await expect(jump).toHaveClass(/term-jump--alert/);
  await page.keyboard.press("Control+c");
  await expect(jump).toHaveClass(/term-jump--alert/);
  await expect(rows).not.toContainText(last);

  // Typing is input: the viewport returns to the cursor and resumes following.
  await page.keyboard.press("f");
  await expect(jump).not.toHaveClass(/term-jump--alert/);
  await expect(rows).toContainText(last);
});

test("re-selecting a conversation keeps the viewport pinned to the latest output", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill("repin-task");
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: "repin-task" });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  const rows = page.locator(".xterm-rows");
  const screen = page.locator(".xterm-screen");
  const jump = page.locator(".term-jump");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });

  // Build enough scrollback that a stray jump to the first line is unmistakable.
  await screen.click();
  await page.keyboard.type(
    Array.from({ length: 200 }, (_, i) => `filler${i}`).join("\n") + "\n",
    { delay: 1 },
  );
  const last = "reply:filler199";
  await expect(rows).toContainText(last, { timeout: 20000 });
  await expect(jump).toHaveClass(/term-jump--locked/);

  // Switch to the workspace view and back, which unmounts the pane and
  // re-parents the terminal's element. Removing an element zeroes its scrollTop
  // behind xterm's back, so the DOM scroller has to be put back explicitly.
  await page.locator(".workspace__head", { hasText: "proj" }).click();
  await expect(screen).toHaveCount(0);
  await conv.click();
  await expect(rows).toContainText(last, { timeout: 15000 });

  // Riding the bottom means the DOM scroller is maxed out. Left desynced it
  // sits at 0 while xterm still reports the last line.
  await expect
    .poll(() =>
      page
        .locator(".xterm-viewport")
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBe(0);

  // The next wheel notch must be a no-op at the bottom, not a jump to line 1
  // that also ends auto-follow.
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 120);
  await expect(jump).toHaveClass(/term-jump--locked/);
  await expect(rows).toContainText(last);
});

test("streaming output does not pull a scrolled-up viewport back to the bottom", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill("hold-scroll-task");
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: "hold-scroll-task" });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  const rows = page.locator(".xterm-rows");
  const screen = page.locator(".xterm-screen");
  const jump = page.locator(".term-jump");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });

  // Fill the scrollback so the viewport can leave the last line.
  await screen.click();
  await page.keyboard.type(
    Array.from({ length: 100 }, (_, i) => `filler${i}`).join("\n") + "\n",
    { delay: 1 },
  );
  const last = "reply:filler99";
  await expect(rows).toContainText(last, { timeout: 15000 });

  // Start a short burst of output, then scroll up while it is still arriving.
  await page.keyboard.type("tick:100:25");
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("tick:1", { timeout: 10000 });
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -2000);
  await expect(jump).toHaveClass(/term-jump--alert/);

  // New output must not steal the viewport: the user stays in the history
  // after several more ticks (the old write path scrolled on every chunk).
  await page.waitForTimeout(1200);
  await expect(jump).toHaveClass(/term-jump--alert/);
  await expect
    .poll(() =>
      page
        .locator(".xterm-viewport")
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeGreaterThan(100);
  await expect(rows).not.toContainText(last);

  // Jump back to the latest output and let the burst finish before the next
  // test reuses the agent.
  await jump.click();
  await expect(rows).toContainText("tick:25", { timeout: 10000 });
});

test("resizing keeps a following terminal pinned to the latest output", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".dot--online")).toBeVisible({ timeout: 15000 });

  await addWorkspace(page, "proj");
  await openNewTask(page, "proj");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title (optional)").fill("resize-pin-task");
  await dialog.getByRole("button", { name: "Create" }).click();
  const conv = page.locator(".conv", { hasText: "resize-pin-task" });
  await expect(conv).toBeVisible({ timeout: 15000 });
  await conv.click();

  const rows = page.locator(".xterm-rows");
  const jump = page.locator(".term-jump");
  await expect(rows).toContainText("AGENT-READY", { timeout: 15000 });

  await page.locator(".xterm-screen").click();
  await page.keyboard.type(
    Array.from({ length: 150 }, (_, i) => `filler${i}`).join("\n") + "\n",
    { delay: 1 },
  );
  const last = "reply:filler149";
  await expect(rows).toContainText(last, { timeout: 15000 });
  await expect(jump).toHaveClass(/term-jump--locked/);

  const bottomGap = () =>
    page
      .locator(".xterm-viewport")
      .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

  for (const size of [
    { width: 900, height: 600 },
    { width: 1300, height: 850 },
  ]) {
    await page.setViewportSize(size);
    // Reflow is asynchronous; the viewport must settle back on the last line
    // instead of being stranded one row above it (which also paused follow).
    await expect.poll(bottomGap, { timeout: 5000 }).toBeLessThanOrEqual(2);
    await expect(jump).toHaveClass(/term-jump--locked/);
    await expect(jump).not.toHaveClass(/term-jump--alert/);
    await expect(rows).toContainText(last);
  }
});

test("a wheel-up is not undone by a pending bottom scroll echo", async ({
  page,
}) => {
  await createTerminalTask(page, "wheel-echo-task");
  await fillScrollback(page);

  const rows = page.locator(".xterm-rows");
  const jump = page.locator(".term-jump");
  const viewport = page.locator(".xterm-viewport");
  await expect(jump).toHaveClass(/term-jump--locked/);
  await page.evaluate(() => {
    document.querySelector(".xterm-screen")!.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -120,
        bubbles: true,
        cancelable: true,
      }),
    );
    document
      .querySelector(".xterm-viewport")!
      .dispatchEvent(new Event("scroll"));
  });

  await expect(jump).toHaveClass(/term-jump--alert/);
  await expect
    .poll(() =>
      viewport.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBeGreaterThan(2);

  const scrollTop = await viewport.evaluate((el) => el.scrollTop);
  await page.waitForTimeout(400);
  expect(await viewport.evaluate((el) => el.scrollTop)).toBeCloseTo(
    scrollTop,
    0,
  );
  await expect(jump).toHaveClass(/term-jump--alert/);

  await jump.click();
  await expect(rows).toContainText("reply:filler119");
});

test("resize never flashes the top and becomes completely quiescent", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data) {
      const probe = (window as ProbeWindow).__terminalProbe;
      if (probe?.active && typeof data === "string") {
        try {
          const message = JSON.parse(data) as { type?: string };
          if (message.type === "resize") probe.resizeMessages++;
        } catch {
          // Ignore non-JSON WebSocket frames.
        }
      }
      return send.call(this, data);
    };
  });
  await createTerminalTask(page, "resize-quiet-task");
  await fillScrollback(page, 150);
  await expect(page.locator(".term-jump")).toHaveClass(/term-jump--locked/);

  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>(".xterm-viewport");
    const rows = document.querySelector<HTMLElement>(".xterm-rows");
    const host = document.querySelector<HTMLElement>(".term-pane");
    if (!viewport || !rows || !host) throw new Error("terminal not mounted");
    const probe: TerminalProbe = {
      active: true,
      topSamples: [],
      scrollEvents: 0,
      mutations: 0,
      resizeCallbacks: 0,
      resizeMessages: 0,
    };
    (window as ProbeWindow).__terminalProbe = probe;
    const sampleTop = () => {
      if (
        probe.active &&
        viewport.scrollHeight - viewport.clientHeight > 100 &&
        viewport.scrollTop <= 2
      ) {
        probe.topSamples.push(viewport.scrollTop);
      }
    };
    viewport.addEventListener("scroll", () => {
      if (!probe.active) return;
      probe.scrollEvents++;
      sampleTop();
    });
    new MutationObserver(() => {
      if (probe.active) probe.mutations++;
    }).observe(rows, { childList: true, characterData: true, subtree: true });
    new ResizeObserver(() => {
      if (probe.active) probe.resizeCallbacks++;
    }).observe(host);
    const frame = () => {
      if (!probe.active) return;
      sampleTop();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  const bottomGap = () =>
    page
      .locator(".xterm-viewport")
      .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  for (const size of [
    { width: 900, height: 600 },
    { width: 1300, height: 850 },
    { width: 1301, height: 850 },
  ]) {
    await page.setViewportSize(size);
    await expect.poll(bottomGap, { timeout: 5000 }).toBeLessThanOrEqual(2);
  }
  await expect(page.locator(".xterm-rows")).toContainText("reply:filler149");
  const topSamples = await page.evaluate(
    () => (window as ProbeWindow).__terminalProbe!.topSamples,
  );
  expect(topSamples).toEqual([]);

  await page.waitForTimeout(750);
  await page.evaluate(() => {
    const probe = (window as ProbeWindow).__terminalProbe!;
    probe.scrollEvents = 0;
    probe.mutations = 0;
    probe.resizeCallbacks = 0;
    probe.resizeMessages = 0;
  });
  await page.waitForTimeout(1000);
  const quiet = await page.evaluate(() => {
    const probe = (window as ProbeWindow).__terminalProbe!;
    probe.active = false;
    return {
      scrollEvents: probe.scrollEvents,
      mutations: probe.mutations,
      resizeCallbacks: probe.resizeCallbacks,
      resizeMessages: probe.resizeMessages,
    };
  });
  expect(quiet).toEqual({
    scrollEvents: 0,
    mutations: 0,
    resizeCallbacks: 0,
    resizeMessages: 0,
  });
});

test("resize preserves a history viewport near its previous distance from bottom", async ({
  page,
}) => {
  await createTerminalTask(page, "resize-history-task");
  await fillScrollback(page, 150);

  const screen = page.locator(".xterm-screen");
  const jump = page.locator(".term-jump");
  const box = await screen.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -1000);
  await expect(jump).toHaveClass(/term-jump--alert/);

  const readPosition = () =>
    page.locator(".xterm-viewport").evaluate((viewport) => {
      const screen = document.querySelector<HTMLElement>(".xterm-screen")!;
      const rowCount = document.querySelector(".xterm-rows")!.childElementCount;
      const rowHeight = screen.getBoundingClientRect().height / rowCount;
      return {
        gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        rowHeight,
        scrollTop: viewport.scrollTop,
      };
    });

  for (const size of [
    { width: 900, height: 600 },
    { width: 700, height: 650 },
  ]) {
    const before = await readPosition();
    await page.setViewportSize(size);
    await expect
      .poll(async () => {
        const after = await readPosition();
        return Math.abs(after.gap - before.gap) / after.rowHeight;
      })
      .toBeLessThanOrEqual(2);
    const after = await readPosition();
    expect(after.gap).toBeGreaterThan(after.rowHeight * 2);
    await expect(jump).toHaveClass(/term-jump--alert/);
  }
});

test("hosting service reports healthy over REST", async ({ request }) => {
  const res = await request.get(`${HTTP}/health`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.status).toBe("ok");
});
