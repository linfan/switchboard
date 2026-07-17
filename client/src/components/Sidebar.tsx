import { useState } from "react";

import * as editors from "../net/editors";
import { pool } from "../net/pool";
import { useStore } from "../store/store";
import {
  convKey,
  type Conversation,
  type Service,
  type Workspace,
} from "../store/types";
import { AddServiceDialog } from "./AddServiceDialog";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog";
import { ConfirmButton } from "./ConfirmButton";
import { InlineEdit } from "./InlineEdit";
import { NewTaskDialog } from "./NewTaskDialog";

function Caret({ collapsed }: { collapsed: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{
        transform: collapsed ? "rotate(-90deg)" : "none",
        transition: "transform 0.12s ease",
      }}
    >
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1.75 4.25a1 1 0 0 1 1-1h3l1.25 1.5h6.25a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-7.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Sidebar() {
  const services = useStore((s) => s.services);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const [addServiceOpen, setAddServiceOpen] = useState(false);

  return (
    <aside className="sidebar">
      <header className="sidebar__header">
        <button
          className="icon-btn icon-btn--sm"
          title="Collapse panel"
          onClick={toggleSidebar}
        >
          «
        </button>
        <span className="sidebar__title">Switchboard</span>
        <div className="sidebar__actions">
          <button
            className="icon-btn"
            title="Add service"
            onClick={() => setAddServiceOpen(true)}
          >
            +svc
          </button>
        </div>
      </header>
      <div className="sidebar__body">
        {services.length === 0 ? (
          <p className="empty">
            No hosting services yet. Click <b>+svc</b> to add one.
          </p>
        ) : (
          services.map((svc) => <ServiceGroup key={svc.id} service={svc} />)
        )}
      </div>
      {addServiceOpen && (
        <AddServiceDialog onClose={() => setAddServiceOpen(false)} />
      )}
    </aside>
  );
}

function ServiceGroup({ service }: { service: Service }) {
  const rt = useStore((s) => s.runtime[service.id]);
  const workspaces = useStore((s) => s.workspaces);
  const conversations = useStore((s) => s.conversations);
  const taskWorkspace = useStore((s) => s.taskWorkspace);
  const removeService = useStore((s) => s.removeService);
  const status = rt?.status ?? "offline";
  const [editing, setEditing] = useState(false);
  const [addingWorkspace, setAddingWorkspace] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const serviceWorkspaces = workspaces.filter(
    (w) => w.serviceId === service.id,
  );
  const wsIds = new Set(serviceWorkspaces.map((w) => w.id));

  const convs = Object.values(conversations).filter(
    (c) => c.serviceId === service.id,
  );
  // Tasks whose mapping is missing or points to a removed workspace.
  const ungrouped = convs.filter((c) => {
    const ws = taskWorkspace[convKey(service.id, c.task.id)];
    return !ws || !wsIds.has(ws);
  });

  return (
    <section className="service">
      <div className="service__head">
        <button
          className="icon-btn icon-btn--sm caret-btn"
          title={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <Caret collapsed={collapsed} />
        </button>
        <span className={`dot dot--${status}`} title={status} />
        <span className="service__name">{service.name}</span>
        <span className="service__spacer" />
        <button
          className="icon-btn icon-btn--sm"
          title="Add workspace"
          onClick={() => setAddingWorkspace(true)}
        >
          +ws
        </button>
        <button
          className="icon-btn icon-btn--sm"
          title="Edit service"
          onClick={() => setEditing(true)}
        >
          ✎
        </button>
        <button
          className="icon-btn icon-btn--sm"
          title="Reconnect now"
          onClick={() => pool.reconnect(service.id)}
        >
          ↻
        </button>
        <ConfirmButton
          className="icon-btn icon-btn--sm"
          armedClassName="icon-btn--danger"
          title="Remove service"
          armedTitle="Click again to remove this service"
          onConfirm={() => {
            for (const w of serviceWorkspaces) editors.dispose(w.id);
            removeService(service.id);
          }}
        >
          ×
        </ConfirmButton>
      </div>
      {status !== "online" && (
        <div className="service__status">
          {statusLine(status, rt?.lastError, rt?.nextRetryAt)}
        </div>
      )}

      {!collapsed &&
        (serviceWorkspaces.length === 0 && ungrouped.length === 0 ? (
          <p className="empty empty--sm">
            No workspaces. Click <b>+ws</b> to add one.
          </p>
        ) : (
          <>
            {serviceWorkspaces.map((ws) => (
              <WorkspaceGroup
                key={ws.id}
                workspace={ws}
                online={status === "online"}
                conversations={convs.filter(
                  (c) =>
                    taskWorkspace[convKey(service.id, c.task.id)] === ws.id,
                )}
              />
            ))}
            {ungrouped.length > 0 && (
              <UngroupedGroup serviceId={service.id} conversations={ungrouped} />
            )}
          </>
        ))}

      {editing && (
        <AddServiceDialog service={service} onClose={() => setEditing(false)} />
      )}
      {addingWorkspace && (
        <AddWorkspaceDialog
          service={service}
          onClose={() => setAddingWorkspace(false)}
        />
      )}
    </section>
  );
}

function WorkspaceGroup({
  workspace,
  conversations,
  online,
}: {
  workspace: Workspace;
  conversations: Conversation[];
  online: boolean;
}) {
  const updateWorkspace = useStore((s) => s.updateWorkspace);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const selected = useStore((s) => s.selectedWorkspaceId === workspace.id);
  const [addingTask, setAddingTask] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const remove = () => {
    // "Delete its tasks" model: drop every task on the server first, then
    // forget the workspace (its mappings get cleaned as task_deleted arrives,
    // and removeWorkspace forgets any that didn't).
    for (const c of conversations) {
      pool.deleteTask(workspace.serviceId, c.task.id);
    }
    editors.dispose(workspace.id);
    removeWorkspace(workspace.id);
  };

  return (
    <section className="workspace">
      <div
        className={`workspace__head ${selected ? "workspace__head--active" : ""}`}
        onClick={() => selectWorkspace(workspace.id)}
      >
        <button
          className="icon-btn icon-btn--sm caret-btn"
          title={collapsed ? "Expand" : "Collapse"}
          aria-expanded={!collapsed}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((c) => !c);
          }}
        >
          <Caret collapsed={collapsed} />
        </button>
        <span className="workspace__icon">
          <FolderIcon />
        </span>
        <InlineEdit
          className="workspace__name"
          value={workspace.name}
          title={workspace.cwd}
          ariaLabel="Workspace name"
          onCommit={(name) => updateWorkspace(workspace.id, { name })}
        />
        <span className="service__spacer" />
        <button
          className="icon-btn icon-btn--sm"
          title="New task"
          disabled={!online}
          onClick={(e) => {
            e.stopPropagation();
            setAddingTask(true);
          }}
        >
          +task
        </button>
        <ConfirmButton
          className="icon-btn icon-btn--sm"
          armedClassName="icon-btn--danger"
          title="Remove workspace"
          armedTitle="Click again to remove this workspace and delete its tasks"
          onConfirm={remove}
        >
          ×
        </ConfirmButton>
      </div>
      {!collapsed && (
        <TaskList
          serviceId={workspace.serviceId}
          conversations={conversations}
        />
      )}
      {addingTask && (
        <NewTaskDialog
          serviceId={workspace.serviceId}
          workspaceId={workspace.id}
          cwd={workspace.cwd}
          onClose={() => setAddingTask(false)}
        />
      )}
    </section>
  );
}

function UngroupedGroup({
  serviceId,
  conversations,
}: {
  serviceId: string;
  conversations: Conversation[];
}) {
  return (
    <section className="workspace workspace--ungrouped">
      <div className="workspace__head">
        <span className="workspace__icon">🗂️</span>
        <span className="workspace__name">Ungrouped</span>
      </div>
      <TaskList serviceId={serviceId} conversations={conversations} />
    </section>
  );
}

function TaskList({
  serviceId,
  conversations,
}: {
  serviceId: string;
  conversations: Conversation[];
}) {
  const selectedKey = useStore((s) => s.selectedKey);
  const titles = useStore((s) => s.titles);
  const select = useStore((s) => s.select);
  const setTaskTitle = useStore((s) => s.setTaskTitle);

  if (conversations.length === 0) {
    return <ul className="conv-list">{null}</ul>;
  }

  return (
    <ul className="conv-list">
      {conversations.map((c) => {
        const key = convKey(serviceId, c.task.id);
        const displayTitle = titles[key] ?? c.task.title;
        return (
          <li
            key={key}
            className={`conv ${selectedKey === key ? "conv--active" : ""}`}
            onClick={() => select(key)}
          >
            <InlineEdit
              className="conv__title"
              value={displayTitle}
              ariaLabel="Task title"
              onCommit={(title) => setTaskTitle(serviceId, c.task.id, title)}
            />
            <span className="conv__meta">
              <span className={`badge badge--${c.task.status.state}`}>
                {c.task.status.state}
              </span>
              <ConfirmButton
                className="icon-btn icon-btn--sm conv__del"
                armedClassName="icon-btn--danger"
                title="Delete task"
                armedTitle="Click again to delete this task and its history"
                onConfirm={() => pool.deleteTask(serviceId, c.task.id)}
              >
                ×
              </ConfirmButton>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function statusLine(
  status: string,
  error?: string,
  nextRetryAt?: number,
): string {
  if (status === "reconnecting") {
    const secs = nextRetryAt
      ? Math.max(0, Math.round((nextRetryAt - Date.now()) / 1000))
      : undefined;
    return secs !== undefined ? `reconnecting in ${secs}s…` : "reconnecting…";
  }
  if (status === "connecting") return "connecting…";
  return error ? `offline — ${error}` : "offline";
}
