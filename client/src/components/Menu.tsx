import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/** One entry in a {@link Menu} or {@link ContextMenu}. */
export interface MenuItem {
  label: ReactNode;
  onClick: () => void;
  /** Render in the danger colour (destructive action). */
  danger?: boolean;
  disabled?: boolean;
  /**
   * If set, the item needs a second click to fire: the label swaps to this
   * confirm text and auto-resets after 3s — the two-click guard from
   * `ConfirmButton`, adapted for a menu row.
   */
  confirm?: ReactNode;
}

/** Where a popup anchors: to a trigger's edge, or at raw cursor coordinates. */
type Anchor =
  | { kind: "trigger"; rect: DOMRect }
  | { kind: "point"; x: number; y: number };

const MENU_MIN_WIDTH = 168;
const VIEWPORT_MARGIN = 8;

/**
 * A dropdown menu: a `⋯` trigger that opens a floating list of actions. The
 * popup is portaled to `document.body` with fixed positioning so it is never
 * clipped by scrolling/overflow ancestors (e.g. the sidebar).
 */
export function Menu({
  items,
  title = "Actions",
  triggerClassName = "icon-btn icon-btn--sm",
  label = "⋯",
}: {
  items: MenuItem[];
  title?: string;
  triggerClassName?: string;
  label?: ReactNode;
}) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    const el = btnRef.current;
    if (el) setRect(el.getBoundingClientRect());
  };

  return (
    <>
      <button
        ref={btnRef}
        className={`${triggerClassName}${rect ? " is-open" : ""}`}
        title={title}
        aria-haspopup="menu"
        aria-expanded={!!rect}
        onClick={open}
      >
        {label}
      </button>
      {rect && (
        <MenuPopup
          items={items}
          anchor={{ kind: "trigger", rect }}
          onClose={() => setRect(null)}
        />
      )}
    </>
  );
}

/**
 * A context menu opened at cursor coordinates. The parent owns the open state
 * (typically set from an `onContextMenu` handler) and clears it via `onClose`.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  return (
    <MenuPopup items={items} anchor={{ kind: "point", x, y }} onClose={onClose} />
  );
}

function MenuPopup({
  items,
  anchor,
  onClose,
}: {
  items: MenuItem[];
  anchor: Anchor;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Position after mount so we can measure the popup and clamp it on-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left: number;
    let top: number;
    if (anchor.kind === "trigger") {
      // Align the popup's right edge to the trigger's right edge, dropping down.
      left = anchor.rect.right - width;
      top = anchor.rect.bottom + 4;
    } else {
      left = anchor.x;
      top = anchor.y;
    }
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft));
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop));
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="menu__backdrop"
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        className="menu"
        role="menu"
        style={{
          left: pos?.left ?? -9999,
          top: pos?.top ?? -9999,
          minWidth: MENU_MIN_WIDTH,
          visibility: pos ? "visible" : "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item, i) => (
          <MenuItemRow key={i} item={item} onClose={onClose} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function MenuItemRow({
  item,
  onClose,
}: {
  item: MenuItem;
  onClose: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const run = () => {
    if (item.confirm !== undefined && !armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(timer.current);
    onClose();
    item.onClick();
  };

  return (
    <button
      className={`menu__item${item.danger ? " menu__item--danger" : ""}`}
      role="menuitem"
      disabled={item.disabled}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
    >
      {armed ? item.confirm : item.label}
    </button>
  );
}
