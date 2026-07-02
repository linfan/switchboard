//! Integration tests for the WebSocket sync layer: handshake, replay windows,
//! live streaming, and gap-free reconnect after a disconnect. Uses a real TCP
//! server + a real WS client, but injects events directly (no live agent).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use agent_manage_shared::{now_millis, AgentEvent, ClientMsg, ServerMsg, TaskInfo, TaskStatus};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::{config::Config, state::AppState, store::Store, task::TaskManager};

const TOKEN: &str = "test-token";

async fn start_server() -> (SocketAddr, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    // Keep the tempdir alive for the whole process.
    std::mem::forget(dir);

    let store = Store::connect(db.to_str().unwrap()).await.unwrap();
    let tasks = TaskManager::new(store.clone(), "default".into());
    let state = Arc::new(AppState {
        config: Config {
            addr: "127.0.0.1:0".into(),
            token: TOKEN.into(),
            db_path: db.to_string_lossy().into(),
            service_name: "test-host".into(),
            agent_permission_mode: "default".into(),
        },
        store,
        tasks,
    });

    let app = crate::http::router(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (addr, state)
}

fn ev(text: &str) -> AgentEvent {
    AgentEvent {
        kind: "assistant".into(),
        text: Some(text.into()),
        raw: serde_json::json!({ "text": text }),
    }
}

fn seed_task(id: &str) -> TaskInfo {
    TaskInfo {
        id: id.into(),
        tool: "claude".into(),
        title: "seed".into(),
        status: TaskStatus::Running,
        created_at: now_millis(),
        last_seq: 0,
    }
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(addr: SocketAddr) -> WsStream {
    let url = format!("ws://{addr}/ws?token={TOKEN}");
    let (ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws
}

async fn send(ws: &mut WsStream, msg: &ClientMsg) {
    ws.send(WsMessage::Text(serde_json::to_string(msg).unwrap().into()))
        .await
        .unwrap();
}

/// Read `ServerMsg`s until we've seen a `ReplayDone` (for the given task),
/// returning everything collected (including the ReplayDone).
async fn read_through_replay(ws: &mut WsStream, task_id: &str) -> Vec<ServerMsg> {
    let mut out = Vec::new();
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for replay")
            .expect("stream ended")
            .expect("ws error");
        if let WsMessage::Text(t) = frame {
            let msg: ServerMsg = serde_json::from_str(t.as_str()).unwrap();
            let done = matches!(&msg, ServerMsg::ReplayDone { task_id: t, .. } if t == task_id);
            out.push(msg);
            if done {
                break;
            }
        }
    }
    out
}

/// Read the next N `Message` events (skipping other frame types).
async fn read_messages(ws: &mut WsStream, n: usize) -> Vec<(u64, String)> {
    let mut out = Vec::new();
    while out.len() < n {
        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for message")
            .expect("stream ended")
            .expect("ws error");
        if let WsMessage::Text(t) = frame {
            if let ServerMsg::Message { seq, event, .. } =
                serde_json::from_str::<ServerMsg>(t.as_str()).unwrap()
            {
                out.push((seq, event.text.unwrap_or_default()));
            }
        }
    }
    out
}

fn message_seqs(msgs: &[ServerMsg]) -> Vec<u64> {
    msgs.iter()
        .filter_map(|m| match m {
            ServerMsg::Message { seq, .. } => Some(*seq),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn welcome_and_full_replay() {
    let (addr, state) = start_server().await;
    state.store.create_task(&seed_task("t1")).await.unwrap();
    for t in ["a", "b", "c"] {
        state.tasks.inject_event("t1", ev(t)).await.unwrap();
    }

    let mut ws = connect(addr).await;
    send(
        &mut ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors: Default::default(),
        },
    )
    .await;

    let msgs = read_through_replay(&mut ws, "t1").await;
    assert!(matches!(msgs.first(), Some(ServerMsg::Welcome { .. })));
    assert_eq!(message_seqs(&msgs), vec![1, 2, 3]);
}

#[tokio::test]
async fn replay_respects_client_cursor() {
    let (addr, state) = start_server().await;
    state.store.create_task(&seed_task("t1")).await.unwrap();
    for t in ["a", "b", "c", "d"] {
        state.tasks.inject_event("t1", ev(t)).await.unwrap();
    }

    let mut ws = connect(addr).await;
    let mut cursors = std::collections::HashMap::new();
    cursors.insert("t1".to_string(), 2u64);
    send(
        &mut ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors,
        },
    )
    .await;

    let msgs = read_through_replay(&mut ws, "t1").await;
    // Cursor at 2 => only seq 3 and 4 replayed, gap-free, nothing <= 2.
    assert_eq!(message_seqs(&msgs), vec![3, 4]);
}

#[tokio::test]
async fn live_streaming_after_replay() {
    let (addr, state) = start_server().await;
    state.store.create_task(&seed_task("t1")).await.unwrap();
    state.tasks.inject_event("t1", ev("a")).await.unwrap();

    let mut ws = connect(addr).await;
    send(
        &mut ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors: Default::default(),
        },
    )
    .await;
    let replayed = read_through_replay(&mut ws, "t1").await;
    assert_eq!(message_seqs(&replayed), vec![1]);

    // Now produce live events; the connected client must receive them.
    state.tasks.inject_event("t1", ev("b")).await.unwrap();
    state.tasks.inject_event("t1", ev("c")).await.unwrap();
    let live = read_messages(&mut ws, 2).await;
    assert_eq!(live, vec![(2, "b".into()), (3, "c".into())]);
}

#[tokio::test]
async fn reconnect_replays_only_missed_messages() {
    let (addr, state) = start_server().await;
    state.store.create_task(&seed_task("t1")).await.unwrap();
    for t in ["a", "b", "c"] {
        state.tasks.inject_event("t1", ev(t)).await.unwrap();
    }

    // First connection consumes seq 1..3.
    let mut ws = connect(addr).await;
    send(
        &mut ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors: Default::default(),
        },
    )
    .await;
    let first = read_through_replay(&mut ws, "t1").await;
    assert_eq!(message_seqs(&first), vec![1, 2, 3]);

    // Client durably applied up to seq 3; drop the socket (simulate a drop).
    drop(ws);

    // While disconnected, more events are produced.
    state.tasks.inject_event("t1", ev("d")).await.unwrap();
    state.tasks.inject_event("t1", ev("e")).await.unwrap();

    // Reconnect with cursor at 3 => must receive exactly seq 4 and 5, gap-free.
    let mut ws2 = connect(addr).await;
    let mut cursors = std::collections::HashMap::new();
    cursors.insert("t1".to_string(), 3u64);
    send(
        &mut ws2,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors,
        },
    )
    .await;
    let second = read_through_replay(&mut ws2, "t1").await;
    assert_eq!(
        message_seqs(&second),
        vec![4, 5],
        "reconnect must replay only messages missed while disconnected"
    );
}

#[tokio::test]
async fn ping_pong_roundtrip() {
    let (addr, _state) = start_server().await;
    let mut ws = connect(addr).await;
    send(
        &mut ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors: Default::default(),
        },
    )
    .await;
    // Drain the Welcome frame.
    let _ = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;

    send(&mut ws, &ClientMsg::Ping { ts: 12345 }).await;
    let mut got_pong = false;
    for _ in 0..10 {
        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let WsMessage::Text(t) = frame {
            if let ServerMsg::Pong { ts } = serde_json::from_str(t.as_str()).unwrap() {
                assert_eq!(ts, 12345);
                got_pong = true;
                break;
            }
        }
    }
    assert!(got_pong, "expected a Pong echoing our ts");
}
