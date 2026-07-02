//! Task lifecycle management: spawns agent processes, pumps their output into
//! the durable store, and broadcasts sequenced events to connected clients.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use agent_manage_shared::{now_millis, AgentEvent, ServerMsg, TaskInfo, TaskStatus};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::{
    agent,
    agent_proc::{self, AgentHandle, AgentOutput},
    error::{AppError, AppResult},
    store::Store,
};

/// Parameters for creating a task.
pub struct CreateParams {
    pub tool: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub initial_prompt: Option<String>,
}

#[derive(Clone)]
pub struct TaskManager {
    store: Store,
    /// Fan-out of every server->client event to all live WS connections.
    events: broadcast::Sender<ServerMsg>,
    /// Live agent process handles, keyed by task id.
    running: Arc<Mutex<HashMap<String, AgentHandle>>>,
    /// Tasks that were explicitly terminated (so a subsequent process Exit is
    /// reported as `Terminated` rather than `Exited`).
    terminating: Arc<Mutex<HashSet<String>>>,
    permission_mode: String,
}

impl TaskManager {
    pub fn new(store: Store, permission_mode: String) -> Self {
        let (events, _) = broadcast::channel(2048);
        Self {
            store,
            events,
            running: Arc::new(Mutex::new(HashMap::new())),
            terminating: Arc::new(Mutex::new(HashSet::new())),
            permission_mode,
        }
    }

    /// Subscribe a WS connection to the live event stream.
    pub fn subscribe(&self) -> broadcast::Receiver<ServerMsg> {
        self.events.subscribe()
    }

    pub async fn list(&self) -> AppResult<Vec<TaskInfo>> {
        self.store.list_tasks().await
    }

    /// On startup, any task still marked Starting/Running belongs to a process
    /// that died with the previous server; mark them Failed so clients don't
    /// wait forever.
    pub async fn reconcile_orphans(&self) -> AppResult<()> {
        for task in self.store.list_tasks().await? {
            if matches!(task.status, TaskStatus::Starting | TaskStatus::Running) {
                self.store
                    .update_status(
                        &task.id,
                        &TaskStatus::Failed {
                            error: "host restarted; process lost".into(),
                        },
                    )
                    .await?;
            }
        }
        Ok(())
    }

    /// Validate the tool, persist the task, spawn its process, and begin pumping
    /// output into the store + broadcast.
    pub async fn create(&self, params: CreateParams) -> AppResult<TaskInfo> {
        let spec = agent::spec(&params.tool)
            .ok_or_else(|| AppError::BadRequest(format!("unknown tool: {}", params.tool)))?;
        if agent::which(spec.bin).is_none() {
            return Err(AppError::BadRequest(format!(
                "tool '{}' is not installed on this host",
                spec.id
            )));
        }

        let id = Uuid::new_v4().to_string();
        let title = params
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| format!("{} · {}", spec.display_name, &id[..8]));
        let mut info = TaskInfo {
            id: id.clone(),
            tool: spec.id.to_string(),
            title,
            status: TaskStatus::Starting,
            created_at: now_millis(),
            last_seq: 0,
        };
        self.store.create_task(&info).await?;

        let (handle, out_rx) = agent_proc::spawn(spec, params.cwd.as_deref(), &self.permission_mode)?;
        self.running.lock().unwrap().insert(id.clone(), handle);

        info.status = TaskStatus::Running;
        self.store.update_status(&id, &TaskStatus::Running).await?;
        let _ = self.events.send(ServerMsg::TaskCreated { task: info.clone() });

        self.spawn_pump(id.clone(), out_rx);

        if let Some(prompt) = params.initial_prompt.filter(|p| !p.trim().is_empty()) {
            self.send_input(&id, &prompt).await?;
        }
        Ok(info)
    }

    /// Persist + broadcast a user turn, then forward it to the live process.
    pub async fn send_input(&self, task_id: &str, text: &str) -> AppResult<()> {
        let event = AgentEvent {
            kind: "user_input".into(),
            text: Some(text.to_string()),
            raw: serde_json::json!({ "type": "user_input", "text": text }),
        };
        let seq = self.store.append_message(task_id, &event).await?;
        let _ = self.events.send(ServerMsg::Message {
            task_id: task_id.to_string(),
            seq,
            event,
        });

        let result = self
            .running
            .lock()
            .unwrap()
            .get(task_id)
            .map(|h| h.send_user(text));
        match result {
            Some(Ok(())) => Ok(()),
            Some(Err(e)) => Err(e),
            None => Err(AppError::BadRequest(format!(
                "task {task_id} is not running"
            ))),
        }
    }

    /// Terminate a task. Kills the process if running (its later Exit is
    /// reported as `Terminated` thanks to the `terminating` marker) and records
    /// the terminal state immediately so clients see it without delay.
    pub async fn terminate(&self, id: &str) -> AppResult<()> {
        if self.store.get_task(id).await?.is_none() {
            return Err(AppError::NotFound(format!("task {id}")));
        }
        let handle = self.running.lock().unwrap().remove(id);
        if let Some(handle) = handle {
            self.terminating.lock().unwrap().insert(id.to_string());
            handle.terminate();
        }
        self.store.update_status(id, &TaskStatus::Terminated).await?;
        let _ = self.events.send(ServerMsg::TaskState {
            task_id: id.to_string(),
            status: TaskStatus::Terminated,
        });
        Ok(())
    }

    /// Test-only: persist + broadcast an event without a real agent process,
    /// so WS replay/durability can be exercised deterministically.
    #[cfg(test)]
    pub async fn inject_event(&self, task_id: &str, event: AgentEvent) -> AppResult<u64> {
        let seq = self.store.append_message(task_id, &event).await?;
        let _ = self.events.send(ServerMsg::Message {
            task_id: task_id.to_string(),
            seq,
            event,
        });
        Ok(seq)
    }

    fn spawn_pump(&self, task_id: String, mut out_rx: mpsc::UnboundedReceiver<AgentOutput>) {
        let store = self.store.clone();
        let events = self.events.clone();
        let running = self.running.clone();
        let terminating = self.terminating.clone();
        tokio::spawn(async move {
            while let Some(item) = out_rx.recv().await {
                match item {
                    AgentOutput::Event(event) => match store.append_message(&task_id, &event).await {
                        Ok(seq) => {
                            let _ = events.send(ServerMsg::Message {
                                task_id: task_id.clone(),
                                seq,
                                event,
                            });
                        }
                        Err(e) => tracing::error!(%task_id, error = %e, "failed to persist event"),
                    },
                    AgentOutput::Exited(code) => {
                        running.lock().unwrap().remove(&task_id);
                        let was_terminated =
                            terminating.lock().unwrap().remove(&task_id);
                        let status = if was_terminated {
                            TaskStatus::Terminated
                        } else {
                            TaskStatus::Exited { code }
                        };
                        let _ = store.update_status(&task_id, &status).await;
                        let _ = events.send(ServerMsg::TaskState {
                            task_id: task_id.clone(),
                            status,
                        });
                        break;
                    }
                }
            }
        });
    }
}
