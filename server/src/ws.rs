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

/// Axum handler: upgrade, then run the channel-bound auth handshake before any
/// application traffic (no credential is carried in the URL).
pub async fn ws_handler(
    State(state): State<SharedState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();

    // 0. SWB-WS-v1 channel-bound challenge-response. Token is never sent.
    if !ws_handshake(&mut sink, &mut stream, &state).await {
        return;
    }

    // 1. Handshake: the first frame must be Hello.
    let (client_id, cursors) = match read_hello(&mut stream).await {
        Some(h) => h,
        None => return,
    };
    tracing::info!(%client_id, "client connected");

    // 2. Subscribe BEFORE replay so output produced during replay isn't missed.
    let mut broadcast_rx = state.tasks.subscribe();
    let (direct_tx, mut direct_rx) = mpsc::unbounded_channel::<ServerMsg>();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    // 3. Reader task: handle inbound client messages until the socket closes.
    {
        let state = state.clone();
        let client_id = client_id.clone();
        let direct_tx = direct_tx.clone();
        tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                match msg {
                    Message::Text(t) => match serde_json::from_str::<ClientMsg>(t.as_str()) {
                        Ok(cm) => handle_client_msg(cm, &state, &client_id, &direct_tx).await,
                        Err(e) => tracing::warn!(%client_id, error=%e, "bad client message"),
                    },
                    Message::Binary(b) => match Frame::decode(&b) {
                        Ok(Frame::Input { task_id, data }) => {
                            if let Err(e) = state.tasks.send_input(&task_id.to_string(), &data) {
                                tracing::warn!(%client_id, %task_id, error=%e, "input dropped");
                            }
                        }
                        Ok(_) => tracing::warn!(%client_id, "unexpected server-bound binary frame"),
                        Err(e) => tracing::warn!(%client_id, error=%e, "bad binary frame"),
                    },
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            let _ = shutdown_tx.send(());
        });
    }

    // 4. Welcome + per-task reconstruction.
    let welcome = ServerMsg::Welcome {
        service: state.service_info(),
        tasks: state.tasks.list().await.unwrap_or_default(),
    };
    if !send_control(&mut sink, &welcome).await {
        return;
    }
    let mut last_sent: HashMap<String, u64> = HashMap::new();
    if !replay(&mut sink, &state, &client_id, &cursors, &mut last_sent).await {
        return;
    }

    // 5. Live loop.
    loop {
        tokio::select! {
            _ = &mut shutdown_rx => break,
            Some(m) = direct_rx.recv() => {
                if !send_control(&mut sink, &m).await { break; }
            }
            r = broadcast_rx.recv() => match r {
                Ok(Outbound::Control(m)) => {
                    if !send_control(&mut sink, &m).await { break; }
                }
                Ok(Outbound::Pty { task_id, seq, bytes }) => {
                    if last_sent.get(&task_id).is_some_and(|&s| seq <= s) {
                        continue; // already delivered via replay/snapshot
                    }
                    last_sent.insert(task_id.clone(), seq);
                    if let Ok(uuid) = Uuid::parse_str(&task_id) {
                        let frame = Frame::Output { task_id: uuid, seq, data: bytes.to_vec() };
                        if !send_binary(&mut sink, frame.encode()).await { break; }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%client_id, skipped = n, "broadcast lagged; resyncing from store");
                    let from = last_sent.clone();
                    if !replay(&mut sink, &state, &client_id, &from, &mut last_sent).await { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
    tracing::info!(%client_id, "client disconnected");
}

/// Run the `SWB-WS-v1` handshake: send a random challenge, read the client's
/// channel-bound MAC, and verify it against our token + cert fingerprint. Returns
/// `true` on success (the connection may proceed to `Hello`).
async fn ws_handshake(
    sink: &mut futures::stream::SplitSink<WebSocket, Message>,
    stream: &mut futures::stream::SplitStream<WebSocket>,
    state: &SharedState,
) -> bool {
    let server_nonce = random_nonce::<NONCE_LEN>();
    let challenge = AuthMsg::AuthChallenge {
        server_nonce: hex(&server_nonce),
    };
    if !send_control(sink, &challenge).await {
        return false;
    }

    let resp = loop {
        match stream.next().await {
            Some(Ok(Message::Text(t))) => match serde_json::from_str::<AuthMsg>(t.as_str()) {
                Ok(m) => break m,
                Err(_) => continue,
            },
            Some(Ok(Message::Close(_))) | None => return false,
            Some(Ok(_)) => continue,
            Some(Err(_)) => return false,
        }
    };

    let (client_nonce, mac) = match resp {
        AuthMsg::AuthResponse { client_nonce, mac } => (client_nonce, mac),
        _ => {
            let _ = send_control(sink, &auth_error("expected auth_response")).await;
            return false;
        }
    };

    let ok = match (from_hex(&client_nonce), from_hex(&mac)) {
        (Some(cn), Some(presented)) => {
            let expected = ws_mac(
                state.config.token.as_bytes(),
                &server_nonce,
                &cn,
                &state.cert_fp,
            );
            ct_eq(&expected, &presented)
        }
        _ => false,
    };

    if ok {
        send_control(sink, &AuthMsg::AuthOk).await
    } else {
        let _ = send_control(sink, &auth_error("authentication failed")).await;
        false
    }
}

fn auth_error(message: &str) -> AuthMsg {
    AuthMsg::AuthError {
        message: message.to_string(),
    }
}

/// Read frames until a `Hello` arrives; returns (client_id, cursors).
async fn read_hello(
    stream: &mut futures::stream::SplitStream<WebSocket>,
) -> Option<(String, HashMap<String, u64>)> {
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                if let Ok(ClientMsg::Hello { client_id, cursors }) =
                    serde_json::from_str::<ClientMsg>(t.as_str())
                {
                    return Some((client_id, cursors));
                }
            }
            Message::Close(_) => return None,
            _ => {}
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
    sink: &mut futures::stream::SplitSink<WebSocket, Message>,
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
            if !send_binary(sink, frame.encode()).await {
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
                if !send_binary(sink, frame.encode()).await {
                    return false;
                }
                last_sent.insert(task.id.clone(), seq);
            }
        }

        let done = ServerMsg::ReplayDone {
            task_id: task.id.clone(),
            last_seq: tail,
        };
        if !send_control(sink, &done).await {
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

async fn send_control<T: serde::Serialize>(
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

async fn send_binary(
    sink: &mut futures::stream::SplitSink<WebSocket, Message>,
    bytes: Vec<u8>,
) -> bool {
    sink.send(Message::Binary(bytes.into())).await.is_ok()
}
