//! The pty-host process itself: owns one task's PTY and agent, and serves
//! whichever server is currently attached.
//!
//! Invoked as `switchboard-server pty-host` with its parameters in the
//! [`SPEC_ENV`] environment variable. It is spawned detached, so it has no
//! console and logs to a file beside the database.
//!
//! Output is buffered until the server confirms it has been persisted. When that
//! buffer fills — which is what happens while no server is attached — the host
//! stops draining the PTY, and the backpressure reaches the agent (see
//! `pty_proc::OUTPUT_DEPTH`). A restart therefore costs latency, never bytes.

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, Notify};

use super::proto::{self, Ack, Exited, FromHost, Hello, Resize, ToHost, PROTO_VERSION};
use crate::{
    error::{AppError, AppResult},
    ipc,
    pty_proc::{self, PtyHandle, PtyOutput},
};

/// Environment variable carrying the JSON [`HostSpec`]. Scrubbed from the
/// environment before the agent is spawned so it never leaks into the child.
pub const SPEC_ENV: &str = "SWITCHBOARD_PTY_HOST";

/// Unacked bytes we will hold before we stop reading the PTY. Sized for a
/// screenful-per-frame agent redrawing continuously through a restart that takes
/// a second or two; past this the agent blocks rather than us dropping output.
const MAX_UNACKED: usize = 4 * 1024 * 1024;

/// Largest OUTPUT payload we put on the wire at once.
const SEND_CHUNK: usize = 8 * 1024;

/// If no server has *ever* attached this long after startup, we were orphaned by
/// a server that died mid-spawn: kill the agent and exit rather than linger with
/// a task nobody knows about.
const STARTUP_GRACE: std::time::Duration = std::time::Duration::from_secs(120);

/// After the agent exits, how long to stay alive waiting to hand the exit status
/// to a server. Bounds the lifetime of a host whose server never returns.
const EXIT_LINGER: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Everything the host needs to run one task. Produced by the server, passed
/// through [`SPEC_ENV`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostSpec {
    pub task_id: String,
    /// IPC endpoint to listen on (see [`crate::ipc::endpoint_for`]).
    pub endpoint: String,
    /// Where the host writes its own diagnostics.
    pub log_path: String,
    /// Fully resolved executable and arguments for the agent.
    pub bin: String,
    pub argv: Vec<String>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

impl HostSpec {
    pub fn from_env() -> AppResult<Self> {
        let raw = std::env::var(SPEC_ENV).map_err(|_| {
            AppError::BadRequest(format!(
                "{SPEC_ENV} is not set; pty-host is spawned by the server"
            ))
        })?;
        // Scrub it immediately: `pty_proc` copies our environment into the agent,
        // and the agent has no business seeing the host's wiring.
        std::env::remove_var(SPEC_ENV);
        serde_json::from_str(&raw)
            .map_err(|e| AppError::BadRequest(format!("malformed {SPEC_ENV}: {e}")))
    }
}

/// Unacked output plus the agent's terminal state, shared between the PTY
/// drainer and whichever connection is currently attached.
struct Buffer {
    /// Bytes produced but not yet acknowledged as durable by a server.
    unacked: Vec<u8>,
    /// Stream offset of `unacked[0]`; also the acknowledged watermark.
    base: u64,
    /// `Some` once the agent has exited, carrying its code.
    exit: Option<Option<i32>>,
    cols: u16,
    rows: u16,
}

impl Buffer {
    /// Total bytes the agent has produced over the host's lifetime.
    fn produced(&self) -> u64 {
        self.base + self.unacked.len() as u64
    }

    /// Drop everything below `offset`, which a server has persisted.
    fn ack(&mut self, offset: u64) {
        let Some(drop_to) = offset.checked_sub(self.base) else {
            return; // stale ack; the watermark never moves backwards
        };
        let drop_to = (drop_to as usize).min(self.unacked.len());
        self.unacked.drain(..drop_to);
        self.base += drop_to as u64;
    }

    /// Bytes from `cursor` on, capped at [`SEND_CHUNK`].
    fn slice_from(&self, cursor: u64) -> Option<(u64, Vec<u8>)> {
        let start = cursor.checked_sub(self.base)? as usize;
        if start >= self.unacked.len() {
            return None;
        }
        let end = (start + SEND_CHUNK).min(self.unacked.len());
        Some((cursor, self.unacked[start..end].to_vec()))
    }
}

/// Shared host state. `changed` wakes the sender when there is new output or a
/// new exit; `drained` wakes the PTY reader when an ack frees buffer space.
struct Shared {
    buf: Mutex<Buffer>,
    changed: Notify,
    drained: Notify,
}

/// Run as a pty-host. Returns when the agent has exited and its status has been
/// delivered (or the linger window expired).
pub async fn run(spec: HostSpec) -> AppResult<()> {
    // Bind before spawning the agent: the server dials immediately after spawn,
    // and this way it never has to wait through a slow agent startup.
    let mut listener = ipc::listen(&spec.endpoint)?;
    tracing::info!(task = %spec.task_id, endpoint = %spec.endpoint, "pty-host listening");

    let (handle, out_rx) = pty_proc::spawn_cmd(
        &spec.bin,
        &spec.argv,
        spec.cwd.as_deref(),
        spec.cols,
        spec.rows,
    )?;
    let agent_pid = handle.pid();
    tracing::info!(task = %spec.task_id, bin = %spec.bin, ?agent_pid, "agent spawned");

    let shared = Arc::new(Shared {
        buf: Mutex::new(Buffer {
            unacked: Vec::new(),
            base: 0,
            exit: None,
            cols: spec.cols,
            rows: spec.rows,
        }),
        changed: Notify::new(),
        drained: Notify::new(),
    });

    tokio::spawn(drain_pty(shared.clone(), out_rx));

    let handle = Arc::new(handle);
    let mut ever_attached = false;
    loop {
        // Nothing left to do once the agent has exited and everything it produced
        // (including the exit status) has been acknowledged.
        if finished(&shared) {
            tracing::info!(task = %spec.task_id, "output fully acknowledged; pty-host exiting");
            return Ok(());
        }

        let deadline = match (ever_attached, shared.buf.lock().unwrap().exit.is_some()) {
            (false, _) => Some(STARTUP_GRACE),
            (true, true) => Some(EXIT_LINGER),
            (true, false) => None,
        };
        let accepted = match deadline {
            Some(d) => match tokio::time::timeout(d, listener.accept()).await {
                Ok(r) => r,
                Err(_) if !ever_attached => {
                    tracing::warn!(
                        task = %spec.task_id,
                        "no server attached within the startup grace period; killing the agent"
                    );
                    handle.terminate();
                    return Ok(());
                }
                Err(_) => {
                    tracing::warn!(
                        task = %spec.task_id,
                        "agent exited but no server collected its status; giving up"
                    );
                    return Ok(());
                }
            },
            None => listener.accept().await,
        };

        let stream = match accepted {
            Ok(s) => s,
            Err(e) => {
                tracing::error!(task = %spec.task_id, error = %e, "ipc accept failed");
                continue;
            }
        };
        ever_attached = true;
        tracing::info!(task = %spec.task_id, "server attached");
        if let Err(e) = serve(stream, &shared, &handle).await {
            // A server that vanishes mid-session is the expected case (that is
            // what an upgrade looks like), not an error worth alarming about.
            tracing::info!(task = %spec.task_id, reason = %e, "server detached");
        }
    }
}

/// Has everything the agent produced, including its exit, been acknowledged?
fn finished(shared: &Shared) -> bool {
    let buf = shared.buf.lock().unwrap();
    buf.exit.is_some() && buf.unacked.is_empty()
}

/// Move PTY output into the unacked buffer, pausing while it is full so the
/// pressure reaches the agent instead of growing memory without bound.
async fn drain_pty(shared: Arc<Shared>, mut out_rx: mpsc::Receiver<PtyOutput>) {
    loop {
        // Wait for room before taking the next chunk. Checking before `recv`
        // keeps the bounded channel full, which is what stalls the PTY reader.
        loop {
            let full = {
                let buf = shared.buf.lock().unwrap();
                buf.unacked.len() >= MAX_UNACKED
            };
            if !full {
                break;
            }
            shared.drained.notified().await;
        }

        match out_rx.recv().await {
            Some(PtyOutput::Chunk(bytes)) => {
                shared.buf.lock().unwrap().unacked.extend_from_slice(&bytes);
                shared.changed.notify_waiters();
            }
            Some(PtyOutput::Exited(code)) => {
                tracing::info!(?code, "agent exited");
                shared.buf.lock().unwrap().exit = Some(code);
                shared.changed.notify_waiters();
                return;
            }
            // The PTY threads are gone without an explicit exit; treat it as an
            // unknown-code exit so the server is never left waiting.
            None => {
                let mut buf = shared.buf.lock().unwrap();
                if buf.exit.is_none() {
                    buf.exit = Some(None);
                }
                drop(buf);
                shared.changed.notify_waiters();
                return;
            }
        }
    }
}

/// Serve one attached server until the connection ends.
async fn serve<S>(stream: S, shared: &Arc<Shared>, handle: &Arc<PtyHandle>) -> AppResult<()>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);

    let (cols, rows, produced, base) = {
        let buf = shared.buf.lock().unwrap();
        (buf.cols, buf.rows, buf.produced(), buf.base)
    };
    proto::write_msg(
        &mut writer,
        &FromHost::Hello(Hello {
            proto: PROTO_VERSION,
            agent_pid: handle.pid(),
            host_pid: Some(std::process::id()),
            cols,
            rows,
            produced,
            retained_from: base,
        })
        .encode(),
    )
    .await?;

    let Some(ToHost::Attach(attach)) = proto::read_to_host(&mut reader).await? else {
        return Err(AppError::Other(anyhow::anyhow!(
            "server closed before sending ATTACH"
        )));
    };
    if attach.proto != PROTO_VERSION {
        return Err(AppError::Other(anyhow::anyhow!(
            "server speaks host protocol v{}, this host speaks v{PROTO_VERSION}",
            attach.proto
        )));
    }
    // The server can only ask to resume from something we still hold. Below the
    // watermark means it lost durable state; above what we produced means it is
    // talking to a host it thinks is older than it is. Clamp, and say so.
    let mut cursor = attach.after.clamp(base, produced);
    if cursor != attach.after {
        tracing::warn!(
            requested = attach.after,
            retained_from = base,
            produced,
            resuming_at = cursor,
            "server asked to resume outside the retained window"
        );
    }
    tracing::info!(resume_at = cursor, produced, "attached");

    // Inbound control runs on its own task so a chatty typist can never delay
    // output, and vice versa.
    let inbound = tokio::spawn({
        let shared = shared.clone();
        let handle = handle.clone();
        async move {
            loop {
                match proto::read_to_host(&mut reader).await {
                    Ok(Some(msg)) => apply(msg, &shared, &handle),
                    Ok(None) => return,
                    Err(e) => {
                        tracing::debug!(error = %e, "inbound host stream ended");
                        return;
                    }
                }
            }
        }
    });

    let result = pump_output(&mut writer, shared, &mut cursor, &inbound).await;
    inbound.abort();
    result
}

/// Apply one server → host message.
fn apply(msg: ToHost, shared: &Arc<Shared>, handle: &Arc<PtyHandle>) {
    match msg {
        ToHost::Input(bytes) => {
            if let Err(e) = handle.send_input(&bytes) {
                tracing::warn!(error = %e, "dropping input for a closed pty");
            }
        }
        ToHost::Resize(Resize { cols, rows }) => {
            {
                let mut buf = shared.buf.lock().unwrap();
                buf.cols = cols;
                buf.rows = rows;
            }
            if let Err(e) = handle.resize(cols, rows) {
                tracing::warn!(error = %e, "dropping resize for a closed pty");
            }
        }
        ToHost::Ack(Ack { offset }) => {
            shared.buf.lock().unwrap().ack(offset);
            // Freeing buffer space may be what the PTY drainer is waiting on.
            shared.drained.notify_waiters();
        }
        ToHost::Terminate => {
            tracing::info!("terminate requested by server");
            handle.terminate();
        }
        // The server only sends ATTACH once, during the handshake.
        ToHost::Attach(_) => tracing::warn!("unexpected second ATTACH; ignoring"),
    }
}

/// Stream buffered output, then the exit status, until the connection breaks.
async fn pump_output<W: AsyncWrite + Unpin>(
    writer: &mut W,
    shared: &Arc<Shared>,
    cursor: &mut u64,
    inbound: &tokio::task::JoinHandle<()>,
) -> AppResult<()> {
    loop {
        // Take a notification permit *before* inspecting state, so an append
        // between the check and the await cannot be missed.
        let wake = shared.changed.notified();

        loop {
            let next = shared.buf.lock().unwrap().slice_from(*cursor);
            match next {
                Some((offset, bytes)) => {
                    *cursor = offset + bytes.len() as u64;
                    proto::write_msg(writer, &FromHost::Output { offset, bytes }.encode()).await?;
                }
                None => break,
            }
        }

        // All output is on the wire; if the agent is gone, report it and wait for
        // the server to acknowledge the tail before we let `run` exit.
        let exit = {
            let buf = shared.buf.lock().unwrap();
            // Only report once the cursor has caught up with production, so the
            // exit can never overtake the output that preceded it.
            (buf.exit.is_some() && *cursor >= buf.produced()).then(|| buf.exit.expect("checked"))
        };
        if let Some(code) = exit {
            proto::write_msg(writer, &FromHost::Exited(Exited { code }).encode()).await?;
            // Stay attached until the server acks the tail (then `run` sees
            // `finished`) or drops the link.
            while !finished(shared) {
                if inbound.is_finished() {
                    return Ok(());
                }
                tokio::select! {
                    _ = shared.drained.notified() => {}
                    _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {}
                }
            }
            return Ok(());
        }

        if inbound.is_finished() {
            return Ok(());
        }
        tokio::select! {
            _ = wake => {}
            // The inbound half owns detecting a dropped connection; poll so a
            // silent PTY doesn't leave us parked forever after it does.
            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn buffer() -> Buffer {
        Buffer {
            unacked: Vec::new(),
            base: 0,
            exit: None,
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn ack_advances_the_watermark_and_frees_bytes() {
        let mut b = buffer();
        b.unacked.extend_from_slice(b"hello world");
        assert_eq!(b.produced(), 11);

        b.ack(6);
        assert_eq!(b.base, 6);
        assert_eq!(b.unacked, b"world");
        assert_eq!(b.produced(), 11, "acking must not change what was produced");

        // A stale ack (below the watermark) is ignored, not applied backwards.
        b.ack(2);
        assert_eq!(b.base, 6);
        assert_eq!(b.unacked, b"world");

        // An ack beyond what exists clamps to what we hold.
        b.ack(999);
        assert!(b.unacked.is_empty());
        assert_eq!(b.base, 11);
    }

    #[test]
    fn slice_from_walks_the_buffer_in_send_chunks() {
        let mut b = buffer();
        b.unacked.extend(std::iter::repeat_n(b'x', SEND_CHUNK + 10));

        let (offset, bytes) = b.slice_from(0).expect("data at the start");
        assert_eq!(offset, 0);
        assert_eq!(bytes.len(), SEND_CHUNK, "a single frame is capped");

        let (offset, bytes) = b.slice_from(SEND_CHUNK as u64).expect("the tail");
        assert_eq!(offset, SEND_CHUNK as u64);
        assert_eq!(bytes.len(), 10);

        assert!(
            b.slice_from(b.produced()).is_none(),
            "caught up yields none"
        );
    }

    /// After an ack the retained window starts above zero; a cursor inside it
    /// must still resolve to the right absolute offset.
    #[test]
    fn slice_from_is_absolute_after_acks() {
        let mut b = buffer();
        b.unacked.extend_from_slice(b"0123456789");
        b.ack(4);
        let (offset, bytes) = b.slice_from(6).expect("data after the watermark");
        assert_eq!(offset, 6);
        assert_eq!(bytes, b"6789");
        assert!(b.slice_from(2).is_none(), "below the watermark is gone");
    }
}
