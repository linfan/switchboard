import { useState } from "react";

import {
  DEFAULT_FONT_SIZE,
  DEFAULT_SETTINGS,
  FONT_SIZE_BOUNDS,
  SETTING_BOUNDS,
  type Settings,
} from "../store/settings";
import { useStore } from "../store/store";
import { Modal } from "./Modal";

const MB = 1024 * 1024;

/**
 * Font sizes are separate top-level store keys rather than part of `Settings`
 * (the zoom shortcuts own them too), but they belong in this panel, so the form
 * addresses both by a single field key.
 */
const FONT_KEYS = ["terminalFontSize", "editorFontSize"] as const;
type FontKey = (typeof FONT_KEYS)[number];
type FieldKey = keyof Settings | FontKey;

interface Field {
  key: FieldKey;
  label: string;
  /** Multiplier from the value shown to the value stored (MB → bytes). */
  scale: number;
  unit: string;
}

const GROUPS: { legend: string; hint?: string; fields: Field[] }[] = [
  {
    legend: "Media previews",
    hint: "Files larger than these are reported instead of transferred. Reopen a tab to apply a raised limit.",
    fields: [
      { key: "previewMaxImageBytes", label: "Image", scale: MB, unit: "MB" },
      { key: "previewMaxAudioBytes", label: "Audio", scale: MB, unit: "MB" },
      { key: "previewMaxVideoBytes", label: "Video", scale: MB, unit: "MB" },
    ],
  },
  {
    legend: "Connection",
    hint: "Saving a change here reconnects every service.",
    fields: [
      {
        key: "reconnectBaseMs",
        label: "First reconnect delay",
        scale: 1,
        unit: "ms",
      },
      {
        key: "reconnectMaxMs",
        label: "Longest reconnect delay",
        scale: 1,
        unit: "ms",
      },
      {
        key: "heartbeatIntervalMs",
        label: "Heartbeat interval",
        scale: 1,
        unit: "ms",
      },
      {
        key: "heartbeatTimeoutMs",
        label: "Heartbeat timeout",
        scale: 1,
        unit: "ms",
      },
      {
        key: "handshakeTimeoutMs",
        label: "Handshake timeout",
        scale: 1,
        unit: "ms",
      },
      {
        key: "probeTimeoutMs",
        label: "Service probe timeout",
        scale: 1,
        unit: "ms",
      },
    ],
  },
  {
    legend: "File tree filter",
    hint: "Bounds on the scan that reveals matches. Hitting one returns partial results rather than hanging.",
    fields: [
      {
        key: "scanMaxConcurrency",
        label: "Concurrent listings",
        scale: 1,
        unit: "",
      },
      { key: "scanMaxDirs", label: "Directory budget", scale: 1, unit: "" },
      { key: "scanMaxDepth", label: "Maximum depth", scale: 1, unit: "" },
      { key: "scanTimeBudgetMs", label: "Time budget", scale: 1, unit: "ms" },
    ],
  },
  {
    legend: "Fonts",
    fields: [
      { key: "terminalFontSize", label: "Terminal", scale: 1, unit: "px" },
      { key: "editorFontSize", label: "File editor", scale: 1, unit: "px" },
    ],
  },
];

const FIELDS = GROUPS.flatMap((g) => g.fields);

/** Read-only reference, shown on the Hotkeys tab. */
const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "⇧ ⌘ =", action: "Zoom in (larger font)" },
  { keys: "⇧ ⌘ -", action: "Zoom out (smaller font)" },
  { keys: "⌘ S", action: "Save the active file" },
];

const TABS = ["General", "Hotkeys"] as const;
type Tab = (typeof TABS)[number];

function isFontKey(key: FieldKey): key is FontKey {
  return (FONT_KEYS as readonly string[]).includes(key);
}

/** A field's accepted range, in the unit it is displayed in. */
function boundsFor(field: Field): { min: number; max: number } {
  const { min, max } = isFontKey(field.key)
    ? FONT_SIZE_BOUNDS
    : SETTING_BOUNDS[field.key];
  return {
    min: Math.round(min / field.scale),
    max: Math.round(max / field.scale),
  };
}

function toDraft(values: Record<FieldKey, number>): Record<string, string> {
  return Object.fromEntries(
    FIELDS.map((f) => [f.key, String(Math.round(values[f.key] / f.scale))]),
  );
}

/**
 * Edit the app's configurable limits and timings. Opened from the macOS app menu
 * (`Settings…`) and from the sidebar's gear button, which is the only route on
 * Windows and Linux since those platforms get no menu bar.
 *
 * Edits are held locally and committed on Save, so a half-typed value never
 * reaches the store — where it would immediately affect live connections.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const terminalFontSize = useStore((s) => s.terminalFontSize);
  const editorFontSize = useStore((s) => s.editorFontSize);
  const setSettings = useStore((s) => s.setSettings);
  const setFontSize = useStore((s) => s.setFontSize);

  const [draft, setDraft] = useState(() =>
    toDraft({ ...settings, terminalFontSize, editorFontSize }),
  );
  const [tab, setTab] = useState<Tab>("General");

  // Parse every field once per render: `values` feeds Save, `invalid` drives the
  // per-input highlight, and both are needed for the cross-field checks below.
  const values: Partial<Record<FieldKey, number>> = {};
  const invalid = new Set<FieldKey>();
  for (const f of FIELDS) {
    const raw = draft[f.key].trim();
    const n = Number(raw);
    const { min, max } = boundsFor(f);
    if (raw === "" || !Number.isInteger(n) || n < min || n > max) {
      invalid.add(f.key);
    } else {
      values[f.key] = n * f.scale;
    }
  }

  // Constraints between fields, checked only where both sides parsed.
  const conflicts: string[] = [];
  if (
    values.reconnectBaseMs !== undefined &&
    values.reconnectMaxMs !== undefined &&
    values.reconnectMaxMs < values.reconnectBaseMs
  ) {
    conflicts.push(
      "The longest reconnect delay must be at least the first reconnect delay.",
    );
  }
  if (
    values.heartbeatIntervalMs !== undefined &&
    values.heartbeatTimeoutMs !== undefined &&
    values.heartbeatTimeoutMs >= values.heartbeatIntervalMs
  ) {
    // Each ping re-arms the pong deadline, so a timeout at or above the interval
    // would be cancelled by the next ping before it could ever fire — silently
    // disabling dead-link detection.
    conflicts.push(
      "The heartbeat timeout must be shorter than the heartbeat interval, or a dead link is never detected.",
    );
  }

  const valid = invalid.size === 0 && conflicts.length === 0;

  const submit = () => {
    if (!valid) return;
    const patch: Record<string, number> = {};
    for (const f of FIELDS) {
      const value = values[f.key] as number;
      if (isFontKey(f.key)) {
        setFontSize(
          f.key === "terminalFontSize" ? "terminal" : "editor",
          value,
        );
      } else {
        patch[f.key] = value;
      }
    }
    setSettings(patch as Partial<Settings>);
    onClose();
  };

  // Load the shipped values into the form but don't commit them — the user can
  // still review them, or cancel out.
  const restoreDefaults = () =>
    setDraft(
      toDraft({
        ...DEFAULT_SETTINGS,
        terminalFontSize: DEFAULT_FONT_SIZE,
        editorFontSize: DEFAULT_FONT_SIZE,
      }),
    );

  return (
    <Modal
      title="Settings"
      className="modal--settings"
      onClose={onClose}
      onSubmit={submit}
      dismissOnScrimClick={false}
      footer={
        <>
          <button type="button" className="btn" onClick={restoreDefaults}>
            Restore defaults
          </button>
          <span className="panel__spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!valid}
            onClick={submit}
          >
            Save
          </button>
        </>
      }
    >
      <div className="settings__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={t === tab}
            className={`settings__tab ${t === tab ? "settings__tab--active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "Hotkeys" ? (
        <table className="shortcuts">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.action}>
                <td className="shortcuts__keys">
                  <kbd>{s.keys}</kbd>
                </td>
                <td className="shortcuts__action">{s.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        GROUPS.map((group) => (
          <div className="settings__group" key={group.legend}>
            <div className="settings__legend">{group.legend}</div>
            {group.fields.map((f) => {
              const { min, max } = boundsFor(f);
              return (
                <div className="settings__row" key={f.key}>
                  <label htmlFor={`setting-${f.key}`}>{f.label}</label>
                  <input
                    id={`setting-${f.key}`}
                    value={draft[f.key]}
                    inputMode="numeric"
                    title={`${min}–${max}${f.unit ? ` ${f.unit}` : ""}`}
                    aria-invalid={invalid.has(f.key)}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [f.key]: e.target.value }))
                    }
                  />
                  <span className="settings__unit">{f.unit}</span>
                </div>
              );
            })}
            {group.hint && <p className="hint hint--muted">{group.hint}</p>}
          </div>
        ))
      )}
      {/* Kept outside the tab switch so a disabled Save is always explained,
          even while the Hotkeys tab hides the offending field. */}
      {invalid.size > 0 && (
        <p className="hint hint--error">
          Highlighted values are outside their accepted range (hover a field to
          see it).
        </p>
      )}
      {conflicts.map((message) => (
        <p className="hint hint--error" key={message}>
          {message}
        </p>
      ))}
    </Modal>
  );
}
