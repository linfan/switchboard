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

/// Buffer for the unified outbound writer. Bounded so a slow client applies
/// backpressure to the session instead of growing memory without limit.
const OUT_BUF: usize = 512;
/// Buffer for inbound frames handed from the transport bridge to the session.
const IN_BUF: usize = 64;

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

    // Inbound bridge: axum stream -> WsIn. A closed/errored socket ends the
    // stream; forward a final Close so the session's reader loop terminates.
    tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let win = match msg {
                Message::Text(t) => WsIn::Text(t.to_string()),
                Message::Binary(b) => WsIn::Binary(b.to_vec()),
                Message::Close(_) => break,
                _ => continue,
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
        while let Some(out) = out_rx.recv().await {
            let msg = match out {
                WsOut::Text(t) => Message::Text(t.into()),
                WsOut::Binary(b) => Message::Binary(b.into()),
            };
            if sink.send(msg).await.is_err() {
                return;
            }
        }
    });

    run_session(in_rx, out_tx, state).await;
}

/// The transport-neutral session: Hello handshake, Welcome, per-task
/// reconstruction, then the live output loop. Speaks only `WsIn`/`WsOut`
/// channels, so it is identical for a directly-connected client and for a client
/// forwarded through the repeater tunnel.
pub async fn run_session(
    mut rx: mpsc::Receiver<WsIn>,
    out_tx: mpsc::Sender<WsOut>,
    state: SharedState,
) {
    // 1. Handshake: the first frame must be Hello.
    let (client_id, cursors) = match read_hello(&mut rx).await {
        Some(h) => h,
        None => return,
    };
    tracing::info!(%client_id, "client connected");

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
        tokio::spawn(async move {
            while let Some(win) = rx.recv().await {
                match win {
                    WsIn::Text(t) => match serde_json::from_str::<ClientMsg>(&t) {
                        Ok(cm) => {
                            if ctl_tx.send(cm).is_err() {
                                break;
                            }
                        }
                        Err(e) => tracing::warn!(%client_id, error=%e, "bad client message"),
                    },
                    WsIn::Binary(b) => match Frame::decode(&b) {
                        Ok(Frame::Input { task_id, data }) => {
                            if let Err(e) = state.tasks.send_input(&task_id.to_string(), &data) {
                                tracing::warn!(%client_id, %task_id, error=%e, "input dropped");
                            }
                        }
                        Ok(_) => tracing::warn!(%client_id, "unexpected server-bound binary frame"),
                        Err(e) => tracing::warn!(%client_id, error=%e, "bad binary frame"),
                    },
                    WsIn::Close => break,
                }
            }
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
        return;
    }
    let mut last_sent: HashMap<String, u64> = HashMap::new();
    if !replay(&out_tx, &state, &client_id, &cursors, &mut last_sent).await {
        return;
    }

    // 5. Live loop.
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            Some(m) = direct_rx.recv() => {
                if !send_control(&out_tx, &m).await { break; }
            }
            r = broadcast_rx.recv() => match r {
                Ok(Outbound::Control(m)) => {
                    if !send_control(&out_tx, &m).await { break; }
                }
                Ok(Outbound::Pty { task_id, seq, bytes }) => {
                    if last_sent.get(&task_id).is_some_and(|&s| seq <= s) {
                        continue; // already delivered via replay/snapshot
                    }
                    last_sent.insert(task_id.clone(), seq);
                    if let Ok(uuid) = Uuid::parse_str(&task_id) {
                        let frame = Frame::Output { task_id: uuid, seq, data: bytes.to_vec() };
                        if !send_binary(&out_tx, frame.encode()).await { break; }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%client_id, skipped = n, "broadcast lagged; resyncing from store");
                    let from = last_sent.clone();
                    if !replay(&out_tx, &state, &client_id, &from, &mut last_sent).await { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
    tracing::info!(%client_id, "client disconnected");
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
    let server_nonce = random_nonce::<NONCE_LEN>();
    let challenge = AuthMsg::AuthChallenge {
        server_nonce: hex(&server_nonce),
    };
    if !send_raw(sink, &challenge).await {
        return false;
    }

    let resp = loop {
        match stream.next().await {
            Some(Ok(Message::Text(t))) => match serde_json::from_str::<AuthMsg>(t.as_str()) {
                Ok(m) => break m,
                Err(_) => continue,
            },
            Some(Ok(Message::Close(_))) | None => return false,
            // A keystroke typed before the handshake completes cannot be applied
            // (there is no session yet), but dropping it silently made an entire
            // class of "missing characters" reports undiagnosable.
            Some(Ok(Message::Binary(_))) => {
                tracing::warn!("discarding a data-plane frame sent before authentication");
                continue;
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

/// Read frames until a `Hello` arrives; returns (client_id, cursors).
async fn read_hello(
    rx: &mut mpsc::Receiver<WsIn>,
) -> Option<(String, HashMap<String, u64>)> {
    while let Some(win) = rx.recv().await {
        match win {
            WsIn::Text(t) => {
                if let Ok(ClientMsg::Hello { client_id, cursors }) =
                    serde_json::from_str::<ClientMsg>(&t)
                {
                    return Some((client_id, cursors));
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

/// Reconstruct every task's terminal for a (re)connecting client, then send a
/// `ReplayDone`. Large backlogs are collapsed to a screen SNAPSHOT; small ones
/// are byte fast-forwarded so scrollback continuity is preserved. Either path
/// leaves `last_sent` at the highest seq the client now holds, so live dedup is
/// exact. Advances the durable server-side cursor to the client's position.
async fn replay(
    out: &mpsc::Sender<WsOut>,
    state: &SharedState,
    client_id: &str,
    cursors: &HashMap<String, u64>,
    last_sent: &mut HashMap<String, u64>,
) -> bool {
    let tasks = match state.tasks.list().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error=%e, "replay: list tasks failed");
            return true; // keep the connection; live stream may still work
        }
    };
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
        let snapshot = (gap > SNAPSHOT_THRESHOLD)
            .then(|| state.tasks.snapshot(&task.id))
            .flatten();

        if let Some(screen) = snapshot {
            let frame = Frame::Snapshot {
                task_id: uuid,
                seq: tail,
                data: screen,
            };
            if !send_binary(out, frame.encode()).await {
                return false;
            }
            last_sent.insert(task.id.clone(), tail);
        } else if let Ok(chunks) = state.tasks.chunks_after(&task.id, after).await {
            for (seq, data) in chunks {
                let frame = Frame::Output {
                    task_id: uuid,
                    seq,
                    data,
                };
                if !send_binary(out, frame.encode()).await {
                    return false;
                }
                last_sent.insert(task.id.clone(), seq);
            }
        }

        let done = ServerMsg::ReplayDone {
            task_id: task.id.clone(),
            last_seq: tail,
        };
        if !send_control(out, &done).await {
            return false;
        }
    }
    true
}

async fn handle_client_msg(
    msg: ClientMsg,
    state: &SharedState,
    client_id: &str,
    direct_tx: &mpsc::UnboundedSender<ServerMsg>,
) {
    match msg {
        ClientMsg::Hello { .. } => {} // already handshaked
        ClientMsg::Ping { ts } => {
            let _ = direct_tx.send(ServerMsg::Pong { ts });
        }
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
