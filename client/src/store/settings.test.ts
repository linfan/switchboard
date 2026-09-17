import { describe, expect, it } from "vitest";

import {
  clampSettings,
  DEFAULT_SETTINGS,
  SETTING_BOUNDS,
  withSettingDefaults,
} from "./settings";

describe("clampSettings", () => {
  it("pulls out-of-range values back to the nearest bound", () => {
    const { min, max } = SETTING_BOUNDS.heartbeatIntervalMs;
    expect(clampSettings({ heartbeatIntervalMs: 0 })).toEqual({
      heartbeatIntervalMs: min,
    });
    expect(clampSettings({ heartbeatIntervalMs: max * 10 })).toEqual({
      heartbeatIntervalMs: max,
    });
  });

  it("rounds fractional values to integers", () => {
    expect(clampSettings({ scanMaxDepth: 7.6 })).toEqual({ scanMaxDepth: 8 });
  });

  it("drops keys that are not finite numbers or not settings", () => {
    const patch = {
      scanMaxDirs: Number.NaN,
      scanMaxDepth: "12" as unknown as number,
      nonsense: 1,
    };
    expect(clampSettings(patch)).toEqual({});
  });

  it("returns only the keys present in the patch", () => {
    expect(clampSettings({ probeTimeoutMs: 2000 })).toEqual({
      probeTimeoutMs: 2000,
    });
  });

  it("ships a 50-file batch cap and never lets it reach zero", () => {
    expect(DEFAULT_SETTINGS.uploadMaxFiles).toBe(50);
    expect(DEFAULT_SETTINGS.downloadMaxFiles).toBe(50);
    // A zero cap would take the tree's download action and the upload picker
    // away entirely, so the form floors it at one file.
    expect(clampSettings({ uploadMaxFiles: 0 }).uploadMaxFiles).toBe(1);
    expect(clampSettings({ downloadMaxFiles: 9e9 }).downloadMaxFiles).toBe(
      SETTING_BOUNDS.downloadMaxFiles.max,
    );
  });
});

describe("withSettingDefaults", () => {
  it("fills in keys a store written by an older build never saved", () => {
    // Only one key persisted: everything else must fall back to its default
    // rather than rehydrating as undefined and reaching a consumer as NaN.
    const merged = withSettingDefaults({ scanMaxDepth: 4 });
    expect(merged.scanMaxDepth).toBe(4);
    expect(merged).toEqual({ ...DEFAULT_SETTINGS, scanMaxDepth: 4 });
  });

  it("clamps what it does find", () => {
    expect(withSettingDefaults({ scanMaxDepth: 0 }).scanMaxDepth).toBe(
      SETTING_BOUNDS.scanMaxDepth.min,
    );
  });

  it("tolerates a first run with nothing persisted", () => {
    expect(withSettingDefaults(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(withSettingDefaults(null)).toEqual(DEFAULT_SETTINGS);
    expect(withSettingDefaults("garbage")).toEqual(DEFAULT_SETTINGS);
  });
});
