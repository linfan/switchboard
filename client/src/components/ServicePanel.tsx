import { useEffect, useState } from "react";

import { isTauri } from "../net/tauri";
import { useStore } from "../store/store";
import type {
  ConnStatus,
  PortForward,
  PortForwardRuntime,
  Service,
} from "../store/types";
import { ConfirmButton } from "./ConfirmButton";
import { PortForwardDialog } from "./PortForwardDialog";

function ForwardIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.25 6.25h7.5M11 3.5l2.75 2.75L11 9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.75 13.75h-7.5M9 11l-2.75 2.75L9 16.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function statusText(
  runtime: PortForwardRuntime | undefined,
  enabled: boolean,
): string {
  if (!runtime) return enabled ? "Starting" : "Stopped";
  switch (runtime.status) {
    case "active":
      return "Listening";
    case "starting":
      return "Starting";
    case "reconnecting":
      return "Reconnecting";
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
          <span className="forward-row__arrow" aria-hidden="true">
            →
          </span>
          <code>127.0.0.1:{forward.remotePort}</code>
        </div>
        <span className="forward-row__scope">
          local listener → remote loopback
        </span>
      </div>

      <div className="forward-row__runtime">
        <span
          className={`forward-status forward-status--${status}`}
          title={runtime?.error}
        >
          <span className="forward-status__dot" />
          {statusText(runtime, forward.enabled)}
        </span>
        {connections > 0 && (
          <span className="forward-row__connections">
            {connections} {connections === 1 ? "connection" : "connections"}
          </span>
        )}
        {runtime?.error && (
          <span className="forward-row__error" title={runtime.error}>
            {runtime.error}
          </span>
        )}
      </div>

      <div className="forward-row__actions">
        <label
          className="toggle"
          title={forward.enabled ? "Stop forward" : "Start forward"}
        >
          <input
            type="checkbox"
            checked={forward.enabled}
            aria-label={`${forward.enabled ? "Stop" : "Start"} 127.0.0.1:${forward.localPort} forward`}
            onChange={(event) =>
              updatePortForward(forward.id, { enabled: event.target.checked })
            }
          />
          <span className="toggle__track" aria-hidden="true">
            <span />
          </span>
        </label>
        <button type="button" className="btn" onClick={onEdit}>
          Edit
        </button>
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

const CONNECTION_LABEL: Record<ConnStatus, string> = {
  online: "Online",
  connecting: "Connecting…",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

/** Re-render once a second while `active`, so countdowns stay live. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function ServicePanel({ service }: { service: Service }) {
  const rt = useStore((s) => s.runtime[service.id]);
  const portForwards = useStore((s) => s.portForwards);
  const runtimes = useStore((s) => s.portForwardRuntime);
  const [editing, setEditing] = useState<PortForward | null | undefined>(
    undefined,
  );
  const status = rt?.status ?? "offline";
  const now = useNow(status === "reconnecting");

  const forwards = portForwards.filter(
    (forward) => forward.serviceId === service.id,
  );
  const listening = forwards.filter(
    (forward) => runtimes[forward.id]?.status === "active",
  ).length;
  const connections = forwards.reduce(
    (total, forward) => total + (runtimes[forward.id]?.activeConnections ?? 0),
    0,
  );
  const tools = rt?.info?.tools.filter((tool) => tool.available) ?? [];
  const retryIn = rt?.nextRetryAt
    ? Math.max(0, Math.round((rt.nextRetryAt - now) / 1000))
    : undefined;

  return (
    <main className="panel service-panel">
      <header className="panel__header service-panel__header">
        <span className={`dot dot--${status}`} title={status} />
        <div>
          <span className="panel__title">{service.name}</span>
          <span className="service-panel__url">{service.url}</span>
        </div>
        <span className="panel__spacer" />
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setEditing(null)}
        >
          Add forward
        </button>
      </header>

      <section className="service-panel__body">
        <div className="service-panel__card">
          <dl>
            <div className="service-panel__row">
              <dt>Connection</dt>
              <dd
                className={`service-panel__conn service-panel__conn--${status}`}
              >
                <span className={`dot dot--${status}`} />
                {CONNECTION_LABEL[status]}
              </dd>
            </div>
            <div className="service-panel__row">
              <dt>Endpoint</dt>
              <dd>{service.url}</dd>
            </div>
            {rt?.info && (
              <div className="service-panel__row">
                <dt>Host</dt>
                <dd>
                  {rt.info.name} · v{rt.info.version}
                </dd>
              </div>
            )}
            {rt?.info && (
              <div className="service-panel__row">
                <dt>Agent tools</dt>
                <dd>
                  {tools.length > 0
                    ? tools.map((tool) => tool.display_name).join(", ")
                    : "none available"}
                </dd>
              </div>
            )}
            {status === "reconnecting" && (
              <div className="service-panel__row">
                <dt>Retry</dt>
                <dd>
                  {rt?.attempt ? `attempt ${rt.attempt} · ` : ""}
                  {retryIn !== undefined ? `in ${retryIn}s` : "pending…"}
                </dd>
              </div>
            )}
            {rt?.lastError && (
              <div className="service-panel__row service-panel__row--error">
                <dt>Last error</dt>
                <dd>{rt.lastError}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="service-panel__summary">
          <div>
            <span className="service-panel__eyebrow">PORT FORWARDING</span>
            <p>
              Expose a port on this computer to a loopback-only port on{" "}
              {service.name}.
            </p>
          </div>
          <dl className="service-panel__metrics">
            <div>
              <dt>Rules</dt>
              <dd>{forwards.length}</dd>
            </div>
            <div>
              <dt>Listening</dt>
              <dd>{listening}</dd>
            </div>
            <div>
              <dt>Live links</dt>
              <dd>{connections}</dd>
            </div>
          </dl>
        </div>

        {!isTauri && (
          <p className="service-panel__notice">
            Forwarding is available in the desktop app. Rules can still be
            configured here.
          </p>
        )}

        {forwards.length === 0 ? (
          <div className="service-panel__empty">
            <ForwardIcon />
            <div>
              <strong>No port forwards</strong>
              <p>
                Map a local loopback port to a service port without exposing
                either endpoint externally.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setEditing(null)}
            >
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
