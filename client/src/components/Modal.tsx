import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  title,
  onClose,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  /**
   * When provided, the body is wrapped in a `<form>` so pressing ENTER inside a
   * field confirms the dialog. Footer buttons must be `type="button"` so a click
   * doesn't also submit the form.
   */
  onSubmit?: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Make sure keyboard focus lands inside this (topmost) modal so ESC — handled
  // via the bubbling onKeyDown below — is scoped to it and doesn't also close a
  // modal underneath it. Autofocused inputs keep their focus; this only fires
  // when nothing inside is focused yet (e.g. a picker opened from a button).
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) el.focus();
  }, []);

  const body = (
    <>
      <div className="modal__body">{children}</div>
      {footer && <footer className="modal__footer">{footer}</footer>}
    </>
  );

  return (
    <div className="modal__scrim" onClick={onClose}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="modal__header">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {onSubmit ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {body}
            {/* Enables implicit ENTER submission; multi-field forms don't submit
                on ENTER unless a submit button exists. Hidden from view/tab. */}
            <button
              type="submit"
              aria-hidden="true"
              tabIndex={-1}
              style={{ position: "absolute", width: 1, height: 1, padding: 0, border: 0, opacity: 0 }}
            />
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  );
}
