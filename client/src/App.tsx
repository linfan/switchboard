import { useEffect } from "react";

import { ConversationPanel } from "./components/ConversationPanel";
import { ServicePanel } from "./components/ServicePanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { WorkspaceEditor } from "./components/WorkspaceEditor";
import * as editors from "./net/editors";
import { pool } from "./net/pool";
import { portForwards } from "./net/portForwards";
import { listen } from "./net/tauri";
import * as terminals from "./net/terminals";
import { useStore } from "./store/store";

export default function App() {
  const collapsed = useStore((s) => s.sidebarCollapsed);
  const setCollapsed = useStore((s) => s.setSidebarCollapsed);
  const sidebarWidth = useStore((s) => s.sidebarWidth);
  const setSidebarWidth = useStore((s) => s.setSidebarWidth);
  const terminalFontSize = useStore((s) => s.terminalFontSize);
  const editorFontSize = useStore((s) => s.editorFontSize);
  const zoomFont = useStore((s) => s.zoomFont);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  // A selected workspace routes the right pane to its file editor; a selected
  // service shows its status page; otherwise the selected task's terminal shows
  // (the original behavior).
  const workspace = useStore((s) =>
    s.selectedWorkspaceId
      ? s.workspaces.find((w) => w.id === s.selectedWorkspaceId)
      : undefined,
  );
  const selectedService = useStore((s) =>
    s.selectedServiceId
      ? s.services.find((service) => service.id === s.selectedServiceId)
      : undefined,
  );

  // Own the connection pool for the app's lifetime.
  useEffect(() => {
    pool.start();
    return () => pool.stop();
  }, []);

  useEffect(() => {
    portForwards.start();
    return () => portForwards.stop();
  }, []);

  // Push the persisted terminal font size into the (React-external) registry.
  // Runs on mount and whenever the size changes — including once the persisted
  // store rehydrates asynchronously (Tauri store), so terminals settle correctly.
  useEffect(() => {
    terminals.setFontSize(terminalFontSize);
  }, [terminalFontSize]);

  // Editor font size is applied via a CSS variable the CodeMirror rule reads;
  // remeasure so CM recomputes cached line heights for the new cell size.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${editorFontSize}px`,
    );
    editors.remeasureAll();
  }, [editorFontSize]);

  // The macOS `Settings…` menu item (and ⌘,) reaches the webview as an event;
  // inert in the browser build, where the sidebar gear is the only route.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("open-settings", () => setSettingsOpen(true)).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setSettingsOpen]);

  // Global zoom shortcuts: ⇧⌘= grows, ⇧⌘- shrinks. Whichever pane is on screen
  // (editor when a workspace is selected, else the terminal) is the target. A
  // capture-phase listener runs before xterm/CodeMirror so the chord never leaks
  // into terminal input or an editor binding.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.metaKey || !e.shiftKey || e.altKey || e.ctrlKey) return;
      let delta: number | null = null;
      if (e.code === "Equal") delta = 1;
      else if (e.code === "Minus") delta = -1;
      if (delta === null) return;
      e.preventDefault();
      e.stopPropagation();
      const target = useStore.getState().selectedWorkspaceId
        ? "editor"
        : "terminal";
      zoomFont(target, delta);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [zoomFont]);

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
        collapsed ? undefined : { gridTemplateColumns: `${sidebarWidth}px 1fr` }
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
      ) : selectedService ? (
        <ServicePanel key={selectedService.id} service={selectedService} />
      ) : (
        <ConversationPanel />
      )}
      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
