import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  title,
  onClose,
  onSubmit,
  dismissOnScrimClick = true,
  className,
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
  /**
   * When false, clicking the backdrop outside the dialog does nothing — the
   * dialog only closes via ESC, the × button, or an explicit footer button.
   * Used for data-entry dialogs where a stray outside click shouldn't discard
   * a half-filled form.
   */
  dismissOnScrimClick?: boolean;
  /** Extra class on the dialog box, for dialogs needing a different size. */
  className?: string;
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
    <div
      className="modal__scrim"
      onClick={dismissOnScrimClick ? onClose : undefined}
      // When outside-clicks are ignored, don't let a backdrop click steal focus
      // out of the dialog — otherwise the (dialog-scoped) ESC handler below would
      // stop working until the user clicks back inside. Only guard clicks that
      // land on the scrim itself; clicks inside the dialog bubble up here too,
      // and preventing their default would stop inputs from receiving focus.
      onMouseDown={
        dismissOnScrimClick
          ? undefined
          : (e) => {
              if (e.target === e.currentTarget) e.preventDefault();
            }
      }
    >
      <div
        ref={ref}
        className={className ? `modal ${className}` : "modal"}
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
              style={{
                position: "absolute",
                width: 1,
                height: 1,
                padding: 0,
                border: 0,
                opacity: 0,
              }}
            />
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  );
}
