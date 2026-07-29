import { useEffect, useState } from "react";

import * as editors from "../net/editors";
import { pool } from "../net/pool";
import { gitInfo, gitRemoveWorktree } from "../net/rest";
import { useStore } from "../store/store";
import {
  convKey,
  type Conversation,
  type Service,
  type Workspace,
} from "../store/types";
import { AddServiceDialog } from "./AddServiceDialog";
import { AddWorkspaceDialog } from "./AddWorkspaceDialog";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { InlineEdit } from "./InlineEdit";
import { Menu } from "./Menu";
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
        <Menu
          triggerClassName="icon-btn icon-btn--sm row-menu"
          title="Service actions"
          items={[
            {
              label: "Add workspace",
              onClick: () => setAddingWorkspace(true),
            },
            { label: "Edit service", onClick: () => setEditing(true) },
            { label: "Reconnect now", onClick: () => pool.reconnect(service.id) },
            {
              label: "Remove service",
              confirm: "Click again to remove",
              danger: true,
              onClick: () => {
                for (const w of serviceWorkspaces) editors.dispose(w.id);
                removeService(service.id);
              },
            },
          ]}
        />
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
  const service = useStore((s) =>
    s.services.find((sv) => sv.id === workspace.serviceId),
  );
  const [addingTask, setAddingTask] = useState(false);
  const [creatingWorktree, setCreatingWorktree] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // Whether this workspace folder is a git repo (drives the "Create worktree"
  // menu item). Probed once the service is online; null while unknown.
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  // A worktree workspace (created via "Create worktree") gets a single "Remove
  // worktree" action instead of "Create worktree"/"Remove workspace". The cwd
  // fallback covers worktrees created before the flag existed.
  const isWorktree =
    workspace.worktree === true ||
    workspace.cwd.includes("/.switchboard/worktree/");

  useEffect(() => {
    // Worktrees never offer "Create worktree", so skip the repo probe for them.
    if (!service || !online || isWorktree) {
      setIsRepo(null);
      return;
    }
    let cancelled = false;
    gitInfo(service, workspace.cwd)
      .then((info) => {
        if (!cancelled) setIsRepo(info.available && info.is_repo);
      })
      .catch(() => {
        if (!cancelled) setIsRepo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service, online, isWorktree, workspace.cwd, workspace.id]);

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

  const removeWorktree = async () => {
    if (!service) return;
    // Remove the worktree from git first; only forget the workspace if that
    // succeeds, so a failure (e.g. offline mid-click) leaves it visible to retry.
    try {
      await gitRemoveWorktree(service, workspace.cwd);
    } catch (e) {
      console.error("Failed to remove worktree", e);
      return;
    }
    remove();
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
        <Menu
          triggerClassName="icon-btn icon-btn--sm row-menu"
          title="Workspace actions"
          items={[
            {
              label: "New task",
              disabled: !online,
              onClick: () => setAddingTask(true),
            },
            ...(isWorktree
              ? [
                  {
                    label: "Remove worktree",
                    confirm:
                      "Click again to remove (deletes the worktree and its tasks)",
                    danger: true,
                    disabled: !online,
                    onClick: removeWorktree,
                  },
                ]
              : [
                  ...(isRepo
                    ? [
                        {
                          label: "Create worktree",
                          disabled: !online,
                          onClick: () => setCreatingWorktree(true),
                        },
                      ]
                    : []),
                  {
                    label: "Remove workspace",
                    confirm: "Click again to remove (deletes its tasks)",
                    danger: true,
                    onClick: remove,
                  },
                ]),
          ]}
        />
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
      {creatingWorktree && service && (
        <CreateWorktreeDialog
          service={service}
          workspace={workspace}
          onClose={() => setCreatingWorktree(false)}
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
              <Menu
                triggerClassName="icon-btn icon-btn--sm row-menu"
                title="Task actions"
                items={[
                  {
                    label: "Delete task",
                    confirm: "Click again to delete",
                    danger: true,
                    onClick: () => pool.deleteTask(serviceId, c.task.id),
                  },
                ]}
              />
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
