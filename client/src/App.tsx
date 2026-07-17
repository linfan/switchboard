import { useEffect } from "react";

import { ConversationPanel } from "./components/ConversationPanel";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceEditor } from "./components/WorkspaceEditor";
import { pool } from "./net/pool";
import { useStore } from "./store/store";

export default function App() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const setCollapsed = useStore((s) => s.setSidebarCollapsed);
  // A selected workspace routes the right pane to its file editor; otherwise the
  // selected task's terminal shows (the original behavior).
  const workspace = useStore((s) =>
    s.selectedWorkspaceId
      ? s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
      : undefined,
  );

  // Own the connection pool for the app's lifetime.
  useEffect(() => {
    pool.start();
    return () => pool.stop();
  }, []);

  return (
    <div className={`app ${collapsed ? "app--collapsed" : ""}`}>
      {collapsed ? (
        <button
          className="icon-btn icon-btn--sm sidebar-toggle"
          title="Expand panel"
          onClick={() => setCollapsed(false)}
        >
          »
        </button>
      ) : (
        <Sidebar />
      )}
      {workspace ? (
        <WorkspaceEditor key={workspace.id} workspace={workspace} />
      ) : (
        <ConversationPanel />
      )}
    </div>
  );
}
