import { useEffect } from "react";

import { ConversationPanel } from "./components/ConversationPanel";
import { Sidebar } from "./components/Sidebar";
import { pool } from "./net/pool";
import { useStore } from "./store/store";

export default function App() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const setCollapsed = useStore((s) => s.setSidebarCollapsed);

  // Own the connection pool for the app's lifetime.
  useEffect(() => {
    pool.start();
    return () => pool.stop();
  }, []);

  return (
    <div className={`app ${collapsed ? "app--collapsed" : ""}`}>
      {collapsed ? (
        <div className="sidebar-rail">
          <button
            className="icon-btn icon-btn--sm"
            title="Expand panel"
            onClick={() => setCollapsed(false)}
          >
            »
          </button>
        </div>
      ) : (
        <Sidebar />
      )}
      <ConversationPanel />
    </div>
  );
}
