import { useEffect, useRef, useState } from "react";

/**
 * A label that turns into a text input on demand. Enter or blur commits the new
 * value via `onCommit`; Escape cancels and restores the original. Used for
 * editable workspace names and task titles in the sidebar.
 */
export function InlineEdit({
  value,
  onCommit,
  className,
  title,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  className?: string;
  /** Tooltip on the (non-editing) label. */
  title?: string;
  /** Accessible name for the edit input. */
  ariaLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const begin = () => {
    setDraft(value);
    setEditing(true);
  };

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
        begin();
      }}
    >
      {value}
    </span>
  );
}
