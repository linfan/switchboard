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
    host::HostLink,
    pty_proc::PtyOutput,
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

/// Is a process with this pid currently alive? Uses signal 0, which performs
/// the existence/permission checks without delivering a signal: `Ok` or an
/// `EPERM` error both mean the process exists; only `ESRCH` means it's gone.
#[cfg(unix)]
fn process_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: `kill` with signal 0 has no side effects beyond the liveness check.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Windows equivalent: a pid we can open whose exit code is still `STILL_ACTIVE`
/// is running. A pid we cannot open is gone (or belongs to someone else).
#[cfg(windows)]
fn process_alive(pid: i64) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// What `GetExitCodeProcess` reports for a process that hasn't exited.
    const STILL_ACTIVE: u32 = 259;

    if pid <= 0 {
        return false;
    }
    // SAFETY: OpenProcess only reads the pid; the handle is closed below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32) };
    if handle.is_null() {
        return false;
    }
    // SAFETY: `handle` is live and `code` is a valid out-param.
    let mut code: u32 = 0;
    let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
    unsafe { CloseHandle(handle) };
    ok != 0 && code == STILL_ACTIVE
}

/// Platforms with neither signals nor the Win32 process API don't run PTY
/// workers; treat any recorded pid as gone so orphans reconcile to a terminal
/// `Exited` state.
#[cfg(not(any(unix, windows)))]
fn process_alive(_pid: i64) -> bool {
    false
}

/// Hard-kill a process by pid (SIGKILL), matching the SIGKILL that the normal
/// PTY-handle terminate path sends. Used to reap a `Detached` orphan on delete,
/// which has no live handle to terminate. Best-effort: an already-dead pid
/// yields `ESRCH` and is a no-op.
#[cfg(unix)]
fn kill_pid(pid: i64) {
    if pid > 0 {
        // SAFETY: sending a signal to a pid has no effect on our address space.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// Windows equivalent of the SIGKILL above: `TerminateProcess`, which is also
/// what `portable-pty`'s killer uses. Best-effort — an already-dead pid can't be
/// opened and is a no-op.
#[cfg(windows)]
fn kill_pid(pid: i64) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};

    if pid <= 0 {
        return;
    }
    // SAFETY: OpenProcess only reads the pid; the handle is closed below.
    let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid as u32) };
    if handle.is_null() {
        return;
    }
    // SAFETY: `handle` is a live process handle opened for termination.
    unsafe {
        TerminateProcess(handle, 1);
        CloseHandle(handle);
    }
}

#[cfg(not(any(unix, windows)))]
fn kill_pid(_pid: i64) {}

#[derive(Clone)]
pub struct TaskManager {
    store: Store,
    /// Where the database lives; host endpoints and logs are derived from it.
    db_path: String,
    /// Fan-out of every server->client item to all live WS connections.
    events: broadcast::Sender<Outbound>,
    /// Links to the pty-hosts we are currently attached to, keyed by task id.
    running: Arc<Mutex<HashMap<String, HostLink>>>,
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
    pub fn new(store: Store, db_path: &str) -> Self {
        let (events, _) = broadcast::channel(2048);
        Self {
            store,
            db_path: db_path.to_string(),
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

    /// On startup, any task still marked Starting/Running whose host we failed to
    /// re-attach to is unreachable: nothing can stream it again. The agent itself
    /// may be orphaned-but-alive or truly gone, so check the recorded pid: alive
    /// → `Detached` (honest — the process lives but we can't stream it),
    /// dead/unknown → `Exited { code: None }`. Both are terminal, so clients stop
    /// waiting instead of seeing a stuck Running row.
    pub async fn reconcile_orphans(&self) -> AppResult<()> {
        let rows = self.store.list_task_pids().await?;
        // Tasks we just re-attached to are live in `running`; they must not be
        // reconciled to a terminal state. Snapshot the live-id set with a short
        // lock, never held across an await.
        let adopted: HashSet<String> = {
            let running = self.running.lock().unwrap();
            rows.iter()
                .filter(|(id, _, _)| running.contains_key(id))
                .map(|(id, _, _)| id.clone())
                .collect()
        };
        for (id, status, pid) in rows {
            if adopted.contains(&id) {
                continue;
            }
            if matches!(status, TaskStatus::Starting | TaskStatus::Running) {
                let alive = pid.map(process_alive).unwrap_or(false);
                let next = if alive {
                    TaskStatus::Detached
                } else {
                    TaskStatus::Exited { code: None }
                };
                tracing::info!(
                    task = %id,
                    was = ?status,
                    ?pid,
                    alive,
                    now = ?next,
                    "reconciling orphaned task whose pty-host is unreachable"
                );
                self.store.update_status(&id, &next).await?;
            }
        }
        Ok(())
    }

    /// Re-attach to the pty-hosts our predecessor left running.
    ///
    /// This is what makes a server replaceable: the PTY and the agent live in the
    /// host, so a new server just dials each recorded endpoint and resumes the
    /// byte stream at the offset it durably stored. Tasks whose host is gone are
    /// left alone for [`reconcile_orphans`] to settle, so this must run first.
    pub async fn reattach_hosts(&self) {
        let hosted = match self.store.list_hosted().await {
            Ok(rows) => rows,
            Err(e) => {
                tracing::error!(error = %e, "cannot list hosted tasks; not re-attaching");
                return;
            }
        };
        for row in hosted {
            // Only tasks that were live when we went away can have a host worth
            // dialing; a terminal status means the host has already exited.
            if !matches!(row.status, TaskStatus::Starting | TaskStatus::Running) {
                continue;
            }
            let (link, out_rx) = match HostLink::attach(
                &row.task_id,
                &row.endpoint,
                row.host_offset,
                row.host_pid.map(|p| p as u32),
            )
            .await
            {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!(
                        task = %row.task_id,
                        endpoint = %row.endpoint,
                        error = %e,
                        "no pty-host answered; leaving the task to orphan reconciliation"
                    );
                    continue;
                }
            };

            // Rebuild the authoritative screen from the durable chunk log so
            // reconnect snapshots match what the terminal showed before.
            let (cols, rows) = link.size();
            let mut emu = TerminalEmulator::new(cols, rows);
            if let Ok(chunks) = self.store.chunks_after(&row.task_id, 0).await {
                for (_, bytes) in chunks {
                    emu.process(&bytes);
                }
            }

            let offset = link.attach_offset();
            let agent_pid = link.pid();
            let host_pid = link.host_pid().map(|p| p as i64);
            self.running
                .lock()
                .unwrap()
                .insert(row.task_id.clone(), link);
            self.terminals
                .lock()
                .unwrap()
                .insert(row.task_id.clone(), emu);
            // Record where this attach actually resumed: the host may have been
            // able to replay less than we asked for, and the offset the *next*
            // server resumes from has to match what we are about to store. The
            // host pid comes from the HELLO when the host reports it (Windows
            // hosts are spawned through a shim, so that is the only source).
            let _ = self
                .store
                .set_host(&row.task_id, &row.endpoint, host_pid, offset)
                .await;
            if let Some(pid) = agent_pid {
                let _ = self.store.set_pid(&row.task_id, pid as i64).await;
            }
            let _ = self
                .store
                .update_status(&row.task_id, &TaskStatus::Running)
                .await;
            tracing::info!(task = %row.task_id, resume_at = offset, ?agent_pid, "re-attached to pty-host");
            self.spawn_pump(row.task_id, out_rx, offset);
        }
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

        // The PTY lives in its own process, so this task survives us being
        // replaced — see `crate::host`.
        let (link, out_rx) = HostLink::spawn(
            &self.db_path,
            &id,
            &cmd.bin,
            &cmd.argv,
            params.cwd.as_deref(),
            cols,
            rows,
        )
        .await?;
        let pid = link.pid();
        let host_pid = link.host_pid();
        self.store
            .set_host(&id, link.endpoint(), host_pid.map(|p| p as i64), 0)
            .await?;
        self.running.lock().unwrap().insert(id.clone(), link);
        self.terminals
            .lock()
            .unwrap()
            .insert(id.clone(), TerminalEmulator::new(cols, rows));

        info.status = TaskStatus::Running;
        self.store.update_status(&id, &TaskStatus::Running).await?;
        if let Some(pid) = pid {
            self.store.set_pid(&id, pid as i64).await?;
        }
        let _ = self.events.send(Outbound::Control(ServerMsg::TaskCreated {
            task: info.clone(),
        }));
        tracing::info!(task = %id, tool = %cmd.tool_id, ?pid, ?host_pid, "task created");

        self.spawn_pump(id.clone(), out_rx, 0);
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
        let live = handle.is_some();
        if let Some(handle) = handle {
            self.terminating.lock().unwrap().insert(id.to_string());
            handle.terminate();
        }
        self.store
            .update_status(id, &TaskStatus::Terminated)
            .await?;
        tracing::info!(task = %id, live, "task terminated by request");
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
        let had_handle = if let Some(handle) = self.running.lock().unwrap().remove(id) {
            self.deleting.lock().unwrap().insert(id.to_string());
            handle.terminate();
            true
        } else {
            false
        };
        self.terminating.lock().unwrap().remove(id);
        self.terminals.lock().unwrap().remove(id);
        // A `Detached` task has no live link but its agent is still alive in the
        // OS (that's what `Detached` means), and so may be the host that owns it.
        // Signal both before we drop the row, or the delete would leak two
        // processes with no way to ever reach them again — agent first, so it dies
        // on its own terms rather than by losing its terminal. Gate on the
        // `Detached` status: an `Exited` task's stale pids may have been recycled
        // to unrelated processes.
        if !had_handle {
            if let Some(TaskStatus::Detached) = self.store.get_task(id).await?.map(|t| t.status) {
                if let Some(pid) = self.store.get_pid(id).await? {
                    tracing::info!(task = %id, %pid, "killing detached agent on delete");
                    kill_pid(pid);
                }
                if let Some(host) = self
                    .store
                    .list_hosted()
                    .await?
                    .into_iter()
                    .find(|h| h.task_id == id)
                {
                    if let Some(pid) = host.host_pid {
                        tracing::info!(task = %id, %pid, "killing unreachable pty-host on delete");
                        kill_pid(pid);
                    }
                }
            }
        }
        // A no-op when the row is already gone — the delete stays idempotent.
        self.store.delete_task(id).await?;
        let _ = self.events.send(Outbound::Control(ServerMsg::TaskDeleted {
            task_id: id.to_string(),
        }));
        tracing::info!(task = %id, had_handle, "task deleted");
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

    /// Drain a host's output into the durable log, the authoritative screen, and
    /// the broadcast bus — then tell the host how far we got.
    ///
    /// `offset` is the stream position this link resumed at; the running total is
    /// what the host retains output against, so failing to ack eventually stalls
    /// the agent rather than losing bytes.
    fn spawn_pump(&self, task_id: String, mut out_rx: mpsc::Receiver<PtyOutput>, offset: u64) {
        let store = self.store.clone();
        let events = self.events.clone();
        let running = self.running.clone();
        let terminals = self.terminals.clone();
        let terminating = self.terminating.clone();
        let deleting = self.deleting.clone();
        tokio::spawn(async move {
            let mut durable = offset;
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
                                // Durable now, so the host may drop its copy.
                                durable += bytes.len() as u64;
                                if let Some(link) = running.lock().unwrap().get(&task_id) {
                                    link.ack(durable);
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
                        tracing::info!(%task_id, ?code, terminated = was_terminated, "task process exited");
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

#[cfg(test)]
mod tests {
    use super::*;

    fn running_task(id: &str) -> TaskInfo {
        TaskInfo {
            id: id.into(),
            tool: "claude".into(),
            title: "t".into(),
            status: TaskStatus::Running,
            created_at: now_millis(),
            last_seq: 0,
        }
    }

    #[tokio::test]
    async fn reconcile_detaches_live_orphans_and_exits_dead_ones() {
        let store = Store::memory().await.unwrap();
        let mgr = TaskManager::new(store.clone(), ":memory:");

        // Live orphan: our own pid is guaranteed alive.
        store.create_task(&running_task("live")).await.unwrap();
        store
            .set_pid("live", std::process::id() as i64)
            .await
            .unwrap();

        // Dead orphan: spawn a process, wait for it to exit, reuse its (now
        // freed) pid — reliably not alive.
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead_pid = child.id() as i64;
        child.wait().unwrap();
        store.create_task(&running_task("dead")).await.unwrap();
        store.set_pid("dead", dead_pid).await.unwrap();

        // No pid ever recorded (e.g. spawn crashed before Running).
        store.create_task(&running_task("nopid")).await.unwrap();

        mgr.reconcile_orphans().await.unwrap();

        assert_eq!(
            store.get_task("live").await.unwrap().unwrap().status,
            TaskStatus::Detached
        );
        assert_eq!(
            store.get_task("dead").await.unwrap().unwrap().status,
            TaskStatus::Exited { code: None }
        );
        assert_eq!(
            store.get_task("nopid").await.unwrap().unwrap().status,
            TaskStatus::Exited { code: None }
        );
    }

    #[tokio::test]
    async fn delete_kills_detached_orphan() {
        let store = Store::memory().await.unwrap();
        let mgr = TaskManager::new(store.clone(), ":memory:");

        // A real, long-lived child standing in for the orphaned agent process.
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = child.id() as i64;

        let mut task = running_task("orphan");
        task.status = TaskStatus::Detached;
        store.create_task(&task).await.unwrap();
        store.set_pid("orphan", pid).await.unwrap();
        assert!(process_alive(pid));

        mgr.delete("orphan").await.unwrap();

        // The row is gone and the orphaned process was signalled. Reap it so the
        // test doesn't leave a zombie, and confirm it was actually killed.
        let status = child.wait().unwrap();
        assert!(store.get_task("orphan").await.unwrap().is_none());
        assert!(
            !status.success(),
            "expected the child to be killed by signal"
        );
    }
}
