import { useState } from "react";

import { isTauri } from "../net/tauri";
import { useStore } from "../store/store";
import type { PortForward, PortForwardRuntime, Service } from "../store/types";
import { ConfirmButton } from "./ConfirmButton";
import { PortForwardDialog } from "./PortForwardDialog";

function ForwardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3.25 6.25h7.5M11 3.5l2.75 2.75L11 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.75 13.75h-7.5M9 11l-2.75 2.75L9 16.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function statusText(runtime: PortForwardRuntime | undefined, enabled: boolean): string {
  if (!runtime) return enabled ? "Starting" : "Stopped";
  switch (runtime.status) {
    case "active":
      return "Listening";
    case "starting":
      return "Starting";
    case "stopped":
      return "Stopped";
    case "error":
      return "Error";
    case "unavailable":
      return "Desktop only";
  }
}

function ForwardRow({
  forward,
  runtime,
  onEdit,
}: {
  forward: PortForward;
  runtime?: PortForwardRuntime;
  onEdit: () => void;
}) {
  const updatePortForward = useStore((s) => s.updatePortForward);
  const removePortForward = useStore((s) => s.removePortForward);
  const status = runtime?.status ?? (forward.enabled ? "starting" : "stopped");
  const connections = runtime?.activeConnections ?? 0;

  return (
    <article className={`forward-row forward-row--${status}`}>
      <div className="forward-row__route">
        <div className="forward-row__ports">
          <code>127.0.0.1:{forward.localPort}</code>
          <span className="forward-row__arrow" aria-hidden="true">→</span>
          <code>127.0.0.1:{forward.remotePort}</code>
        </div>
        <span className="forward-row__scope">local listener → remote loopback</span>
      </div>

      <div className="forward-row__runtime">
        <span className={`forward-status forward-status--${status}`} title={runtime?.error}>
          <span className="forward-status__dot" />
          {statusText(runtime, forward.enabled)}
        </span>
        {connections > 0 && (
          <span className="forward-row__connections">
            {connections} {connections === 1 ? "connection" : "connections"}
          </span>
        )}
      </div>

      <div className="forward-row__actions">
        <label className="toggle" title={forward.enabled ? "Stop forward" : "Start forward"}>
          <input
            type="checkbox"
            checked={forward.enabled}
            aria-label={`${forward.enabled ? "Stop" : "Start"} 127.0.0.1:${forward.localPort} forward`}
            onChange={(event) =>
              updatePortForward(forward.id, { enabled: event.target.checked })
            }
          />
          <span className="toggle__track" aria-hidden="true"><span /></span>
        </label>
        <button type="button" className="btn" onClick={onEdit}>Edit</button>
        <ConfirmButton
          className="btn btn--danger"
          title="Remove forward"
          armedTitle="Click again to remove this forward"
          armedChildren="Remove — sure?"
          onConfirm={() => removePortForward(forward.id)}
        >
          Remove
        </ConfirmButton>
      </div>
    </article>
  );
}

export function PortForwardsPanel({ service }: { service: Service }) {
  const portForwards = useStore((s) => s.portForwards);
  const runtimes = useStore((s) => s.portForwardRuntime);
  const [editing, setEditing] = useState<PortForward | null | undefined>(undefined);
  const forwards = portForwards.filter((forward) => forward.serviceId === service.id);
  const listening = forwards.filter(
    (forward) => runtimes[forward.id]?.status === "active",
  ).length;
  const connections = forwards.reduce(
    (total, forward) => total + (runtimes[forward.id]?.activeConnections ?? 0),
    0,
  );

  return (
    <main className="panel forwards-panel">
      <header className="panel__header forwards-panel__header">
        <span className="forwards-panel__icon"><ForwardIcon /></span>
        <div>
          <span className="panel__title">Port forwards</span>
          <span className="forwards-panel__service">{service.name}</span>
        </div>
        <span className="panel__spacer" />
        <button type="button" className="btn btn--primary" onClick={() => setEditing(null)}>
          Add forward
        </button>
      </header>

      <section className="forwards-panel__body">
        <div className="forwards-panel__summary">
          <div>
            <span className="forwards-panel__eyebrow">LOOPBACK PATCH PANEL</span>
            <p>Expose a port on this computer to a loopback-only port on {service.name}.</p>
          </div>
          <dl className="forwards-panel__metrics">
            <div><dt>Rules</dt><dd>{forwards.length}</dd></div>
            <div><dt>Listening</dt><dd>{listening}</dd></div>
            <div><dt>Live links</dt><dd>{connections}</dd></div>
          </dl>
        </div>

        {!isTauri && (
          <p className="forwards-panel__notice">
            Forwarding is available in the desktop app. Rules can still be configured here.
          </p>
        )}

        {forwards.length === 0 ? (
          <div className="forwards-panel__empty">
            <ForwardIcon />
            <div>
              <strong>No port forwards</strong>
              <p>Map a local loopback port to a service port without exposing either endpoint externally.</p>
            </div>
            <button type="button" className="btn btn--primary" onClick={() => setEditing(null)}>
              Add first forward
            </button>
          </div>
        ) : (
          <div className="forward-list">
            {forwards.map((forward) => (
              <ForwardRow
                key={forward.id}
                forward={forward}
                runtime={runtimes[forward.id]}
                onEdit={() => setEditing(forward)}
              />
            ))}
          </div>
        )}
      </section>

      {editing !== undefined && (
        <PortForwardDialog
          service={service}
          forward={editing ?? undefined}
          onClose={() => setEditing(undefined)}
        />
      )}
    </main>
  );
}
