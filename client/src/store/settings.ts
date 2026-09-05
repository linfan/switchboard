//! User-configurable application settings.
//!
//! Every value here has a default that lives next to the code it governs, so
//! there is one source of truth per number and its rationale stays with its
//! call site. This module only assembles those defaults into a single flat
//! shape, which is what the store persists and what the settings form binds to.
//!
//! Flat and all-numeric on purpose: a nested shape would need a nested form and
//! a nested merge on rehydration, and none of these values are grouped tightly
//! enough to earn that.

import {
  DEFAULT_HANDSHAKE,
  DEFAULT_HEARTBEAT,
  DEFAULT_RECONNECT,
} from "../net/connection";
import { DEFAULT_MAX_PREVIEW_BYTES } from "../net/media";
import { DEFAULT_PROBE_TIMEOUT_MS } from "../net/rest";

export interface Settings {
  // --- media previews (bytes) ----------------------------------------------
  previewMaxImageBytes: number;
  previewMaxAudioBytes: number;
  previewMaxVideoBytes: number;

  // --- connection timing (ms) ----------------------------------------------
  /** First reconnect delay; grows exponentially up to `reconnectMaxMs`. */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  /** How often a ping is sent on an idle connection. */
  heartbeatIntervalMs: number;
  /** How long a pong may take before the link is presumed dead. */
  heartbeatTimeoutMs: number;
  handshakeTimeoutMs: number;
  /** How long verifying a service in the add/edit dialog may take. */
  probeTimeoutMs: number;

  // --- file-tree filter scan ------------------------------------------------
  scanMaxConcurrency: number;
  scanMaxDirs: number;
  scanMaxDepth: number;
  scanTimeBudgetMs: number;
}

export const DEFAULT_SETTINGS: Settings = {
  previewMaxImageBytes: DEFAULT_MAX_PREVIEW_BYTES.image,
  previewMaxAudioBytes: DEFAULT_MAX_PREVIEW_BYTES.audio,
  previewMaxVideoBytes: DEFAULT_MAX_PREVIEW_BYTES.video,

  reconnectBaseMs: DEFAULT_RECONNECT.baseDelayMs,
  reconnectMaxMs: DEFAULT_RECONNECT.maxDelayMs,
  heartbeatIntervalMs: DEFAULT_HEARTBEAT.intervalMs,
  heartbeatTimeoutMs: DEFAULT_HEARTBEAT.timeoutMs,
  handshakeTimeoutMs: DEFAULT_HANDSHAKE.timeoutMs,
  probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,

  // Bounds that keep the recursive filter scan from choking on a huge project.
  // Hitting any of them just stops descending (partial results are fine — the
  // user can narrow the filter); the scan never blocks or fans out unbounded.
  scanMaxConcurrency: 8, // simultaneous directory listings
  scanMaxDirs: 4000, // total directories read before giving up
  scanMaxDepth: 32, // nesting levels to descend
  scanTimeBudgetMs: 5000, // wall-clock ceiling for the whole scan
};

/**
 * Default and accepted range for the terminal/editor font size, in px. These
 * stay separate top-level store keys rather than joining {@link Settings} — they
 * predate it and are also driven by the zoom shortcuts — but the settings panel
 * presents them alongside everything else, so the numbers belong here.
 */
export const DEFAULT_FONT_SIZE = 13;
export const FONT_SIZE_BOUNDS = { min: 8, max: 28 };

/**
 * Default long-line wrap for file-editor tabs, likewise a separate top-level
 * store key: it seeds each tab when its view is built, and the tab's own Text
 * Wrap button then owns that tab. Off by default, matching the horizontal
 * scrolling the editor always had.
 */
export const DEFAULT_EDITOR_WRAP = false;

const MB = 1024 * 1024;

/**
 * Accepted range per setting. The form uses these to label and validate fields,
 * and {@link clampSettings} enforces them on write so a value that could wedge
 * the app (a zero-length heartbeat, an unbounded scan) can never be persisted —
 * including by hand-editing the store file.
 */
export const SETTING_BOUNDS: Record<
  keyof Settings,
  { min: number; max: number }
> = {
  previewMaxImageBytes: { min: MB, max: 2048 * MB },
  previewMaxAudioBytes: { min: MB, max: 2048 * MB },
  previewMaxVideoBytes: { min: MB, max: 2048 * MB },

  reconnectBaseMs: { min: 100, max: 60_000 },
  reconnectMaxMs: { min: 1000, max: 600_000 },
  heartbeatIntervalMs: { min: 1000, max: 300_000 },
  heartbeatTimeoutMs: { min: 1000, max: 120_000 },
  handshakeTimeoutMs: { min: 1000, max: 120_000 },
  probeTimeoutMs: { min: 1000, max: 120_000 },

  scanMaxConcurrency: { min: 1, max: 64 },
  scanMaxDirs: { min: 100, max: 100_000 },
  scanMaxDepth: { min: 1, max: 256 },
  scanTimeBudgetMs: { min: 500, max: 120_000 },
};

const KEYS = Object.keys(SETTING_BOUNDS) as (keyof Settings)[];

/**
 * Coerce a patch into safe integers within {@link SETTING_BOUNDS}, dropping keys
 * that aren't settings or aren't finite numbers. Returns only the keys present
 * in `patch`, so it composes with a partial update.
 */
export function clampSettings(patch: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const key of KEYS) {
    const value = patch[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const { min, max } = SETTING_BOUNDS[key];
    out[key] = Math.min(max, Math.max(min, Math.round(value)));
  }
  return out;
}

/**
 * Fill in any setting the persisted state is missing. A store written by an
 * older build has no key for a setting added since, and zustand's `persist`
 * merges only the top level — so without this the new key would rehydrate as
 * `undefined` and reach its consumer as `NaN`.
 */
export function withSettingDefaults(persisted: unknown): Settings {
  const merged = { ...DEFAULT_SETTINGS };
  if (persisted && typeof persisted === "object") {
    Object.assign(merged, clampSettings(persisted as Partial<Settings>));
  }
  return merged;
}
