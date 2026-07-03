import { useState } from "react";

import { pool } from "../net/pool";
import { useStore } from "../store/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { TerminalView } from "./TerminalView";

export function ConversationPanel() {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const selectedKey = useStore((s) => s.selectedKey);
  const conv = useStore((s) =>
    s.selectedKey ? s.conversations[s.selectedKey] : undefined,
  );

  if (!selectedKey || !conv) {
    return (
      <main className="panel panel--empty">
        <p className="empty">Select a conversation to view its terminal.</p>
      </main>
    );
  }

  const running = conv.task.status.state === "running";
  const { serviceId } = conv;
  const taskId = conv.task.id;

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
            className="btn"
            onClick={() => pool.terminateTask(serviceId, taskId)}
          >
            Terminate
          </button>
        )}
        <button className="btn btn--danger" onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      </header>

      {/* Keyed so each task gets its own mount; scrollback lives in the registry. */}
      <TerminalView key={selectedKey} serviceId={serviceId} taskId={taskId} />

      {confirmDelete && (
        <ConfirmDialog
          title="Delete task"
          message={`Delete "${conv.task.title}"? This terminates the process and permanently removes its terminal history on the host.`}
          confirmLabel="Delete"
          onConfirm={() => pool.deleteTask(serviceId, taskId)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </main>
  );
}
