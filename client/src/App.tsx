import { useEffect, useState } from "react";

import { AddServiceDialog } from "./components/AddServiceDialog";
import { ConversationPanel } from "./components/ConversationPanel";
import { NewTaskDialog } from "./components/NewTaskDialog";
import { Sidebar } from "./components/Sidebar";
import { pool } from "./net/pool";

export default function App() {
  const [addOpen, setAddOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);

  // Own the connection pool for the app's lifetime.
  useEffect(() => {
    pool.start();
    return () => pool.stop();
  }, []);

  return (
    <div className="app">
      <Sidebar
        onAddService={() => setAddOpen(true)}
        onNewTask={() => setTaskOpen(true)}
      />
      <ConversationPanel />
      {addOpen && <AddServiceDialog onClose={() => setAddOpen(false)} />}
      {taskOpen && <NewTaskDialog onClose={() => setTaskOpen(false)} />}
    </div>
  );
}
