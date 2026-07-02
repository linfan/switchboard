import { Sidebar } from "./components/Sidebar";
import { ConversationPanel } from "./components/ConversationPanel";

export default function App() {
  return (
    <div className="app">
      <Sidebar />
      <ConversationPanel />
    </div>
  );
}
