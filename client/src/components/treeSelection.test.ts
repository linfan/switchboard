import { describe, expect, it } from "vitest";

import {
  emptySelection,
  nextSelection,
  selectOnly,
  visibleFilePaths,
} from "./treeSelection";

const VISIBLE = ["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/d.ts"];
const plain = { toggle: false, range: false };
const cmd = { toggle: true, range: false };
const shift = { toggle: false, range: true };

const picked = (...paths: string[]) => ({
  paths: new Set(paths),
  anchor: paths[0] ?? null,
  hitCap: false,
});

describe("nextSelection", () => {
  it("replaces the selection and moves the anchor on a plain click", () => {
    const next = nextSelection(
      picked("/r/a.ts"),
      "/r/c.ts",
      VISIBLE,
      plain,
      50,
    );
    expect(next.paths).toEqual(new Set(["/r/c.ts"]));
    expect(next.anchor).toBe("/r/c.ts");
  });

  it("toggles membership on ⌘/Ctrl, in both directions", () => {
    const one = nextSelection(emptySelection(), "/r/a.ts", VISIBLE, cmd, 50);
    const two = nextSelection(one, "/r/b.ts", VISIBLE, cmd, 50);
    expect(two.paths).toEqual(new Set(["/r/a.ts", "/r/b.ts"]));
    const three = nextSelection(two, "/r/a.ts", VISIBLE, cmd, 50);
    expect(three.paths).toEqual(new Set(["/r/b.ts"]));
  });

  it("refuses to add past the cap and says so", () => {
    const one = nextSelection(emptySelection(), "/r/a.ts", VISIBLE, cmd, 1);
    const capped = nextSelection(one, "/r/b.ts", VISIBLE, cmd, 1);
    expect(capped.paths).toEqual(new Set(["/r/a.ts"]));
    expect(capped.hitCap).toBe(true);
    expect(capped.anchor).toBe(one.anchor);
  });

  it("selects the visible range from the anchor, either direction", () => {
    const down = nextSelection(
      picked("/r/a.ts"),
      "/r/c.ts",
      VISIBLE,
      shift,
      50,
    );
    expect(down.paths).toEqual(new Set(["/r/a.ts", "/r/b.ts", "/r/c.ts"]));
    const up = nextSelection(picked("/r/d.ts"), "/r/b.ts", VISIBLE, shift, 50);
    expect(up.paths).toEqual(new Set(["/r/b.ts", "/r/c.ts", "/r/d.ts"]));
  });

  it("keeps the anchor so a second range extends the same one", () => {
    const next = nextSelection(
      picked("/r/a.ts"),
      "/r/b.ts",
      VISIBLE,
      shift,
      50,
    );
    expect(next.anchor).toBe("/r/a.ts");
  });

  it("unions onto ⌘-picked rows outside the range", () => {
    const prev = picked("/r/a.ts");
    prev.paths.add("/r/d.ts");
    const next = nextSelection(prev, "/r/c.ts", VISIBLE, shift, 50);
    expect(next.paths).toEqual(
      new Set(["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/d.ts"]),
    );
  });

  it("stops a range at the cap", () => {
    const next = nextSelection(picked("/r/a.ts"), "/r/d.ts", VISIBLE, shift, 2);
    expect([...next.paths]).toEqual(["/r/a.ts", "/r/b.ts"]);
    expect(next.hitCap).toBe(true);
  });

  it("falls back to a plain pick when the anchor is no longer rendered", () => {
    const prev = picked("/gone/x.ts");
    const next = nextSelection(prev, "/r/d.ts", VISIBLE, shift, 50);
    expect(next.paths).toEqual(new Set(["/r/d.ts"]));
    expect(next.anchor).toBe("/r/d.ts");
  });
});

describe("selectOnly", () => {
  it("collapses everything to the one row a menu is opening on", () => {
    const next = selectOnly("/r/b.ts");
    expect(next.paths).toEqual(new Set(["/r/b.ts"]));
    expect(next.anchor).toBe("/r/b.ts");
  });
});

describe("visibleFilePaths", () => {
  it("reads rendered file rows in document order, ignoring folders", () => {
    const tree = document.createElement("div");
    tree.innerHTML = `
      <div class="weditor__row weditor__row--dir" data-path="/r"></div>
      <div class="weditor__row weditor__row--file" data-path="/r/a.ts"></div>
      <div class="weditor__row weditor__row--file" data-path="/r/b.ts"></div>`;
    expect(visibleFilePaths(tree)).toEqual(["/r/a.ts", "/r/b.ts"]);
  });
});
