//! Integration tests for the WebSocket sync layer: handshake, byte replay
//! windows, snapshot-on-large-backlog, live streaming, gap-free reconnect, and
//! multi-viewer convergence. Uses a real TCP server + a real WS client, but
//! injects chunks directly (no live PTY).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use switchboard_shared::{frame::Frame, now_millis, ClientMsg, ServerMsg, TaskInfo, TaskStatus};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::{config::Config, state::AppState, store::Store, task::TaskManager, terminal::TerminalEmulator};

const TOKEN: &str = "test-token";
// Two fixed v4-shaped UUIDs so the 16-byte frame headers parse.
const T1: &str = "11111111-1111-4111-8111-111111111111";

async fn start_server() -> (SocketAddr, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir); // keep the tempdir alive for the whole process

    let store = Store::connect(db.to_str().unwrap()).await.unwrap();
    let tasks = TaskManager::new(store.clone());
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

/// Seed a Running task row and register an authoritative screen for it.
async fn seed(state: &AppState, id: &str) {
    let info = TaskInfo {
        id: id.into(),
        tool: "claude".into(),
        title: "seed".into(),
        status: TaskStatus::Running,
        created_at: now_millis(),
        last_seq: 0,
    };
    state.store.create_task(&info).await.unwrap();
    state.tasks.register_terminal(id, 80, 24);
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

async fn hello(ws: &mut WsStream, cursors: HashMap<String, u64>) {
    send(
        ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors,
        },
    )
    .await;
}

/// A decoded incoming WS frame: JSON control or a binary data-plane frame.
enum Rx {
    Ctrl(ServerMsg),
    Bin(Frame),
}

async fn next_rx(ws: &mut WsStream) -> Rx {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out")
            .expect("stream ended")
            .expect("ws error");
        match frame {
            WsMessage::Text(t) => return Rx::Ctrl(serde_json::from_str(t.as_str()).unwrap()),
            WsMessage::Binary(b) => return Rx::Bin(Frame::decode(&b).unwrap()),
            _ => {}
        }
    }
}

/// Read frames until the task's `ReplayDone`; return the binary frames seen.
async fn read_through_replay(ws: &mut WsStream, task_id: &str) -> Vec<Frame> {
    let mut frames = Vec::new();
    loop {
        match next_rx(ws).await {
            Rx::Bin(f) => frames.push(f),
            Rx::Ctrl(ServerMsg::ReplayDone { task_id: t, .. }) if t == task_id => break,
            Rx::Ctrl(_) => {}
        }
    }
    frames
}

/// Collapse OUTPUT frames to (seq, data) pairs, ignoring snapshots.
fn outputs(frames: &[Frame]) -> Vec<(u64, Vec<u8>)> {
    frames
        .iter()
        .filter_map(|f| match f {
            Frame::Output { seq, data, .. } => Some((*seq, data.clone())),
            _ => None,
        })
        .collect()
}

async fn next_output(ws: &mut WsStream) -> (u64, Vec<u8>) {
    loop {
        if let Rx::Bin(Frame::Output { seq, data, .. }) = next_rx(ws).await {
            return (seq, data);
        }
    }
}

#[tokio::test]
async fn welcome_and_full_byte_replay() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    for b in [b"a".as_slice(), b"b", b"c"] {
        state.tasks.inject_chunk(T1, b).await.unwrap();
    }

    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::new()).await;

    let frames = read_through_replay(&mut ws, T1).await;
    assert_eq!(
        outputs(&frames),
        vec![(1, b"a".to_vec()), (2, b"b".to_vec()), (3, b"c".to_vec())]
    );
}

#[tokio::test]
async fn byte_replay_respects_client_cursor() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    for b in [b"a".as_slice(), b"b", b"c", b"d"] {
        state.tasks.inject_chunk(T1, b).await.unwrap();
    }

    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::from([(T1.to_string(), 2u64)])).await;

    let frames = read_through_replay(&mut ws, T1).await;
    // Cursor at 2 => only seq 3 and 4 fast-forwarded, gap-free.
    assert_eq!(outputs(&frames), vec![(3, b"c".to_vec()), (4, b"d".to_vec())]);
}

#[tokio::test]
async fn live_streaming_after_replay() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    state.tasks.inject_chunk(T1, b"a").await.unwrap();

    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::new()).await;
    let replayed = read_through_replay(&mut ws, T1).await;
    assert_eq!(outputs(&replayed), vec![(1, b"a".to_vec())]);

    // Live output must reach the connected client.
    state.tasks.inject_chunk(T1, b"b").await.unwrap();
    state.tasks.inject_chunk(T1, b"c").await.unwrap();
    assert_eq!(next_output(&mut ws).await, (2, b"b".to_vec()));
    assert_eq!(next_output(&mut ws).await, (3, b"c".to_vec()));
}

#[tokio::test]
async fn delete_task_removes_state_and_notifies_clients() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    state.tasks.inject_chunk(T1, b"a").await.unwrap();

    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::new()).await;
    read_through_replay(&mut ws, T1).await;

    send(&mut ws, &ClientMsg::DeleteTask { task_id: T1.into() }).await;

    // The connected client is told the task is gone.
    loop {
        if let Rx::Ctrl(ServerMsg::TaskDeleted { task_id }) = next_rx(&mut ws).await {
            assert_eq!(task_id, T1);
            break;
        }
    }

    // Durable state is gone, and a fresh connection's welcome no longer lists it.
    assert!(state.store.get_task(T1).await.unwrap().is_none());
    assert!(state.store.chunks_after(T1, 0).await.unwrap().is_empty());
    let mut ws2 = connect(addr).await;
    hello(&mut ws2, HashMap::new()).await;
    match next_rx(&mut ws2).await {
        Rx::Ctrl(ServerMsg::Welcome { tasks, .. }) => {
            assert!(tasks.iter().all(|t| t.id != T1));
        }
        other => panic!("expected welcome, got something else: {}", matches!(other, Rx::Bin(_))),
    }
}

#[tokio::test]
async fn reconnect_replays_only_missed_bytes() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    for b in [b"a".as_slice(), b"b", b"c"] {
        state.tasks.inject_chunk(T1, b).await.unwrap();
    }

    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::new()).await;
    assert_eq!(outputs(&read_through_replay(&mut ws, T1).await).len(), 3);
    drop(ws); // simulate a disconnect after applying seq 3

    state.tasks.inject_chunk(T1, b"d").await.unwrap();
    state.tasks.inject_chunk(T1, b"e").await.unwrap();

    let mut ws2 = connect(addr).await;
    hello(&mut ws2, HashMap::from([(T1.to_string(), 3u64)])).await;
    let second = read_through_replay(&mut ws2, T1).await;
    assert_eq!(
        outputs(&second),
        vec![(4, b"d".to_vec()), (5, b"e".to_vec())],
        "reconnect must replay only bytes missed while disconnected"
    );
}

#[tokio::test]
async fn large_backlog_uses_snapshot() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    // Exceed SNAPSHOT_THRESHOLD (256) so reconnect prefers a screen snapshot.
    for _ in 0..300 {
        state.tasks.inject_chunk(T1, b".").await.unwrap();
    }
    state
        .tasks
        .inject_chunk(T1, b"\x1b[2J\x1b[HFINAL")
        .await
        .unwrap();
    let tail = 301u64;

    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::new()).await;
    let frames = read_through_replay(&mut ws, T1).await;

    // One SNAPSHOT (at the tail seq), and no raw OUTPUT replay.
    assert!(outputs(&frames).is_empty(), "should not byte-replay a large backlog");
    let snap = frames
        .iter()
        .find_map(|f| match f {
            Frame::Snapshot { seq, data, .. } => Some((*seq, data.clone())),
            _ => None,
        })
        .expect("expected a snapshot frame");
    assert_eq!(snap.0, tail);

    // The snapshot must reconstruct the current screen.
    let mut replay = TerminalEmulator::new(80, 24);
    replay.process(&snap.1);
    assert!(replay.contents().contains("FINAL"), "snapshot must redraw the screen");
}

#[tokio::test]
async fn multi_viewer_convergence() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;

    let mut a = connect(addr).await;
    hello(&mut a, HashMap::new()).await;
    let _ = read_through_replay(&mut a, T1).await;
    let mut b = connect(addr).await;
    hello(&mut b, HashMap::new()).await;
    let _ = read_through_replay(&mut b, T1).await;

    state.tasks.inject_chunk(T1, b"shared").await.unwrap();
    assert_eq!(next_output(&mut a).await, (1, b"shared".to_vec()));
    assert_eq!(next_output(&mut b).await, (1, b"shared".to_vec()));
}

#[tokio::test]
async fn ping_pong_roundtrip() {
    let (addr, _state) = start_server().await;
    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::new()).await;
    // Drain the Welcome frame.
    let _ = tokio::time::timeout(Duration::from_secs(5), ws.next()).await;

    send(&mut ws, &ClientMsg::Ping { ts: 12345 }).await;
    let mut got_pong = false;
    for _ in 0..10 {
        if let Rx::Ctrl(ServerMsg::Pong { ts }) = next_rx(&mut ws).await {
            assert_eq!(ts, 12345);
            got_pong = true;
            break;
        }
    }
    assert!(got_pong, "expected a Pong echoing our ts");
}
