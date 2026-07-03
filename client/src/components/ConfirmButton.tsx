import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A button that requires two clicks to fire: the first "arms" it (showing a
 * confirmation label), the second within 3s runs `onConfirm`. Stops click
 * propagation so it can live inside clickable rows.
 */
export function ConfirmButton({
  className = "",
  armedClassName = "",
  title,
  armedTitle = "Click again to confirm",
  onConfirm,
  children,
  armedChildren = "Sure?",
}: {
  className?: string;
  armedClassName?: string;
  title?: string;
  armedTitle?: string;
  onConfirm: () => void;
  children: ReactNode;
  armedChildren?: ReactNode;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      className={`${className}${armed ? ` ${armedClassName}` : ""}`}
      title={armed ? armedTitle : title}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) {
          clearTimeout(timer.current);
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), 3000);
        }
      }}
    >
      {armed ? armedChildren : children}
    </button>
  );
}
