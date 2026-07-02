//! WebSocket endpoint: the persistent, real-time sync channel.
//!
//! Flow: client connects with `?token=`, sends `Hello{client_id, cursors}`; the
//! server replies `Welcome`, replays every persisted message with `seq > cursor`
//! per task (gap-free), then streams live events from the broadcast bus. A
//! writer loop owns the socket sink and multiplexes replay, live broadcast, and
//! point-to-point replies (Pong/Error); a reader task handles inbound frames.

use std::collections::HashMap;

use agent_manage_shared::{ClientMsg, ServerMsg};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::{mpsc, oneshot};

use crate::{auth, state::SharedState, task::CreateParams};

#[derive(Deserialize)]
pub struct WsQuery {
    token: String,
}

/// Axum handler: authenticate via query token, then upgrade.
pub async fn ws_handler(
    State(state): State<SharedState>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !auth::token_valid(&state, &q.token) {
        return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();

    // 1. Handshake: the first frame must be Hello.
    let (client_id, cursors) = match read_hello(&mut stream).await {
        Some(h) => h,
        None => return,
    };
    tracing::info!(%client_id, "client connected");

    // 2. Subscribe BEFORE replay so events produced during replay aren't missed.
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
                    Message::Text(t) => {
                        match serde_json::from_str::<ClientMsg>(t.as_str()) {
                            Ok(cm) => handle_client_msg(cm, &state, &client_id, &direct_tx).await,
                            Err(e) => tracing::warn!(%client_id, error=%e, "bad client message"),
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            let _ = shutdown_tx.send(());
        });
    }

    // 4. Welcome + replay.
    let welcome = ServerMsg::Welcome {
        service: state.service_info(),
        tasks: state.tasks.list().await.unwrap_or_default(),
    };
    if !send(&mut sink, &welcome).await {
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
                if !send(&mut sink, &m).await { break; }
            }
            r = broadcast_rx.recv() => match r {
                Ok(m) => {
                    if let ServerMsg::Message { task_id, seq, .. } = &m {
                        last_sent.insert(task_id.clone(), *seq);
                    }
                    if !send(&mut sink, &m).await { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%client_id, skipped = n, "broadcast lagged; resyncing from store");
                    let from: HashMap<String, u64> = last_sent.clone();
                    if !replay(&mut sink, &state, &client_id, &from, &mut last_sent).await { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    }
    tracing::info!(%client_id, "client disconnected");
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

/// Replay, for every current task, all persisted messages with `seq` greater
/// than the client's cursor (or `last_sent` on a lag-resync), followed by a
/// `ReplayDone`. Advances the durable server-side cursor to the client's
/// position.
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
        if let Ok(msgs) = state.store.messages_after(&task.id, after).await {
            for (seq, event) in msgs {
                last_sent.insert(task.id.clone(), seq);
                let m = ServerMsg::Message {
                    task_id: task.id.clone(),
                    seq,
                    event,
                };
                if !send(sink, &m).await {
                    return false;
                }
            }
        }
        let done = ServerMsg::ReplayDone {
            task_id: task.id.clone(),
            last_seq: task.last_seq,
        };
        if !send(sink, &done).await {
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
        ClientMsg::UserInput { task_id, text } => {
            if let Err(e) = state.tasks.send_input(&task_id, &text).await {
                let _ = direct_tx.send(ServerMsg::Error {
                    task_id: Some(task_id),
                    code: Some("input_failed".into()),
                    message: e.to_string(),
                });
            }
        }
        ClientMsg::CreateTask {
            tool,
            title,
            cwd,
            initial_prompt,
        } => {
            if let Err(e) = state
                .tasks
                .create(CreateParams {
                    tool,
                    title,
                    cwd,
                    initial_prompt,
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
    }
}

async fn send(sink: &mut futures::stream::SplitSink<WebSocket, Message>, msg: &ServerMsg) -> bool {
    match serde_json::to_string(msg) {
        Ok(json) => sink.send(Message::Text(json.into())).await.is_ok(),
        Err(e) => {
            tracing::error!(error=%e, "serialize server message failed");
            true
        }
    }
}
