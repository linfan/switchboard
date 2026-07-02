import { useStore } from "../store/store";

export function ConversationPanel() {
  const selectedKey = useStore((s) => s.selectedKey);
  const conv = useStore((s) =>
    s.selectedKey ? s.conversations[s.selectedKey] : undefined,
  );

  if (!selectedKey || !conv) {
    return (
      <main className="panel panel--empty">
        <p className="empty">Select a conversation to view its stream.</p>
      </main>
    );
  }

  return (
    <main className="panel">
      <header className="panel__header">
        <span className="panel__title">{conv.task.title}</span>
        <span className={`badge badge--${conv.task.status.state}`}>
          {conv.task.status.state}
        </span>
      </header>
      <div className="stream">
        {conv.messages.map((m) => (
          <div key={m.seq} className={`msg msg--${m.event.kind}`}>
            <span className="msg__seq">#{m.seq}</span>
            <span className="msg__text">{m.event.text ?? m.event.kind}</span>
          </div>
        ))}
      </div>
    </main>
  );
}
