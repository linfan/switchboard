import { describe, expect, it } from "vitest";

import { BUILD_INFO, formatBuildTime } from "./buildInfo";

describe("formatBuildTime", () => {
  it("renders a UTC stamp in local time", () => {
    // Built from local parts so the expectation holds in any timezone.
    const d = new Date(2026, 7, 11, 14, 32, 9);
    expect(formatBuildTime(d.toISOString())).toBe("2026-08-11 14:32");
  });

  it("zero-pads month, day, hour and minute", () => {
    const d = new Date(2026, 0, 2, 3, 4, 0);
    expect(formatBuildTime(d.toISOString())).toBe("2026-01-02 03:04");
  });

  it("passes through a stamp it cannot parse", () => {
    expect(formatBuildTime("not-a-date")).toBe("not-a-date");
  });

  it("reports an empty stamp as unknown", () => {
    expect(formatBuildTime("")).toBe("unknown");
  });
});

describe("BUILD_INFO", () => {
  it("is stamped at build time", () => {
    expect(BUILD_INFO.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Number.isNaN(new Date(BUILD_INFO.builtAt).getTime())).toBe(false);
    expect(BUILD_INFO.commit).not.toBe("");
  });
});
