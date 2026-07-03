import { useState } from "react";

import { pool } from "../net/pool";
import { useStore } from "../store/store";
import { convKey, type Conversation, type Service } from "../store/types";
import { ConfirmDialog } from "./ConfirmDialog";

/** What the sidebar is currently asking the user to confirm removing. */
type Pending =
  | { kind: "service" }
  | { kind: "task"; taskId: string; title: string };

export function Sidebar({
  onAddService,
  onNewTask,
}: {
  onAddService: () => void;
  onNewTask: () => void;
}) {
  const services = useStore((s) => s.services);
  const conversations = useStore((s) => s.conversations);

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <span className="sidebar__title">Agent Manage</span>
        <div className="sidebar__actions">
          <button className="icon-btn" title="Add service" onClick={onAddService}>
            +svc
          </button>
          <button
            className="icon-btn"
            title="New task"
            onClick={onNewTask}
            disabled={services.length === 0}
          >
            +task
          </button>
        </div>
      </header>
      <div className="sidebar__body">
        {services.length === 0 ? (
          <p className="empty">
            No hosting services yet. Click <b>+svc</b> to add one.
          </p>
        ) : (
          services.map((svc) => (
            <ServiceGroup
              key={svc.id}
              service={svc}
              conversations={Object.values(conversations).filter(
                (c) => c.serviceId === svc.id,
              )}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function ServiceGroup({
  service,
  conversations,
}: {
  service: Service;
  conversations: Conversation[];
}) {
  const rt = useStore((s) => s.runtime[service.id]);
  const selectedKey = useStore((s) => s.selectedKey);
  const select = useStore((s) => s.select);
  const removeService = useStore((s) => s.removeService);
  const status = rt?.status ?? "offline";
  const [pending, setPending] = useState<Pending | null>(null);

  return (
    <section className="service">
      <div className="service__head">
        <span className={`dot dot--${status}`} title={status} />
        <span className="service__name">{service.name}</span>
        <span className="service__spacer" />
        <button
          className="icon-btn icon-btn--sm"
          title="Reconnect now"
          onClick={() => pool.reconnect(service.id)}
        >
          ↻
        </button>
        <button
          className="icon-btn icon-btn--sm"
          title="Remove service"
          onClick={() => setPending({ kind: "service" })}
        >
          ×
        </button>
      </div>
      {status !== "online" && (
        <div className="service__status">
          {statusLine(status, rt?.lastError, rt?.nextRetryAt)}
        </div>
      )}
      <ul className="conv-list">
        {conversations.length === 0 ? (
          <li className="empty empty--sm">No conversations</li>
        ) : (
          conversations.map((c) => {
            const key = convKey(service.id, c.task.id);
            return (
              <li
                key={key}
                className={`conv ${selectedKey === key ? "conv--active" : ""}`}
                onClick={() => select(key)}
              >
                <span className="conv__title">{c.task.title}</span>
                <span className="conv__meta">
                  <span className={`badge badge--${c.task.status.state}`}>
                    {c.task.status.state}
                  </span>
                  <button
                    className="icon-btn icon-btn--sm conv__del"
                    title="Delete task"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPending({
                        kind: "task",
                        taskId: c.task.id,
                        title: c.task.title,
                      });
                    }}
                  >
                    ×
                  </button>
                </span>
              </li>
            );
          })
        )}
      </ul>
      {pending?.kind === "service" && (
        <ConfirmDialog
          title="Remove service"
          message={`Remove "${service.name}"? This forgets the host and its conversations on this client. Tasks keep running on the host.`}
          confirmLabel="Remove"
          onConfirm={() => removeService(service.id)}
          onClose={() => setPending(null)}
        />
      )}
      {pending?.kind === "task" && (
        <ConfirmDialog
          title="Delete task"
          message={`Delete "${pending.title}"? This terminates the process and permanently removes its terminal history on the host.`}
          confirmLabel="Delete"
          onConfirm={() => pool.deleteTask(service.id, pending.taskId)}
          onClose={() => setPending(null)}
        />
      )}
    </section>
  );
}

function statusLine(
  status: string,
  error?: string,
  nextRetryAt?: number,
): string {
  if (status === "reconnecting") {
    const secs = nextRetryAt
      ? Math.max(0, Math.round((nextRetryAt - Date.now()) / 1000))
      : undefined;
    return secs !== undefined ? `reconnecting in ${secs}s…` : "reconnecting…";
  }
  if (status === "connecting") return "connecting…";
  return error ? `offline — ${error}` : "offline";
}
