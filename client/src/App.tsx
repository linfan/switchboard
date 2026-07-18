import { useEffect } from "react";

import { ConversationPanel } from "./components/ConversationPanel";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceEditor } from "./components/WorkspaceEditor";
import { pool } from "./net/pool";
import { useStore } from "./store/store";

export default function App() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const setCollapsed = useStore((s) => s.setSidebarCollapsed);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
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

  // Drag the sidebar's right border to resize it (mirrors WorkspaceEditor's
  // divider). Width is clamped and persisted by the store.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) =>
      setSidebarWidth(startWidth + ev.clientX - startX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  return (
    <div
      className={`app ${collapsed ? "app--collapsed" : ""}`}
      style={
        collapsed
          ? undefined
          : { gridTemplateColumns: `${sidebarWidth}px 1fr` }
      }
    >
      {collapsed ? (
        <button
          className="icon-btn icon-btn--sm sidebar-toggle"
          title="Expand panel"
          onClick={() => setCollapsed(false)}
        >
          »
        </button>
      ) : (
        <>
          <Sidebar />
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            style={{ left: sidebarWidth }}
            onMouseDown={startResize}
          />
        </>
      )}
      {workspace ? (
        <WorkspaceEditor key={workspace.id} workspace={workspace} />
      ) : (
        <ConversationPanel />
      )}
    </div>
  );
}
