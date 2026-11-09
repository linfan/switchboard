//! WebSocket endpoint: the persistent, real-time sync channel.
//!
//! Hybrid transport: JSON control plane on **text** frames, raw terminal bytes
//! on **binary** frames (see `shared/src/frame.rs`). Flow: client connects with
//! `?token=`, sends `Hello{client_id, cursors}`; the server replies `Welcome`,
//! then per task reconstructs the client's terminal — a **snapshot** when the
//! backlog is large, otherwise a **byte fast-forward** of chunks past the
//! cursor — and finally streams live output. A writer loop owns the socket sink
//! and multiplexes replay, live broadcast, and point-to-point replies; a reader
//! task handles inbound text control + binary INPUT frames.

use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use switchboard_shared::{
    auth::{ct_eq, from_hex, hex, random_nonce, ws_mac, AuthMsg, NONCE_LEN},
    frame::Frame,
    ClientMsg, ServerMsg,
};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::{
    state::SharedState,
    task::{CreateParams, Outbound},
};

/// Backlog size (in chunks) above which reconnect prefers a screen snapshot over
/// replaying every raw chunk.
const SNAPSHOT_THRESHOLD: u64 = 256;
/// Replay pacing window, in unacknowledged data frames per task. A client that
/// declares `acks` support never has more than this many replay frames in
/// flight, so a backlog larger than the repeater's per-stream queue is paced to
/// the receiver instead of being dumped — which would reset the stream.
pub(crate) const REPLAY_WINDOW: u64 = 256;

/// Buffer for the unified outbound writer. Bounded so a slow client applies
/// backpressure to the session instead of growing memory without limit.
const OUT_BUF: usize = 512;
/// Priority lane for order-independent control replies (pongs), so terminal
/// output or a replay cannot bury them behind the whole data queue.
const CTL_BUF: usize = 8;
/// Buffer for inbound frames handed from the transport bridge to the session.
const IN_BUF: usize = 64;
/// Inbound frame size worth naming in the log. A paste arrives as a single
/// binary INPUT frame (as does a reconnect's buffered-keystroke replay), so a
/// large one is the first thing to check when a client drops right after typing.
const LARGE_INBOUND_FRAME: usize = 4096;
/// Bound the whole pre-session handshake: a peer that connects, reads the
/// challenge, and then goes silent must not pin a task (and, on the repeater
/// legs, a socket) indefinitely.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Garbage frames tolerated before abandoning the handshake early. Together with
/// [`AUTH_TIMEOUT`] this stops a peer from staying alive by feeding junk just
/// under the deadline.
const MAX_INVALID_AUTH_FRAMES: usize = 8;

/// A transport-neutral inbound frame. The direct-mode bridge produces these from
/// an axum `WebSocket`; the repeater tunnel produces them from tunnel frames.
pub enum WsIn {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

/// A transport-neutral outbound frame. `run_session` emits these; a transport
/// bridge turns them back into WebSocket or tunnel frames.
pub enum WsOut {
    Text(String),
    Binary(Vec<u8>),
}

/// Axum handler: upgrade, then run the channel-bound auth handshake before any
/// application traffic (no credential is carried in the URL).
pub async fn ws_handler(
    State(state): State<SharedState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Direct mode: run the auth handshake on the raw socket, then bridge the axum
/// `WebSocket` to transport-neutral channels and hand off to `run_session`. The
/// session logic is shared verbatim with the repeater-worker path, which feeds
/// the same channels from tunnel frames instead.
async fn handle_socket(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();

    // 0. SWB-WS-v1 channel-bound challenge-response. Token is never sent.
    if !ws_handshake(
        &mut sink,
        &mut stream,
        state.config.token.as_deref(),
        &state.cert_fp,
    )
    .await
    {
        return;
    }

    let (in_tx, in_rx) = mpsc::channel::<WsIn>(IN_BUF);
    let (out_tx, mut out_rx) = mpsc::channel::<WsOut>(OUT_BUF);
    let (ctl_tx, mut ctl_rx) = mpsc::channel::<WsOut>(CTL_BUF);

    // Inbound bridge: axum stream -> WsIn. A closed/errored socket ends the
    // stream; forward a final Close so the session's reader loop terminates.
    tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            let win = match msg {
                Ok(Message::Text(t)) => WsIn::Text(t.to_string()),
                Ok(Message::Binary(b)) => WsIn::Binary(b.to_vec()),
                Ok(Message::Close(frame)) => {
                    match frame {
                        Some(f) => tracing::info!(
                            code = f.code,
                            reason = %f.reason,
                            "websocket close frame received"
                        ),
                        None => tracing::info!("websocket close frame without a reason"),
                    }
                    break;
                }
                Ok(_) => continue,
                Err(e) => {
                    tracing::warn!(error = %e, "websocket read error");
                    break;
                }
            };
            if in_tx.send(win).await.is_err() {
                return;
            }
        }
        let _ = in_tx.send(WsIn::Close).await;
    });

    // Outbound bridge: WsOut -> axum sink. Exiting on a sink error drops the
    // receiver, so the session's next `out_tx.send` fails — its disconnect signal.
    tokio::spawn(async move {
        let started = Instant::now();
        let mut bytes: u64 = 0;
        let mut write_ms: u64 = 0;
        loop {
            // Control first: a pong overtaking queued terminal data is safe
            // (it echoes a timestamp) and keeps the heartbeat honest.
            let out = tokio::select! {
                biased;
                Some(out) = ctl_rx.recv() => out,
                Some(out) = out_rx.recv() => out,
                else => break,
            };
            let msg = match out {
                WsOut::Text(t) => Message::Text(t.into()),
                WsOut::Binary(b) => Message::Binary(b.into()),
            };
            let len = match &msg {
                Message::Text(t) => t.len(),
                Message::Binary(b) => b.len(),
                _ => 0,
            } as u64;
            let write_started = Instant::now();
            if sink.send(msg).await.is_err() {
                break;
            }
            bytes += len;
            let waited = write_started.elapsed();
            write_ms += waited.as_millis() as u64;
            // A blocked write is the signature of TCP backpressure: the client
            // is not draining, and every queued frame (pong included) waits.
            if waited >= Duration::from_secs(1) {
                tracing::warn!(
                    bytes = len,
                    waited_ms = waited.as_millis() as u64,
                    "outbound write blocked"
                );
            }
        }
        tracing::info!(
            bytes,
            write_ms,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "outbound bridge closed"
        );
    });

    run_session(in_rx, out_tx, state, Some(ctl_tx)).await;
}

/// The transport-neutral session: Hello handshake, Welcome, per-task
/// reconstruction, then the live output loop. Speaks only `WsIn`/`WsOut`
/// channels, so it is identical for a directly-connected client and for a client
/// forwarded through the repeater tunnel.
pub async fn run_session(
    mut rx: mpsc::Receiver<WsIn>,
    out_tx: mpsc::Sender<WsOut>,
    state: SharedState,
    control: Option<mpsc::Sender<WsOut>>,
) {
    // 1. Handshake: the first frame must be Hello.
    let (client_id, cursors, acks, history_enabled) = match read_hello(&mut rx).await {
        Some(h) => h,
        None => return,
    };
    tracing::info!(%client_id, acks, history_enabled, "client connected");
    let connected_at = Instant::now();
    let tracker = AckTracker::new(acks, &cursors);
    let (history_tx, mut history_rx) = mpsc::channel::<WsOut>(8);
    let history_workers = HistoryWorkers::new(state.clone(), client_id.clone(), history_tx);

    // 2. Subscribe BEFORE replay so output produced during replay isn't missed.
    let mut broadcast_rx = state.tasks.subscribe();
    let (direct_tx, mut direct_rx) = mpsc::unbounded_channel::<ServerMsg>();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    // 3. Inbound handling, split in two. `handle_client_msg` is awaited, and
    //    `create_task` reaches `HostLink::spawn` — a 5s host handshake plus
    //    attach retrying 3x750ms — so running it inline stalled every keystroke
    //    queued behind it for up to ~6.5s. A dispatcher now applies input inline
    //    (`send_input` is a non-blocking push) and hands control messages to a
    //    separate task. Mirrors `host/runner.rs`, which already separates inbound
    //    control from the PTY pumps for the same reason.
    {
        // Unbounded on purpose: a bounded queue would make the dispatcher await
        // here and put the head-of-line block straight back.
        let (ctl_tx, mut ctl_rx) = mpsc::unbounded_channel::<ClientMsg>();

        // Serialized, so create/terminate/delete for one task never interleave.
        let ctl = {
            let state = state.clone();
            let client_id = client_id.clone();
            let direct_tx = direct_tx.clone();
            tokio::spawn(async move {
                while let Some(cm) = ctl_rx.recv().await {
                    handle_client_msg(cm, &state, &client_id, &direct_tx).await;
                }
            })
        };

        let state = state.clone();
        let client_id = client_id.clone();
        let out = out_tx.clone();
        let tracker = tracker.clone();
        let history = history_workers.clone();
        tokio::spawn(async move {
            let mut last_ping: Option<Instant> = None;
            while let Some(win) = rx.recv().await {
                match win {
                    WsIn::Text(t) => {
                        if t.len() >= LARGE_INBOUND_FRAME {
                            tracing::info!(%client_id, bytes = t.len(), "large inbound text frame");
                        }
                        match serde_json::from_str::<ClientMsg>(&t) {
                            Ok(cm) => {
                                match &cm {
                                    // Feed the replay pacer before the control task
                                    // sees it (which still persists the cursor).
                                    ClientMsg::Ack { task_id, seq } => {
                                        tracker.advance(task_id, *seq);
                                    }
                                    ClientMsg::HistoryAck { task_id, seq } => {
                                        history.advance(task_id, *seq);
                                        continue;
                                    }
                                    ClientMsg::HistoryCancel { task_id } => {
                                        history.cancel(task_id);
                                        continue;
                                    }
                                    ClientMsg::DeleteTask { task_id } => {
                                        history.cancel(task_id);
                                    }
                                    // Answer pings here: `replay` owns the session
                                    // task while it streams, so routing a Pong
                                    // through the live loop would let a slow replay
                                    // miss the client's heartbeat deadline.
                                    ClientMsg::Ping { ts } => {
                                        // The first ping of a session, and any long gap,
                                        // is the cheapest proof that the client's heartbeat
                                        // actually reached us. Every ping would be noise.
                                        let now = Instant::now();
                                        match last_ping {
                                            None => tracing::info!(
                                                %client_id,
                                                "heartbeat ping received"
                                            ),
                                            Some(prev)
                                                if now.duration_since(prev)
                                                    > Duration::from_secs(20) =>
                                            {
                                                tracing::warn!(
                                                    %client_id,
                                                    gap_ms = now.duration_since(prev).as_millis()
                                                        as u64,
                                                    "heartbeat ping gap"
                                                )
                                            }
                                            _ => {}
                                        }
                                        last_ping = Some(now);
                                        // Pongs carry only a timestamp, so they may
                                        // overtake queued terminal data on the priority
                                        // lane instead of waiting out the whole queue.
                                        let pong = ServerMsg::Pong { ts: *ts };
                                        let sent = match &control {
                                            Some(ctl) => {
                                                serde_json::to_string(&pong).ok().is_some_and(
                                                    |json| ctl.try_send(WsOut::Text(json)).is_ok(),
                                                )
                                            }
                                            None => false,
                                        };
                                        // Lane full (or absent): fall back to the data
                                        // queue and name the backlog if it is slow.
                                        if !sent {
                                            let started = Instant::now();
                                            let _ = send_control(&out, &pong).await;
                                            let waited = started.elapsed();
                                            if waited >= Duration::from_millis(500) {
                                                tracing::warn!(
                                                    %client_id,
                                                    waited_ms = waited.as_millis() as u64,
                                                    queued = out
                                                        .max_capacity()
                                                        .saturating_sub(out.capacity()),
                                                    capacity = out.max_capacity(),
                                                    "pong delayed behind outbound backlog"
                                                );
                                            }
                                        }
                                        continue;
                                    }
                                    _ => {}
                                }
                                if ctl_tx.send(cm).is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                tracing::warn!(%client_id, error=%e, "bad client message")
                            }
                        }
                    }
                    WsIn::Binary(b) => {
                        if b.len() >= LARGE_INBOUND_FRAME {
                            tracing::info!(%client_id, bytes = b.len(), "large inbound input frame");
                        }
                        match Frame::decode(&b) {
                            Ok(Frame::Input { task_id, data }) => {
                                if let Err(e) = state.tasks.send_input(&task_id.to_string(), &data)
                                {
                                    tracing::warn!(%client_id, %task_id, error=%e, "input dropped");
                                }
                            }
                            Ok(_) => {
                                tracing::warn!(%client_id, "unexpected server-bound binary frame")
                            }
                            Err(e) => tracing::warn!(%client_id, error=%e, "bad binary frame"),
                        }
                    }
                    WsIn::Close => break,
                }
            }
            // Wake a replay parked on the pacing window: the client is gone,
            // so there is nothing left to pace against.
            tracker.close();
            // Closing the queue lets the control task finish what is already
            // queued; awaiting it keeps a command sent just before a clean
            // disconnect able to reply, as it could before this split.
            drop(ctl_tx);
            let _ = ctl.await;
            let _ = shutdown_tx.send(());
        });
    }

    // 4. Welcome + per-task reconstruction.
    let welcome = ServerMsg::Welcome {
        service: state.service_info(),
        tasks: state.tasks.list().await.unwrap_or_default(),
    };
    if !send_control(&out_tx, &welcome).await {
        tracing::info!(%client_id, reason = "welcome send failed", "client disconnected");
        return;
    }
    let mut last_sent: HashMap<String, u64> = HashMap::new();
    let replay_ctx = ReplayContext {
        out: &out_tx,
        state: &state,
        client_id: &client_id,
        tracker: &tracker,
        history_enabled,
        history_workers: &history_workers,
    };
    if !replay(replay_ctx, "connect", &cursors, &mut last_sent).await {
        history_workers.close();
        tracing::info!(%client_id, reason = "replay failed", "client disconnected");
        return;
    }

    // 5. Live loop.
    let reason;
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => {
                reason = "inbound closed";
                break;
            }
            Some(m) = direct_rx.recv() => {
                if let ServerMsg::TaskDeleted { task_id } = &m {
                    history_workers.cancel(task_id);
                }
                if !send_control(&out_tx, &m).await {
                    reason = "outbound closed";
                    break;
                }
            }
            r = broadcast_rx.recv() => match r {
                Ok(Outbound::Control(m)) => {
                    if let ServerMsg::TaskDeleted { task_id } = &m {
                        history_workers.cancel(task_id);
                    }
                    if !send_control(&out_tx, &m).await {
                        reason = "outbound closed";
                        break;
                    }
                }
                Ok(Outbound::Pty { task_id, seq, bytes }) => {
                    if last_sent.get(&task_id).is_some_and(|&s| seq <= s) {
                        continue; // already delivered via replay/snapshot
                    }
                    last_sent.insert(task_id.clone(), seq);
                    if let Ok(uuid) = Uuid::parse_str(&task_id) {
                        let frame = Frame::Output { task_id: uuid, seq, data: bytes.to_vec() };
                        if !send_binary(&out_tx, frame.encode()).await {
                            reason = "outbound closed";
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%client_id, skipped = n, "broadcast lagged; resyncing from store");
                    let from = last_sent.clone();
                    if !replay(replay_ctx, "lagged", &from, &mut last_sent)
                    .await
                    {
                        reason = "replay failed";
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    reason = "broadcast closed";
                    break;
                }
            },
            Some(out) = history_rx.recv() => {
                if out_tx.send(out).await.is_err() {
                    reason = "outbound closed";
                    break;
                }
            }
        }
    }
    history_workers.close();
    tracing::info!(
        %client_id,
        reason,
        uptime_ms = connected_at.elapsed().as_millis() as u64,
        queued = OUT_BUF.saturating_sub(out_tx.capacity()),
        "client disconnected"
    );
}

/// Run the `SWB-WS-v1` handshake: send a random challenge, read the client's
/// channel-bound MAC, and verify it against `token` + `cert_fp`. Returns `true` on
/// success (the connection may proceed to `Hello`). Generic over the secret so the
/// direct client leg (`SWITCHBOARD_TOKEN`) and the repeater's worker leg
/// (`SWITCHBOARD_REPEATER_TOKEN`) share one implementation.
pub(crate) async fn ws_handshake(
    sink: &mut futures::stream::SplitSink<WebSocket, Message>,
    stream: &mut futures::stream::SplitStream<WebSocket>,
    token: Option<&str>,
    cert_fp: &[u8],
) -> bool {
    match tokio::time::timeout(
        AUTH_TIMEOUT,
        ws_handshake_inner(sink, stream, token, cert_fp),
    )
    .await
    {
        Ok(ok) => ok,
        Err(_) => {
            tracing::warn!("websocket authentication timed out");
            let _ = send_raw(sink, &auth_error("authentication timed out")).await;
            false
        }
    }
}

async fn ws_handshake_inner(
    sink: &mut futures::stream::SplitSink<WebSocket, Message>,
    stream: &mut futures::stream::SplitStream<WebSocket>,
    token: Option<&str>,
    cert_fp: &[u8],
) -> bool {
    let server_nonce = random_nonce::<NONCE_LEN>();
    let challenge = AuthMsg::AuthChallenge {
        server_nonce: hex(&server_nonce),
    };
    if !send_raw(sink, &challenge).await {
        return false;
    }

    let mut invalid = 0usize;
    let resp = loop {
        match stream.next().await {
            Some(Ok(Message::Text(t))) => match serde_json::from_str::<AuthMsg>(t.as_str()) {
                Ok(m) => break m,
                Err(_) => {
                    invalid += 1;
                    if invalid > MAX_INVALID_AUTH_FRAMES {
                        tracing::warn!(invalid, "too many invalid authentication frames");
                        let _ = send_raw(sink, &auth_error("too many invalid auth frames")).await;
                        return false;
                    }
                }
            },
            Some(Ok(Message::Close(_))) | None => return false,
            // A keystroke typed before the handshake completes cannot be applied
            // (there is no session yet), but dropping it silently made an entire
            // class of "missing characters" reports undiagnosable. It is still a
            // protocol violation at this stage, so it counts toward the cap.
            Some(Ok(Message::Binary(_))) => {
                tracing::warn!("discarding a data-plane frame sent before authentication");
                invalid += 1;
                if invalid > MAX_INVALID_AUTH_FRAMES {
                    let _ = send_raw(sink, &auth_error("too many invalid auth frames")).await;
                    return false;
                }
            }
            Some(Ok(_)) => continue,
            Some(Err(_)) => return false,
        }
    };

    let (client_nonce, mac) = match resp {
        AuthMsg::AuthResponse { client_nonce, mac } => (client_nonce, mac),
        _ => {
            let _ = send_raw(sink, &auth_error("expected auth_response")).await;
            return false;
        }
    };

    let ok = match (token, from_hex(&client_nonce), from_hex(&mac)) {
        (Some(token), Some(cn), Some(presented)) => {
            let expected = ws_mac(token.as_bytes(), &server_nonce, &cn, cert_fp);
            ct_eq(&expected, &presented)
        }
        _ => false,
    };

    if ok {
        send_raw(sink, &AuthMsg::AuthOk).await
    } else {
        let _ = send_raw(sink, &auth_error("authentication failed")).await;
        false
    }
}

/// Serialize and send one control message directly on the raw socket sink. Used
/// only by the pre-session auth handshake, which runs before the transport
/// bridge and `run_session` take over the socket.
async fn send_raw<T: serde::Serialize>(
    sink: &mut futures::stream::SplitSink<WebSocket, Message>,
    msg: &T,
) -> bool {
    match serde_json::to_string(msg) {
        Ok(json) => sink.send(Message::Text(json.into())).await.is_ok(),
        Err(e) => {
            tracing::error!(error=%e, "serialize server message failed");
            true
        }
    }
}

fn auth_error(message: &str) -> AuthMsg {
    AuthMsg::AuthError {
        message: message.to_string(),
    }
}

/// Read frames until a `Hello` arrives; returns (client_id, cursors, acks, history).
async fn read_hello(
    rx: &mut mpsc::Receiver<WsIn>,
) -> Option<(String, HashMap<String, u64>, bool, bool)> {
    while let Some(win) = rx.recv().await {
        match win {
            WsIn::Text(t) => {
                if let Ok(ClientMsg::Hello {
                    client_id,
                    cursors,
                    acks,
                    history,
                }) = serde_json::from_str::<ClientMsg>(&t)
                {
                    return Some((client_id, cursors, acks, history));
                }
            }
            WsIn::Close => return None,
            // Keystrokes cannot be applied before the session exists, but the
            // client gates its data plane on `authed` precisely so this stays
            // unreachable — if it fires, that gate has a hole.
            WsIn::Binary(_) => {
                tracing::warn!("discarding a data-plane frame sent before hello");
            }
        }
    }
    None
}

/// Per-session replay pacing. Only clients that declare `acks` in their Hello
/// are paced; older clients keep the previous dump-the-whole-backlog behaviour.
///
/// `acked` starts at the client's published cursors because seqs are absolute
/// and the window is measured from where the client actually is.
pub(crate) struct AckTracker {
    enabled: bool,
    acked: Mutex<HashMap<String, u64>>,
    notify: tokio::sync::Notify,
    closed: AtomicBool,
}

impl AckTracker {
    fn new(enabled: bool, cursors: &HashMap<String, u64>) -> Arc<Self> {
        Arc::new(Self {
            enabled,
            acked: Mutex::new(if enabled {
                cursors.clone()
            } else {
                HashMap::new()
            }),
            notify: tokio::sync::Notify::new(),
            closed: AtomicBool::new(false),
        })
    }

    /// Record the client's cumulative progress for a task.
    fn advance(&self, task_id: &str, seq: u64) {
        let advanced = {
            let mut acked = self.acked.lock().unwrap();
            let entry = acked.entry(task_id.to_string()).or_insert(0);
            if seq > *entry {
                *entry = seq;
                true
            } else {
                false
            }
        };
        if advanced {
            self.notify.notify_waiters();
        }
    }

    fn reset(&self, task_id: &str) {
        self.acked.lock().unwrap().insert(task_id.to_string(), 0);
    }

    /// The client is gone: fail the pending wait so the replay can unwind.
    fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.notify.notify_waiters();
    }

    /// Wait until sending `next_seq` stays within [`REPLAY_WINDOW`] frames of
    /// what the client has acknowledged. Returns `false` once the session ends.
    async fn wait_for_room(&self, task_id: &str, next_seq: u64) -> bool {
        if !self.enabled {
            return true;
        }
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.closed.load(Ordering::Relaxed) {
                return false;
            }
            let acked = self
                .acked
                .lock()
                .unwrap()
                .get(task_id)
                .copied()
                .unwrap_or(0);
            if next_seq.saturating_sub(acked) <= REPLAY_WINDOW {
                return true;
            }
            notified.await;
        }
    }

    async fn wait_for_ack(&self, task_id: &str, seq: u64) -> bool {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.closed.load(Ordering::Relaxed) {
                return false;
            }
            let acked = self
                .acked
                .lock()
                .unwrap()
                .get(task_id)
                .copied()
                .unwrap_or(0);
            if acked >= seq {
                return true;
            }
            notified.await;
        }
    }
}

const HISTORY_BATCH: u32 = 64;

struct HistoryWorkers {
    state: SharedState,
    client_id: String,
    tx: mpsc::Sender<WsOut>,
    tracker: Arc<AckTracker>,
    handles: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

impl HistoryWorkers {
    fn new(state: SharedState, client_id: String, tx: mpsc::Sender<WsOut>) -> Arc<Self> {
        Arc::new(Self {
            state,
            client_id,
            tx,
            tracker: AckTracker::new(true, &HashMap::new()),
            handles: Mutex::new(HashMap::new()),
        })
    }

    fn start(self: &Arc<Self>, task_id: String, through: u64) {
        self.cancel(&task_id);
        self.tracker.reset(&task_id);
        let workers = self.clone();
        let task = task_id.clone();
        let handle = tokio::spawn(async move {
            workers.run(task, through).await;
        });
        self.handles.lock().unwrap().insert(task_id, handle);
    }

    fn advance(&self, task_id: &str, seq: u64) {
        self.tracker.advance(task_id, seq);
    }

    fn cancel(&self, task_id: &str) {
        if let Some(handle) = self.handles.lock().unwrap().remove(task_id) {
            handle.abort();
        }
    }

    fn close(&self) {
        self.handles
            .lock()
            .unwrap()
            .drain()
            .for_each(|(_, handle)| handle.abort());
        self.tracker.close();
    }

    async fn run(self: Arc<Self>, task_id: String, through: u64) {
        let mut after = 0;
        while after < through {
            let chunks = match self
                .state
                .tasks
                .chunks_window(&task_id, after, through, HISTORY_BATCH)
                .await
            {
                Ok(chunks) => chunks,
                Err(error) => {
                    self.fail(&task_id, error.to_string()).await;
                    return;
                }
            };
            if chunks.is_empty() {
                self.fail(&task_id, format!("missing chunk after {after}"))
                    .await;
                return;
            }
            for (seq, data) in chunks {
                if seq != after + 1 {
                    self.fail(
                        &task_id,
                        format!("non-contiguous chunk {seq} after {after}"),
                    )
                    .await;
                    return;
                }
                if !self.tracker.wait_for_room(&task_id, seq).await {
                    return;
                }
                let uuid = match Uuid::parse_str(&task_id) {
                    Ok(uuid) => uuid,
                    Err(_) => return,
                };
                let frame = Frame::History {
                    task_id: uuid,
                    seq,
                    data,
                };
                if self.tx.send(WsOut::Binary(frame.encode())).await.is_err() {
                    return;
                }
                after = seq;
            }
        }
        if !self.tracker.wait_for_ack(&task_id, through).await {
            return;
        }
        let done = ServerMsg::HistoryDone {
            task_id: task_id.clone(),
            last_seq: through,
        };
        if let Ok(json) = serde_json::to_string(&done) {
            let _ = self.tx.send(WsOut::Text(json)).await;
        }
        tracing::info!(client_id = %self.client_id, %task_id, last_seq = through, "history replay complete");
    }

    async fn fail(&self, task_id: &str, message: String) {
        tracing::warn!(client_id = %self.client_id, %task_id, %message, "history replay failed");
        let error = ServerMsg::Error {
            task_id: Some(task_id.to_string()),
            code: Some("history_failed".into()),
            message,
        };
        if let Ok(json) = serde_json::to_string(&error) {
            let _ = self.tx.send(WsOut::Text(json)).await;
        }
    }
}

#[derive(Clone, Copy)]
struct ReplayContext<'a> {
    out: &'a mpsc::Sender<WsOut>,
    state: &'a SharedState,
    client_id: &'a str,
    tracker: &'a AckTracker,
    history_enabled: bool,
    history_workers: &'a Arc<HistoryWorkers>,
}

/// Reconstruct every task's terminal for a (re)connecting client, then send a
/// `ReplayDone`. Live buffers are byte fast-forwarded to preserve scrollback;
/// large initial or legacy-client backlogs collapse to a screen SNAPSHOT. Either
/// path leaves `last_sent` at the highest seq the client now holds, so live dedup is
/// exact. Advances the durable server-side cursor to the client's position.
async fn replay(
    ctx: ReplayContext<'_>,
    reason: &'static str,
    cursors: &HashMap<String, u64>,
    last_sent: &mut HashMap<String, u64>,
) -> bool {
    let ReplayContext {
        out,
        state,
        client_id,
        tracker,
        history_enabled,
        history_workers,
    } = ctx;
    let tasks = match state.tasks.list().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error=%e, "replay: list tasks failed");
            return true; // keep the connection; live stream may still work
        }
    };
    // How much backlog this reconnect asked for. A large number here is what
    // fills the repeater's per-stream queue and resets the stream; logging it at
    // the start means a flapping client is explainable even when the replay is
    // cut short before it completes.
    let backlog_chunks: u64 = tasks
        .iter()
        .map(|t| {
            let after = cursors.get(&t.id).copied().unwrap_or(0);
            t.last_seq.saturating_sub(after)
        })
        .sum();
    tracing::info!(
        %client_id,
        reason,
        tasks = tasks.len(),
        backlog_chunks,
        "replaying backlog"
    );
    let mut sent_frames = 0u64;
    let mut sent_bytes = 0u64;
    for task in &tasks {
        let after = cursors.get(&task.id).copied().unwrap_or(0);
        let _ = state.store.set_cursor(client_id, &task.id, after).await;
        let tail = task.last_seq;
        let uuid = match Uuid::parse_str(&task.id) {
            Ok(u) => u,
            Err(_) => continue,
        };
        last_sent.insert(task.id.clone(), after);

        let gap = tail.saturating_sub(after);
        // A non-zero cursor belongs to this page's live xterm buffer. Paced
        // clients can replay any gap without risking queues or losing scrollback.
        let preserve_scrollback = after > 0 && tracker.enabled;
        let snapshot = (gap > SNAPSHOT_THRESHOLD && !preserve_scrollback)
            .then(|| state.tasks.snapshot(&task.id))
            .flatten();

        let mut replay_tail = tail;
        if let Some((snapshot_seq, screen)) = snapshot {
            replay_tail = snapshot_seq;
            let frame = Frame::Snapshot {
                task_id: uuid,
                seq: snapshot_seq,
                data: screen,
            };
            let encoded = frame.encode();
            sent_frames += 1;
            sent_bytes += encoded.len() as u64;
            if !send_binary(out, encoded).await {
                return false;
            }
            last_sent.insert(task.id.clone(), snapshot_seq);
            if after == 0 && tracker.enabled && history_enabled {
                let start = ServerMsg::HistoryStart {
                    task_id: task.id.clone(),
                    last_seq: snapshot_seq,
                };
                if !send_control(out, &start).await {
                    return false;
                }
                history_workers.start(task.id.clone(), snapshot_seq);
            }
        } else if let Ok(chunks) = state.tasks.chunks_after(&task.id, after).await {
            for (seq, data) in chunks {
                // Pace the byte replay to what the client has applied: an
                // unbounded history must not outrun the repeater's stream
                // queue (which would reset this very stream).
                if !tracker.wait_for_room(&task.id, seq).await {
                    return false;
                }
                let frame = Frame::Output {
                    task_id: uuid,
                    seq,
                    data,
                };
                let encoded = frame.encode();
                sent_frames += 1;
                sent_bytes += encoded.len() as u64;
                if !send_binary(out, encoded).await {
                    return false;
                }
                last_sent.insert(task.id.clone(), seq);
            }
        }

        let done = ServerMsg::ReplayDone {
            task_id: task.id.clone(),
            last_seq: replay_tail,
        };
        if !send_control(out, &done).await {
            return false;
        }
    }
    tracing::info!(
        %client_id,
        reason,
        frames = sent_frames,
        bytes = sent_bytes,
        "replay complete"
    );
    true
}

async fn handle_client_msg(
    msg: ClientMsg,
    state: &SharedState,
    client_id: &str,
    direct_tx: &mpsc::UnboundedSender<ServerMsg>,
) {
    match msg {
        // Hello is consumed by the handshake and Ping is answered by the
        // transport dispatcher (so a long replay cannot starve the heartbeat).
        ClientMsg::Hello { .. }
        | ClientMsg::Ping { .. }
        | ClientMsg::HistoryAck { .. }
        | ClientMsg::HistoryCancel { .. } => {}
        ClientMsg::Ack { task_id, seq } => {
            if let Err(e) = state.store.set_cursor(client_id, &task_id, seq).await {
                tracing::warn!(%client_id, %task_id, error=%e, "ack failed");
            }
        }
        ClientMsg::Resize {
            task_id,
            cols,
            rows,
        } => {
            if let Err(e) = state.tasks.resize(&task_id, cols, rows) {
                tracing::warn!(%client_id, %task_id, error=%e, "resize failed");
            }
        }
        ClientMsg::CreateTask {
            tool,
            title,
            cwd,
            cols,
            rows,
        } => {
            if let Err(e) = state
                .tasks
                .create(CreateParams {
                    tool,
                    title,
                    cwd,
                    cols,
                    rows,
                })
                .await
            {
                let _ = direct_tx.send(ServerMsg::Error {
                    task_id: None,
                    code: Some("create_failed".into()),
                    message: e.to_string(),
                });
            }
        }
        ClientMsg::TerminateTask { task_id } => {
            if let Err(e) = state.tasks.terminate(&task_id).await {
                let _ = direct_tx.send(ServerMsg::Error {
                    task_id: Some(task_id),
                    code: Some("terminate_failed".into()),
                    message: e.to_string(),
                });
            }
        }
        ClientMsg::DeleteTask { task_id } => {
            if let Err(e) = state.tasks.delete(&task_id).await {
                let _ = direct_tx.send(ServerMsg::Error {
                    task_id: Some(task_id),
                    code: Some("delete_failed".into()),
                    message: e.to_string(),
                });
            }
        }
    }
}

/// Queue a control message on the unified outbound channel. A send error means
/// the transport bridge exited (socket gone) — the session's disconnect signal.
async fn send_control<T: serde::Serialize>(out: &mpsc::Sender<WsOut>, msg: &T) -> bool {
    match serde_json::to_string(msg) {
        Ok(json) => out.send(WsOut::Text(json)).await.is_ok(),
        Err(e) => {
            tracing::error!(error=%e, "serialize server message failed");
            true
        }
    }
}

/// Queue a binary data-plane frame on the unified outbound channel.
async fn send_binary(out: &mpsc::Sender<WsOut>, bytes: Vec<u8>) -> bool {
    out.send(WsOut::Binary(bytes)).await.is_ok()
}
