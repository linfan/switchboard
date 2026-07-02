import { useEffect, useRef, useState } from "react";

import { pool } from "../net/pool";
import { useStore } from "../store/store";

export function ConversationPanel() {
  const selectedKey = useStore((s) => s.selectedKey);
  const conv = useStore((s) =>
    s.selectedKey ? s.conversations[s.selectedKey] : undefined,
  );
  const [draft, setDraft] = useState("");
  const streamRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv?.messages.length]);

  if (!selectedKey || !conv) {
    return (
      <main className="panel panel--empty">
        <p className="empty">Select a conversation to view its stream.</p>
      </main>
    );
  }

  const running = conv.task.status.state === "running";
  const { serviceId } = conv;
  const taskId = conv.task.id;

  const send = () => {
    const text = draft.trim();
    if (!text || !running) return;
    if (pool.sendUserInput(serviceId, taskId, text)) setDraft("");
  };

  return (
    <main className="panel">
      <header className="panel__header">
        <span className="panel__title">{conv.task.title}</span>
        <span className={`badge badge--${conv.task.status.state}`}>
          {conv.task.status.state}
        </span>
        <span className="panel__spacer" />
        {running && (
          <button
            className="btn btn--danger"
            onClick={() => pool.terminateTask(serviceId, taskId)}
          >
            Terminate
          </button>
        )}
      </header>

      <div className="stream" ref={streamRef}>
        {conv.messages.length === 0 ? (
          <p className="empty">No messages yet.</p>
        ) : (
          conv.messages.map((m) => (
            <div key={m.seq} className={`msg msg--${m.event.kind}`}>
              <span className="msg__seq">#{m.seq}</span>
              <div className="msg__body">
                <span className="msg__kind">{m.event.kind}</span>
                <span className="msg__text">
                  {m.event.text ?? JSON.stringify(m.event.raw)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="composer">
        <textarea
          rows={2}
          value={draft}
          placeholder={running ? "Message the agent…" : "Task is not running"}
          disabled={!running}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="btn btn--primary"
          disabled={!running || draft.trim() === ""}
          onClick={send}
        >
          Send
        </button>
      </div>
    </main>
  );
}
