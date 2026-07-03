import { useEffect, useRef } from "react";

import * as terminals from "../net/terminals";

/**
 * Mounts the persistent xterm.js terminal for one task into the panel. The
 * `Terminal` instance itself lives in the registry (see net/terminals.ts), so
 * switching conversations only re-parents its element — scrollback is preserved.
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

  return <div className="terminal" ref={hostRef} />;
}
