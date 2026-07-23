//! Task lifecycle management: spawns PTY-backed agent processes, pumps their
//! raw terminal output into the durable chunk log + authoritative screen, and
//! broadcasts it (as binary data) to connected clients.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use switchboard_shared::{now_millis, ServerMsg, TaskInfo, TaskStatus};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use crate::{
    agent,
    error::{AppError, AppResult},
    pty_proc::{self, PtyHandle, PtyOutput},
    store::Store,
    terminal::TerminalEmulator,
};

/// Parameters for creating a task.
pub struct CreateParams {
    pub tool: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

/// One item on the fan-out bus: either a JSON control message or a sequenced
/// slice of raw PTY bytes. The WS writer turns `Control` into a text frame and
/// `Pty` into a binary OUTPUT frame.
#[derive(Clone)]
pub enum Outbound {
    Control(ServerMsg),
    Pty {
        task_id: String,
        seq: u64,
        bytes: Arc<Vec<u8>>,
    },
}

#[derive(Clone)]
pub struct TaskManager {
    store: Store,
    /// Fan-out of every server->client item to all live WS connections.
    events: broadcast::Sender<Outbound>,
    /// Live PTY handles, keyed by task id.
    running: Arc<Mutex<HashMap<String, PtyHandle>>>,
    /// Authoritative screens, keyed by task id — the source of reconnect
    /// snapshots. A pure function of the ordered chunk log.
    terminals: Arc<Mutex<HashMap<String, TerminalEmulator>>>,
    /// Tasks explicitly terminated (so a later process Exit is reported as
    /// `Terminated` rather than `Exited`).
    terminating: Arc<Mutex<HashSet<String>>>,
    /// Tasks being deleted (so the pump's final Exit is swallowed rather than
    /// broadcasting a lifecycle state for an already-removed task).
    deleting: Arc<Mutex<HashSet<String>>>,
}

impl TaskManager {
    pub fn new(store: Store) -> Self {
        let (events, _) = broadcast::channel(2048);
        Self {
            store,
            events,
            running: Arc::new(Mutex::new(HashMap::new())),
            terminals: Arc::new(Mutex::new(HashMap::new())),
            terminating: Arc::new(Mutex::new(HashSet::new())),
            deleting: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Subscribe a WS connection to the live event stream.
    pub fn subscribe(&self) -> broadcast::Receiver<Outbound> {
        self.events.subscribe()
    }

    pub async fn list(&self) -> AppResult<Vec<TaskInfo>> {
        self.store.list_tasks().await
    }

    /// Byte fast-forward window: chunks with `seq > after`.
    pub async fn chunks_after(&self, task_id: &str, after: u64) -> AppResult<Vec<(u64, Vec<u8>)>> {
        self.store.chunks_after(task_id, after).await
    }

    /// Current authoritative screen for a task as ANSI escape sequences, if a
    /// live emulator exists. Used for reconnect snapshots.
    pub fn snapshot(&self, task_id: &str) -> Option<Vec<u8>> {
        self.terminals
            .lock()
            .unwrap()
            .get(task_id)
            .map(TerminalEmulator::snapshot)
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

    /// Validate the tool, persist the task, open its PTY, and begin pumping raw
    /// output into the store + broadcast.
    pub async fn create(&self, params: CreateParams) -> AppResult<TaskInfo> {
        let cmd = agent::resolve_command(&params.tool)?;
        let cols = params.cols.max(1);
        let rows = params.rows.max(1);

        let id = Uuid::new_v4().to_string();
        let title = params
            .title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| format!("{} · {}", cmd.display_name, &id[..8]));
        let mut info = TaskInfo {
            id: id.clone(),
            tool: cmd.tool_id.clone(),
            title,
            status: TaskStatus::Starting,
            created_at: now_millis(),
            last_seq: 0,
        };
        self.store.create_task(&info).await?;

        let (handle, out_rx) =
            pty_proc::spawn_cmd(&cmd.bin, &cmd.argv, params.cwd.as_deref(), cols, rows)?;
        self.running.lock().unwrap().insert(id.clone(), handle);
        self.terminals
            .lock()
            .unwrap()
            .insert(id.clone(), TerminalEmulator::new(cols, rows));

        info.status = TaskStatus::Running;
        self.store.update_status(&id, &TaskStatus::Running).await?;
        let _ = self.events.send(Outbound::Control(ServerMsg::TaskCreated {
            task: info.clone(),
        }));

        self.spawn_pump(id.clone(), out_rx);
        Ok(info)
    }

    /// Forward raw keystroke bytes to a running task's PTY.
    pub fn send_input(&self, task_id: &str, bytes: &[u8]) -> AppResult<()> {
        let result = self
            .running
            .lock()
            .unwrap()
            .get(task_id)
            .map(|h| h.send_input(bytes));
        match result {
            Some(r) => r,
            None => Err(AppError::BadRequest(format!(
                "task {task_id} is not running"
            ))),
        }
    }

    /// Resize a task's PTY and its authoritative screen together, so snapshots
    /// stay consistent with the client's viewport.
    pub fn resize(&self, task_id: &str, cols: u16, rows: u16) -> AppResult<()> {
        let cols = cols.max(1);
        let rows = rows.max(1);
        if let Some(t) = self.terminals.lock().unwrap().get_mut(task_id) {
            t.resize(cols, rows);
        }
        let result = self
            .running
            .lock()
            .unwrap()
            .get(task_id)
            .map(|h| h.resize(cols, rows));
        match result {
            Some(r) => r,
            None => Ok(()), // resizing a not-running task is a no-op
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
        self.store
            .update_status(id, &TaskStatus::Terminated)
            .await?;
        let _ = self.events.send(Outbound::Control(ServerMsg::TaskState {
            task_id: id.to_string(),
            status: TaskStatus::Terminated,
        }));
        Ok(())
    }

    /// Delete a task entirely: kill its process if running, drop its in-memory
    /// screen/handles, remove all persisted state, and tell every client to drop
    /// it. Fully idempotent: deleting an unknown task still broadcasts
    /// `TaskDeleted` and succeeds. A client whose copy is stale (e.g. it missed
    /// the lossy `TaskDeleted` broadcast for an earlier delete) must be able to
    /// clear it — erroring with `NotFound` would strand that row in the UI
    /// forever, since the client has no way to force-drop it locally.
    pub async fn delete(&self, id: &str) -> AppResult<()> {
        // Only mark deleting when a live process exists: the marker exists so the
        // pump swallows the process's final Exit (and buffered chunks) instead of
        // broadcasting a stray lifecycle state. With no pump there is nothing to
        // swallow, and an un-consumed marker would leak for every unknown-id
        // delete. Insert before terminate() so the marker is set before the
        // pump can observe the Exit.
        if let Some(handle) = self.running.lock().unwrap().remove(id) {
            self.deleting.lock().unwrap().insert(id.to_string());
            handle.terminate();
        }
        self.terminating.lock().unwrap().remove(id);
        self.terminals.lock().unwrap().remove(id);
        // A no-op when the row is already gone — the delete stays idempotent.
        self.store.delete_task(id).await?;
        let _ = self.events.send(Outbound::Control(ServerMsg::TaskDeleted {
            task_id: id.to_string(),
        }));
        Ok(())
    }

    /// Test-only: register an authoritative screen for a task without a real
    /// PTY, so the WS binary plane can be exercised deterministically.
    #[cfg(test)]
    pub fn register_terminal(&self, task_id: &str, cols: u16, rows: u16) {
        self.terminals
            .lock()
            .unwrap()
            .insert(task_id.to_string(), TerminalEmulator::new(cols, rows));
    }

    /// Test-only: persist + feed + broadcast a chunk without a real PTY.
    #[cfg(test)]
    pub async fn inject_chunk(&self, task_id: &str, bytes: &[u8]) -> AppResult<u64> {
        let seq = self.store.append_chunk(task_id, bytes).await?;
        if let Some(t) = self.terminals.lock().unwrap().get_mut(task_id) {
            t.process(bytes);
        }
        let _ = self.events.send(Outbound::Pty {
            task_id: task_id.to_string(),
            seq,
            bytes: Arc::new(bytes.to_vec()),
        });
        Ok(seq)
    }

    fn spawn_pump(&self, task_id: String, mut out_rx: mpsc::UnboundedReceiver<PtyOutput>) {
        let store = self.store.clone();
        let events = self.events.clone();
        let running = self.running.clone();
        let terminals = self.terminals.clone();
        let terminating = self.terminating.clone();
        let deleting = self.deleting.clone();
        tokio::spawn(async move {
            while let Some(item) = out_rx.recv().await {
                match item {
                    PtyOutput::Chunk(bytes) => {
                        // A delete removes the task row; any output still buffered
                        // from the process (e.g. its final burst after terminate)
                        // must not be persisted or it would fail against a missing
                        // row. Wait for the Exited event to tear the pump down.
                        if deleting.lock().unwrap().contains(&task_id) {
                            continue;
                        }
                        match store.append_chunk(&task_id, &bytes).await {
                            Ok(seq) => {
                                if let Some(t) = terminals.lock().unwrap().get_mut(&task_id) {
                                    t.process(&bytes);
                                }
                                let _ = events.send(Outbound::Pty {
                                    task_id: task_id.clone(),
                                    seq,
                                    bytes: Arc::new(bytes),
                                });
                            }
                            // A concurrent delete may have removed the row between
                            // the check above and this write — expected, not an error.
                            Err(e) if !deleting.lock().unwrap().contains(&task_id) => {
                                tracing::error!(%task_id, error = %e, "failed to persist chunk")
                            }
                            Err(_) => {}
                        }
                    }
                    PtyOutput::Exited(code) => {
                        running.lock().unwrap().remove(&task_id);
                        // A delete already removed the row + told clients; don't
                        // resurrect it with a lifecycle update.
                        if deleting.lock().unwrap().remove(&task_id) {
                            break;
                        }
                        let was_terminated = terminating.lock().unwrap().remove(&task_id);
                        let status = if was_terminated {
                            TaskStatus::Terminated
                        } else {
                            TaskStatus::Exited { code }
                        };
                        let _ = store.update_status(&task_id, &status).await;
                        let _ = events.send(Outbound::Control(ServerMsg::TaskState {
                            task_id: task_id.clone(),
                            status,
                        }));
                        break;
                    }
                }
            }
        });
    }
}
