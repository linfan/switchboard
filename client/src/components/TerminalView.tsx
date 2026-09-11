import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import * as terminals from "../net/terminals";

/**
 * Mounts the persistent xterm.js terminal for one task into the panel. The
 * `Terminal` instance itself lives in the registry (see net/terminals.ts), so
 * switching conversations only re-parents its element — scrollback is preserved.
 *
 * A lock-scroll toggle sits at the top-right corner. When the lock is ON
 * (default) auto-follow is "sticky": the user can scroll up to read history,
 * but pressing any key or scrolling back to the bottom resumes following.
 * When the lock is OFF the current stateless behavior applies (no sticky
 * follow).
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

  const subscribeFollow = useCallback(
    (onChange: () => void) => terminals.onFollow(serviceId, taskId, onChange),
    [serviceId, taskId],
  );
  const getFollowing = useCallback(
    () => terminals.isFollowing(serviceId, taskId),
    [serviceId, taskId],
  );
  const following = useSyncExternalStore(subscribeFollow, getFollowing);

  const subscribeLock = useCallback(
    (onChange: () => void) => terminals.onLock(serviceId, taskId, onChange),
    [serviceId, taskId],
  );
  const getLocked = useCallback(
    () => terminals.isLocked(serviceId, taskId),
    [serviceId, taskId],
  );
  const locked = useSyncExternalStore(subscribeLock, getLocked);

  const handleClick = () => {
    if (!following) {
      // Not at bottom — jump to latest output.
      terminals.scrollToBottom(serviceId, taskId);
    } else {
      // At bottom — toggle lock.
      terminals.toggleLock(serviceId, taskId);
    }
  };

  // Icon and title depend on the state.
  let title: string;
  let icon: JSX.Element;

  if (!following) {
    title = "Jump to latest output";
    icon = (
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
    );
  } else if (locked) {
    // Lock ON — closed padlock
    title = "Locked — click to unlock scrolling";
    icon = (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M5 7.5V5a3 3 0 0 1 6 0v2.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect
          x="2.5"
          y="7.5"
          width="11"
          height="6.5"
          rx="1.2"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path
          d="M8 10v2"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    );
  } else {
    // Lock OFF — open padlock (same body, broken shackle, no keyhole)
    title = "Unlocked — click to lock scrolling";
    icon = (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M5 7.5V5a3 3 0 0 1 4.5-2.5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect
          x="2.5"
          y="7.5"
          width="11"
          height="6.5"
          rx="1.2"
          stroke="currentColor"
          strokeWidth="1.3"
        />
      </svg>
    );
  }

  return (
    <div className="term-wrap">
      <div className="term-pane" ref={hostRef} />
      <button
        type="button"
        className={
          "term-jump" +
          (!following ? " term-jump--alert" : "") +
          (locked ? " term-jump--locked" : " term-jump--unlocked")
        }
        title={title}
        aria-label={title}
        onClick={handleClick}
      >
        {icon}
      </button>
    </div>
  );
}