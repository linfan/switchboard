import { useState } from "react";

import { Modal } from "./Modal";

/** One row in the shortcuts table: a human label and its key chord. */
interface Shortcut {
  keys: string;
  action: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: "⇧ ⌘ =", action: "Zoom in (larger font)" },
  { keys: "⇧ ⌘ -", action: "Zoom out (smaller font)" },
  { keys: "⌘ S", action: "Save the active file" },
];

/**
 * A header button that opens a popup listing the app's keyboard shortcuts.
 * Rendered in both the terminal and editor panel headers so the reference is
 * reachable from either pane.
 */
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="icon-btn icon-btn--kbd"
        title="Keyboard shortcuts"
        aria-label="Keyboard shortcuts"
        onClick={() => setOpen(true)}
      >
        ⌨
      </button>
      {open && (
        <Modal title="Keyboard shortcuts" onClose={() => setOpen(false)}>
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
        </Modal>
      )}
    </>
  );
}
