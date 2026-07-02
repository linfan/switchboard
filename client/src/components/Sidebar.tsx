import { useStore } from "../store/store";
import { convKey, type Conversation, type Service } from "../store/types";

export function Sidebar() {
  const services = useStore((s) => s.services);
  const conversations = useStore((s) => s.conversations);

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <span className="sidebar__title">Agent Manage</span>
      </header>
      <div className="sidebar__body">
        {services.length === 0 ? (
          <p className="empty">No hosting services yet.</p>
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
  const status = useStore((s) => s.runtime[service.id]?.status ?? "offline");
  const selectedKey = useStore((s) => s.selectedKey);
  const select = useStore((s) => s.select);

  return (
    <section className="service">
      <div className="service__head">
        <span className={`dot dot--${status}`} />
        <span className="service__name">{service.name}</span>
      </div>
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
