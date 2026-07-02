import type { ReactNode } from "react";

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="modal__scrim" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal__header">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>
  );
}
