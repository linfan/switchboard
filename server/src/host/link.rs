//! Server side of the pty-host link.
//!
//! [`HostLink`] is a drop-in replacement for a local [`PtyHandle`]: it exposes
//! `pid`/`send_input`/`resize`/`terminate` and yields a [`PtyOutput`] stream, so
//! the task pump cannot tell whether the PTY lives in this process or in a host.
//!
//! Two ways in:
//!
//! * [`HostLink::spawn`] — start a fresh detached host for a new task.
//! * [`HostLink::attach`] — dial the host of a task that outlived its server,
//!   resuming the byte stream after the offset the server has durably persisted.
//!
//! The only addition over `PtyHandle` is [`HostLink::ack`]: the host retains
//! output until the server says it is durable, so the pump must report progress
//! or the agent eventually blocks. See [`super::runner`].

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;

use super::proto::{self, Ack, Attach, FromHost, Resize, ToHost, PROTO_VERSION};
use super::runner::{HostSpec, SPEC_ENV};
use super::HOST_ARG;
use crate::{
    error::{AppError, AppResult},
    ipc,
    pty_proc::{PtyOutput, OUTPUT_DEPTH},
};

/// Cap on the HELLO/ATTACH exchange. A host that is reachable but wedged must not
/// hang us: `reattach_hosts` runs this during startup, so an unbounded wait here
/// would keep the whole server from coming up.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// A connected pty-host, as seen from the server.
pub struct HostLink {
    task_id: String,
    endpoint: String,
    /// The host process we spawned, when we are the server that spawned it. `None`
    /// after a re-attach, where the pid comes from the store instead.
    host_pid: Option<u32>,
    /// The agent's pid, as reported by the host.
    agent_pid: Option<u32>,
    /// Offset the stream resumed from; where the pump starts counting.
    attach_offset: u64,
    /// Terminal size the host has applied, so a re-attaching server can size its
    /// screen emulator to the terminal the agent is actually drawing on.
    size: (u16, u16),
    /// Encoded frames queued for the writer task. Unbounded so the sync setters
    /// below never block a caller holding the task-manager lock.
    frames: mpsc::UnboundedSender<Vec<u8>>,
}

impl HostLink {
    /// Spawn a detached host for `task_id` and attach to it. The host binds its
    /// endpoint before spawning the agent, so this returns as soon as the
    /// handshake completes rather than waiting on agent startup.
    pub async fn spawn(
        db_path: &str,
        task_id: &str,
        bin: &str,
        argv: &[String],
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> AppResult<(Self, mpsc::Receiver<PtyOutput>)> {
        let dir = ipc::hosts_dir(db_path);
        std::fs::create_dir_all(&dir).map_err(|e| {
            AppError::Other(anyhow::anyhow!(
                "cannot create host directory {}: {e}",
                dir.display()
            ))
        })?;

        let endpoint = ipc::endpoint_for(db_path, task_id);
        let spec = HostSpec {
            task_id: task_id.to_string(),
            endpoint: endpoint.clone(),
            log_path: ipc::log_path_for(db_path, task_id)
                .to_string_lossy()
                .into_owned(),
            bin: bin.to_string(),
            argv: argv.to_vec(),
            cwd: cwd.map(str::to_string),
            cols,
            rows,
        };

        let host_pid = spawn_detached(&spec)?;
        tracing::info!(task = %task_id, host_pid, %endpoint, "pty-host spawned");
        Self::dial(task_id, &endpoint, 0, Some(host_pid)).await
    }

    /// Re-attach to a host that survived a server restart, resuming after the
    /// last byte offset the server persisted.
    pub async fn attach(
        task_id: &str,
        endpoint: &str,
        after: u64,
        host_pid: Option<u32>,
    ) -> AppResult<(Self, mpsc::Receiver<PtyOutput>)> {
        Self::dial(task_id, endpoint, after, host_pid).await
    }

    async fn dial(
        task_id: &str,
        endpoint: &str,
        after: u64,
        host_pid: Option<u32>,
    ) -> AppResult<(Self, mpsc::Receiver<PtyOutput>)> {
        let stream = ipc::connect(endpoint).await?;
        let (mut reader, mut writer) = tokio::io::split(stream);

        let hello = match handshake(&mut reader).await? {
            Some(FromHost::Hello(h)) => h,
            Some(other) => {
                return Err(AppError::Other(anyhow::anyhow!(
                    "host sent {other:?} before HELLO"
                )))
            }
            None => {
                return Err(AppError::Other(anyhow::anyhow!(
                    "host closed before sending HELLO"
                )))
            }
        };
        if hello.proto != PROTO_VERSION {
            return Err(AppError::Other(anyhow::anyhow!(
                "host speaks protocol v{}, this server speaks v{PROTO_VERSION}",
                hello.proto
            )));
        }

        // Ask only for what the host can still replay. Below `retained_from` means
        // bytes were dropped (the host gave up waiting); above `produced` means the
        // host is younger than our durable state. Both are visible, not silent.
        let resume = after.clamp(hello.retained_from, hello.produced);
        if resume != after {
            tracing::warn!(
                task = %task_id,
                persisted = after,
                retained_from = hello.retained_from,
                produced = hello.produced,
                resuming_at = resume,
                "durable offset is outside the host's retained window"
            );
        }
        proto::write_msg(
            &mut writer,
            &ToHost::Attach(Attach {
                proto: PROTO_VERSION,
                after: resume,
            })
            .encode(),
        )
        .await?;
        tracing::info!(
            task = %task_id,
            agent_pid = ?hello.agent_pid,
            resume_at = resume,
            produced = hello.produced,
            "attached to pty-host"
        );

        let (frames, frame_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(write_frames(writer, frame_rx));

        let (out_tx, out_rx) = mpsc::channel::<PtyOutput>(OUTPUT_DEPTH);
        tokio::spawn(read_host(task_id.to_string(), reader, out_tx, resume));

        Ok((
            Self {
                task_id: task_id.to_string(),
                endpoint: endpoint.to_string(),
                host_pid,
                agent_pid: hello.agent_pid,
                attach_offset: resume,
                size: (hello.cols, hello.rows),
                frames,
            },
            out_rx,
        ))
    }

    /// The agent's pid — the process a client thinks of as the task, and the one
    /// [`crate::task`] records for liveness checks.
    pub fn pid(&self) -> Option<u32> {
        self.agent_pid
    }

    /// The host process's pid, so a later server can tell a live host from a
    /// stale endpoint without dialing it.
    pub fn host_pid(&self) -> Option<u32> {
        self.host_pid
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Stream offset this link resumed at. The pump adds each persisted chunk's
    /// length to this to know what to [`ack`](Self::ack).
    pub fn attach_offset(&self) -> u64 {
        self.attach_offset
    }

    /// `(cols, rows)` currently applied to the host's terminal.
    pub fn size(&self) -> (u16, u16) {
        self.size
    }

    pub fn send_input(&self, bytes: &[u8]) -> AppResult<()> {
        self.send(ToHost::Input(bytes.to_vec()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        self.send(ToHost::Resize(Resize { cols, rows }))
    }

    /// Report that everything below `offset` is durable, freeing the host's
    /// retention buffer. Best-effort: a dead link needs no acks.
    pub fn ack(&self, offset: u64) {
        let _ = self.send(ToHost::Ack(Ack { offset }));
    }

    /// Kill the agent. The host exits once the server has collected the status.
    pub fn terminate(&self) {
        let _ = self.send(ToHost::Terminate);
    }

    fn send(&self, msg: ToHost) -> AppResult<()> {
        self.frames.send(msg.encode()).map_err(|_| {
            AppError::Other(anyhow::anyhow!(
                "pty-host for task {} is no longer connected",
                self.task_id
            ))
        })
    }
}

/// Read the host's opening message, refusing to wait forever on a host that
/// accepted the connection but never spoke.
async fn handshake<R: AsyncRead + Unpin>(reader: &mut R) -> AppResult<Option<FromHost>> {
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, proto::read_from_host(reader)).await {
        Ok(r) => r,
        Err(_) => Err(AppError::Other(anyhow::anyhow!(
            "pty-host did not send HELLO within {HANDSHAKE_TIMEOUT:?}"
        ))),
    }
}

/// Serialize queued frames onto the connection. Ends when the link is dropped or
/// the host goes away; the reader task is what reports that upwards.
async fn write_frames<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut frame_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    while let Some(frame) = frame_rx.recv().await {
        if let Err(e) = proto::write_msg(&mut writer, &frame).await {
            tracing::debug!(error = %e, "host link write ended");
            return;
        }
    }
}

/// Turn host messages into the [`PtyOutput`] stream the task pump consumes.
/// `cursor` tracks the next expected offset so a replay overlap is trimmed rather
/// than duplicated into the durable log.
///
/// This task, not the [`HostLink`], owns the read half — a link may be dropped
/// while its exit is still in flight (that is what `terminate` does), and the pump
/// still needs to see it. It ends when the pump's receiver goes away, which is
/// what closes the connection and lets the host accept the next server.
async fn read_host<R: AsyncRead + Unpin>(
    task_id: String,
    mut reader: R,
    out_tx: mpsc::Sender<PtyOutput>,
    mut cursor: u64,
) {
    loop {
        let next = tokio::select! {
            m = proto::read_from_host(&mut reader) => m,
            // Nobody is consuming output any more, so holding the socket open
            // would only keep the host serving a server that has moved on.
            _ = out_tx.closed() => {
                tracing::debug!(task = %task_id, "output consumer gone; closing host link");
                return;
            }
        };
        match next {
            Ok(Some(FromHost::Output { offset, mut bytes })) => {
                let end = offset + bytes.len() as u64;
                if end <= cursor {
                    continue; // already persisted; the host replayed further back
                }
                if offset < cursor {
                    bytes.drain(..(cursor - offset) as usize);
                } else if offset > cursor {
                    // Must not happen: the host replays from the offset we asked
                    // for. Log loudly — the durable stream now has a hole.
                    tracing::error!(
                        task = %task_id,
                        expected = cursor,
                        got = offset,
                        "gap in host output stream"
                    );
                }
                cursor = end;
                // A bounded send is the top of the backpressure chain: a slow
                // store stalls the host's buffer, which stalls the agent.
                if out_tx.send(PtyOutput::Chunk(bytes)).await.is_err() {
                    return;
                }
            }
            Ok(Some(FromHost::Exited(e))) => {
                let _ = out_tx.send(PtyOutput::Exited(e.code)).await;
                return;
            }
            Ok(Some(FromHost::Hello(_))) => {
                tracing::warn!(task = %task_id, "unexpected second HELLO; ignoring");
            }
            // The host vanished without reporting an exit. Its PTY master died
            // with it, so the agent is gone too — report an unknown-code exit
            // rather than leaving the task stuck in Running.
            Ok(None) => {
                tracing::warn!(task = %task_id, "pty-host closed without reporting an exit");
                let _ = out_tx.send(PtyOutput::Exited(None)).await;
                return;
            }
            Err(e) => {
                tracing::warn!(task = %task_id, error = %e, "host link read failed");
                let _ = out_tx.send(PtyOutput::Exited(None)).await;
                return;
            }
        }
    }
}

/// Start this executable as a pty-host, detached from our console and process
/// group so it survives us. Returns the host's pid.
fn spawn_detached(spec: &HostSpec) -> AppResult<u32> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot locate our own binary: {e}")))?;
    let payload = serde_json::to_string(spec)
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot encode host spec: {e}")))?;

    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg(HOST_ARG)
        .env(SPEC_ENV, payload)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());

    // Leave the child running when the server exits, and let tokio's orphan
    // reaper collect it on unix so an exited host never lingers as a zombie.
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            // A new session detaches the host from our controlling terminal, so a
            // Ctrl-C in the server's console can never reach it. Failure means we
            // are already a session leader, which is just as good.
            libc::setsid();
            Ok(())
        });
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS: no console at all (the host logs to a file).
        // CREATE_NEW_PROCESS_GROUP: console signals stop at our boundary.
        // CREATE_BREAKAWAY_FROM_JOB: escape a service job object that would
        // otherwise kill the host when the server is stopped.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    }

    let spawned = cmd.spawn();
    #[cfg(windows)]
    let spawned = match spawned {
        // A job object that forbids breakaway rejects the flag outright; without
        // it the host dies with the service, which is still better than no host.
        Err(e) => {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            tracing::warn!(error = %e, "spawn with job breakaway failed; retrying without it");
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
            cmd.spawn()
        }
        ok => ok,
    };

    let child = spawned.map_err(|e| {
        AppError::Other(anyhow::anyhow!(
            "cannot spawn pty-host {}: {e}",
            exe.display()
        ))
    })?;
    child
        .id()
        .ok_or_else(|| AppError::Other(anyhow::anyhow!("pty-host exited before reporting a pid")))
    // `child` is dropped here on purpose: the host must outlive us.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::runner;

    fn spec(dir: &std::path::Path, task_id: &str, script: &str) -> HostSpec {
        let db = dir.join("switchboard.db").to_string_lossy().into_owned();
        HostSpec {
            task_id: task_id.to_string(),
            endpoint: ipc::endpoint_for(&db, task_id),
            log_path: ipc::log_path_for(&db, task_id)
                .to_string_lossy()
                .into_owned(),
            bin: "sh".into(),
            argv: vec!["-c".into(), script.into()],
            cwd: None,
            cols: 80,
            rows: 24,
        }
    }

    /// Read chunks until `needle` shows up in the accumulated text.
    async fn wait_for(rx: &mut mpsc::Receiver<PtyOutput>, needle: &str) -> String {
        let mut acc = String::new();
        loop {
            match tokio::time::timeout(std::time::Duration::from_secs(10), rx.recv()).await {
                Ok(Some(PtyOutput::Chunk(b))) => {
                    acc.push_str(&String::from_utf8_lossy(&b));
                    if acc.contains(needle) {
                        return acc;
                    }
                }
                Ok(Some(PtyOutput::Exited(c))) => {
                    panic!("exited with {c:?} before {needle:?}; got {acc:?}")
                }
                Ok(None) => panic!("stream ended before {needle:?}; got {acc:?}"),
                Err(_) => panic!("timed out waiting for {needle:?}; got {acc:?}"),
            }
        }
    }

    /// The whole point of the architecture: a host keeps the agent alive while no
    /// server is attached, and a *second* link — standing in for the process that
    /// comes up after an upgrade — resumes the byte stream exactly where the
    /// first one stopped acknowledging, with nothing lost and nothing doubled.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_second_link_resumes_the_stream_without_loss_or_duplication() {
        let dir = tempfile::tempdir().unwrap();
        let task_id = uuid::Uuid::new_v4().to_string();
        // Echo each line back, so we can drive output from the server side and
        // know exactly how many bytes the agent produced.
        let spec = spec(
            dir.path(),
            &task_id,
            "while IFS= read -r l; do printf 'GOT:%s\\n' \"$l\"; done",
        );
        let endpoint = spec.endpoint.clone();
        let host = tokio::spawn(runner::run(spec));

        let (first, mut rx) = HostLink::attach(&task_id, &endpoint, 0, None)
            .await
            .expect("first attach");
        first.send_input(b"one\n").unwrap();
        let seen = wait_for(&mut rx, "GOT:one").await;
        // Acknowledge only up to the start of the marker, then drop the link
        // without acking the rest — the durable offset a crashed server would
        // have left behind.
        let acked = seen.find("GOT:one").expect("marker") as u64;
        first.ack(acked);
        // Give the ack a moment to land before the link goes away.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        drop(first);
        drop(rx);

        let (second, mut rx) = HostLink::attach(&task_id, &endpoint, acked, None)
            .await
            .expect("second attach");
        assert_eq!(second.attach_offset(), acked, "must resume where we acked");
        // Everything from the unacked point on is replayed to the new link...
        let replayed = wait_for(&mut rx, "GOT:one").await;
        assert!(
            replayed.starts_with("GOT:one"),
            "replay must start at the acked offset; got {replayed:?}"
        );
        // ...and the agent is still live, so new input still round-trips.
        second.send_input(b"two\n").unwrap();
        wait_for(&mut rx, "GOT:two").await;

        second.terminate();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), host).await;
    }

    /// Output produced while no server is attached must be waiting when one
    /// arrives, not dropped.
    #[cfg(unix)]
    #[tokio::test]
    async fn output_produced_while_detached_is_replayed_on_attach() {
        let dir = tempfile::tempdir().unwrap();
        let task_id = uuid::Uuid::new_v4().to_string();
        let spec = spec(dir.path(), &task_id, "printf 'EARLY\\n'; sleep 30");
        let endpoint = spec.endpoint.clone();
        let host = tokio::spawn(runner::run(spec));

        // Nobody is attached yet; let the agent write and exit its printf.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        let (link, mut rx) = HostLink::attach(&task_id, &endpoint, 0, None)
            .await
            .expect("attach");
        wait_for(&mut rx, "EARLY").await;
        link.terminate();
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), host).await;
    }
}
