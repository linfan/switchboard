import { pool } from "../net/pool";
import { useStore } from "../store/store";
import { convKey, type Conversation, type Service } from "../store/types";

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
          onClick={() => removeService(service.id)}
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
                <span className={`badge badge--${c.task.status.state}`}>
                  {c.task.status.state}
                </span>
              </li>
            );
          })
        )}
      </ul>
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
