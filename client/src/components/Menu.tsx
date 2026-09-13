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
  /** Leaf action. Omitted on a row whose only job is opening a `submenu`. */
  onClick?: () => void;
  /**
   * Second-level items: hovering (or clicking, for touch) the row slides this
   * menu out beside it, and only its items fire an action.
   */
  submenu?: MenuItem[];
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
  { kind: "trigger"; rect: DOMRect } | { kind: "point"; x: number; y: number };

const MENU_MIN_WIDTH = 168;
const VIEWPORT_MARGIN = 8;
/** Horizontal gap between a row and the submenu that slides out of it. */
const SUBMENU_GAP = 4;
/**
 * Grace period before an abandoned submenu closes, so crossing the gap between
 * the row and its panel doesn't dismiss it.
 */
const SUBMENU_CLOSE_DELAY = 220;

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
    <MenuPopup
      items={items}
      anchor={{ kind: "point", x, y }}
      onClose={onClose}
    />
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
  // Row whose submenu is showing, plus that row's rect to anchor the panel to.
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);
  const subTimer = useRef<ReturnType<typeof setTimeout>>();

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

  useEffect(() => () => clearTimeout(subTimer.current), []);

  const holdSub = () => clearTimeout(subTimer.current);
  const releaseSub = () => {
    clearTimeout(subTimer.current);
    subTimer.current = setTimeout(() => setSub(null), SUBMENU_CLOSE_DELAY);
  };

  const subItems = sub === null ? undefined : items[sub.index]?.submenu;

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
        onMouseLeave={releaseSub}
      >
        {items.map((item, i) => (
          <MenuItemRow
            key={i}
            item={item}
            onClose={onClose}
            subOpen={sub?.index === i}
            onSubEnter={(rect) => {
              holdSub();
              setSub({ index: i, rect });
            }}
            onSubLeave={releaseSub}
          />
        ))}
      </div>
      {/* Inside the backdrop, not a second portal: it must paint above the
          parent menu to stay clickable. */}
      {sub && subItems && (
        <SubmenuPanel
          items={subItems}
          rowRect={sub.rect}
          onClose={onClose}
          onEnter={holdSub}
          onLeave={releaseSub}
        />
      )}
    </div>,
    document.body,
  );
}

/**
 * The second level of a {@link MenuPopup}: a panel sliding out beside the row
 * that opened it, flipping to the left when the right side has no room.
 */
function SubmenuPanel({
  items,
  rowRect,
  onClose,
  onEnter,
  onLeave,
}: {
  items: MenuItem[];
  rowRect: DOMRect;
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = rowRect.right + SUBMENU_GAP;
    if (left + width > window.innerWidth - VIEWPORT_MARGIN) {
      left = rowRect.left - width - SUBMENU_GAP;
    }
    // Nudge up by the parent's padding so the first row lines up with its opener.
    let top = rowRect.top - 5;
    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(top, window.innerHeight - height - VIEWPORT_MARGIN),
    );
    setPos({ left, top });
  }, [rowRect]);

  return (
    <div
      ref={ref}
      className="menu menu--sub"
      role="menu"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        minWidth: MENU_MIN_WIDTH,
        visibility: pos ? "visible" : "hidden",
      }}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {items.map((item, i) => (
        <MenuItemRow key={i} item={item} onClose={onClose} />
      ))}
    </div>
  );
}

function MenuItemRow({
  item,
  onClose,
  subOpen,
  onSubEnter,
  onSubLeave,
}: {
  item: MenuItem;
  onClose: () => void;
  /** This row's submenu is currently showing. */
  subOpen?: boolean;
  onSubEnter?: (rowRect: DOMRect) => void;
  onSubLeave?: () => void;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const btnRef = useRef<HTMLButtonElement>(null);
  const hasSub = !!item.submenu?.length;

  useEffect(() => () => clearTimeout(timer.current), []);

  const openSub = () => {
    const el = btnRef.current;
    if (el) onSubEnter?.(el.getBoundingClientRect());
  };

  const run = () => {
    // A submenu row never fires an action itself — it only reveals its items.
    if (hasSub) {
      openSub();
      return;
    }
    if (item.confirm !== undefined && !armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(timer.current);
    onClose();
    item.onClick?.();
  };

  return (
    <button
      ref={btnRef}
      className={`menu__item${item.danger ? " menu__item--danger" : ""}${
        hasSub ? " menu__item--sub" : ""
      }${subOpen ? " is-sub-open" : ""}`}
      role="menuitem"
      aria-haspopup={hasSub ? "menu" : undefined}
      aria-expanded={hasSub ? subOpen : undefined}
      disabled={item.disabled}
      onClick={(e) => {
        e.stopPropagation();
        run();
      }}
      onMouseEnter={() => {
        if (hasSub) openSub();
        else onSubLeave?.();
      }}
      onMouseLeave={() => {
        if (hasSub) onSubLeave?.();
      }}
      onFocus={() => {
        if (hasSub) openSub();
      }}
    >
      {armed ? item.confirm : item.label}
    </button>
  );
}
