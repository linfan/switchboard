import { pool } from "../net/pool";
import { useStore } from "../store/store";
import { ConfirmButton } from "./ConfirmButton";
import { TerminalView } from "./TerminalView";

export function ConversationPanel() {
  const selectedKey = useStore((s) => s.selectedKey);
  const conv = useStore((s) =>
    s.selectedKey ? s.conversations[s.selectedKey] : undefined,
  );
  const titleOverride = useStore((s) =>
    s.selectedKey ? s.titles[s.selectedKey] : undefined,
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
        <span className="panel__title">{titleOverride ?? conv.task.title}</span>
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
        <ConfirmButton
          className="btn btn--danger"
          armedTitle="Click again to delete this task and its history"
          onConfirm={() => pool.deleteTask(serviceId, taskId)}
          armedChildren="Delete — sure?"
        >
          Delete
        </ConfirmButton>
      </header>

      {/* Keyed so each task gets its own mount; scrollback lives in the registry. */}
      <TerminalView key={selectedKey} serviceId={serviceId} taskId={taskId} />
    </main>
  );
}
