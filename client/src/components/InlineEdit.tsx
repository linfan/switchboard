import { useEffect, useRef, useState } from "react";

/**
 * A label that turns into a text input on demand. Enter or blur commits the new
 * value via `onCommit`; Escape cancels and restores the original. Used for
 * editable workspace names and task titles in the sidebar.
 *
 * Editing state is internal by default (double-click to begin). Pass `editing` +
 * `onEditingChange` to control it externally — e.g. a file-tree "Rename" menu
 * action that starts editing without a double-click.
 */
export function InlineEdit({
  value,
  onCommit,
  className,
  title,
  ariaLabel,
  placeholder,
  editing: editingProp,
  onEditingChange,
}: {
  value: string;
  onCommit: (next: string) => void;
  className?: string;
  /** Tooltip on the (non-editing) label. */
  title?: string;
  /** Accessible name for the edit input. */
  ariaLabel?: string;
  /** Placeholder shown in the edit input while it is empty. */
  placeholder?: string;
  /** Controlled editing state; when set, the component defers to the parent. */
  editing?: boolean;
  /** Notified when editing should begin (true) or end (false). */
  onEditingChange?: (editing: boolean) => void;
}) {
  const controlled = editingProp !== undefined;
  const [editingState, setEditingState] = useState(false);
  const editing = controlled ? editingProp : editingState;
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  const setEditing = (next: boolean) => {
    if (next) setDraft(value);
    if (controlled) onEditingChange?.(next);
    else setEditingState(next);
  };

  useEffect(() => {
    if (editing) {
      // Reset the draft each time editing (re)starts so a controlled begin picks
      // up the current value.
      setDraft(value);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const commit = () => {
    if (!editing) return;
    setEditing(false);
    const next = draft.trim();
    if (next !== "" && next !== value) onCommit(next);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`inline-edit ${className ?? ""}`}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
        // Clicks inside the input shouldn't bubble to a row's select handler.
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <span
      className={className}
      title={title}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
    >
      {value}
    </span>
  );
}
