import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import * as terminals from "../net/terminals";

/**
 * Mounts the persistent xterm.js terminal for one task into the panel. The
 * `Terminal` instance itself lives in the registry (see net/terminals.ts), so
 * switching conversations only re-parents its element — scrollback is preserved.
 *
 * While the viewport is scrolled away from the last line the registry stops
 * pinning new output, and a floating button appears so the user can jump back
 * and resume following without hunting for the bottom of the scrollback.
 */
export function TerminalView({
  serviceId,
  taskId,
}: {
  serviceId: string;
  taskId: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    terminals.attach(serviceId, taskId, host);

    const onResize = () => terminals.refit(serviceId, taskId);
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      ro.disconnect();
      terminals.detach(serviceId, taskId);
    };
  }, [serviceId, taskId]);

  const subscribe = useCallback(
    (onChange: () => void) => terminals.onFollow(serviceId, taskId, onChange),
    [serviceId, taskId],
  );
  const getSnapshot = useCallback(
    () => terminals.isFollowing(serviceId, taskId),
    [serviceId, taskId],
  );
  const following = useSyncExternalStore(subscribe, getSnapshot);

  return (
    <div className="term-wrap">
      <div className="term-pane" ref={hostRef} />
      {!following && (
        <button
          type="button"
          className="term-jump"
          title="Jump to latest output"
          aria-label="Jump to latest output"
          onClick={() => terminals.scrollToBottom(serviceId, taskId)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 2.5v7.5M4.75 6.75 8 10l3.25-3.25M3.5 13.25h9"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
