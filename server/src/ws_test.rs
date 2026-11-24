//! Integration tests for the WebSocket sync layer: handshake, byte replay
//! windows, snapshot-on-large-backlog, live streaming, gap-free reconnect, and
//! multi-viewer convergence. Uses a real TCP server + a real WS client, but
//! injects chunks directly (no live PTY).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use switchboard_shared::{
    auth::{from_hex, hex, random_nonce, ws_mac, AuthMsg, NONCE_LEN},
    frame::Frame,
    now_millis, ClientMsg, ServerMsg, TaskInfo, TaskStatus,
};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::{
    config::Config, state::AppState, store::Store, task::TaskManager, terminal::TerminalEmulator,
};

const TOKEN: &str = "test-token";
// Two fixed v4-shaped UUIDs so the 16-byte frame headers parse.
const T1: &str = "11111111-1111-4111-8111-111111111111";
const T2: &str = "22222222-2222-4222-8222-222222222222";

async fn build_state() -> Arc<AppState> {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("t.db");
    std::mem::forget(dir); // keep the tempdir alive for the whole process

    let store = Store::connect(db.to_str().unwrap()).await.unwrap();
    let tasks = TaskManager::new(store.clone(), db.to_str().unwrap());
    Arc::new(AppState {
        config: Config {
            role: crate::config::Role::WorkerDirect,
            addr: "127.0.0.1:0".into(),
            token: Some(TOKEN.into()),
            db_path: db.to_string_lossy().into(),
            service_name: "test-host".into(),
            agent_permission_mode: "default".into(),
            tls: None,
            repeater_addr: None,
            repeater_token: None,
            repeater_ca: None,
            tag: None,
            log_file: None,
        },
        store,
        tasks,
        cert_fp: Vec::new(),
        nonce_cache: Default::default(),
        tunnel_shutdown: Default::default(),
    })
}

async fn start_server() -> (SocketAddr, Arc<AppState>) {
    let state = build_state().await;
    let app = crate::http::router(state.clone(), true);
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
    let url = format!("ws://{addr}/ws");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    ws_auth(&mut ws).await;
    ws
}

/// Perform the `SWB-WS-v1` handshake. `cb` is empty here (the test server serves
/// plain HTTP, so `cert_fp` is empty).
async fn ws_auth(ws: &mut WsStream) {
    let server_nonce = loop {
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            if let Ok(AuthMsg::AuthChallenge { server_nonce }) =
                serde_json::from_str::<AuthMsg>(t.as_str())
            {
                break from_hex(&server_nonce).unwrap();
            }
        }
    };
    let client_nonce = random_nonce::<NONCE_LEN>();
    let mac = ws_mac(TOKEN.as_bytes(), &server_nonce, &client_nonce, &[]);
    let resp = AuthMsg::AuthResponse {
        client_nonce: hex(&client_nonce),
        mac: hex(&mac),
    };
    ws.send(WsMessage::Text(serde_json::to_string(&resp).unwrap()))
        .await
        .unwrap();
    loop {
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            match serde_json::from_str::<AuthMsg>(t.as_str()) {
                Ok(AuthMsg::AuthOk) => break,
                Ok(AuthMsg::AuthError { message }) => panic!("ws auth failed: {message}"),
                _ => {}
            }
        }
    }
}

async fn send(ws: &mut WsStream, msg: &ClientMsg) {
    ws.send(WsMessage::Text(serde_json::to_string(msg).unwrap()))
        .await
        .unwrap();
}

async fn hello(ws: &mut WsStream, cursors: HashMap<String, u64>) {
    send(
        ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors,
            acks: false,
            history: false,
            history_http: false,
        },
    )
    .await;
}

/// Hello from a client that will pace the replay with `Ack` frames.
async fn hello_paced(ws: &mut WsStream, cursors: HashMap<String, u64>) {
    send(
        ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors,
            acks: true,
            history: false,
            history_http: false,
        },
    )
    .await;
}

async fn hello_history_http(ws: &mut WsStream) {
    send(
        ws,
        &ClientMsg::Hello {
            client_id: "c1".into(),
            cursors: HashMap::new(),
            acks: true,
            history: false,
            history_http: true,
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

async fn read_paced_replay(ws: &mut WsStream, task_id: &str) -> Vec<Frame> {
    let mut frames = Vec::new();
    loop {
        match next_rx(ws).await {
            Rx::Bin(f) => {
                let seq = match &f {
                    Frame::Output { seq, .. } | Frame::Snapshot { seq, .. } => Some(*seq),
                    Frame::History { .. } | Frame::Input { .. } => None,
                };
                if let Some(seq) = seq {
                    send(
                        ws,
                        &ClientMsg::Ack {
                            task_id: task_id.into(),
                            seq,
                        },
                    )
                    .await;
                }
                frames.push(f);
            }
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
    assert_eq!(
        outputs(&frames),
        vec![(3, b"c".to_vec()), (4, b"d".to_vec())]
    );
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
        other => panic!(
            "expected welcome, got something else: {}",
            matches!(other, Rx::Bin(_))
        ),
    }
}

/// Deleting a task the server no longer has must still broadcast `TaskDeleted`
/// (not error out) so a client whose copy went stale — e.g. it missed the lossy
/// `TaskDeleted` from an earlier delete — can finally drop the row. Regression:
/// a stale/failed task used to be un-removable because the server 404'd and the
/// client silently ignored the resulting `delete_failed`.
#[tokio::test]
async fn delete_unknown_task_is_idempotent() {
    let (addr, _state) = start_server().await;

    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::new()).await;

    // T1 was never seeded — the server has no such row.
    send(&mut ws, &ClientMsg::DeleteTask { task_id: T1.into() }).await;

    loop {
        match next_rx(&mut ws).await {
            Rx::Ctrl(ServerMsg::TaskDeleted { task_id }) => {
                assert_eq!(
                    task_id, T1,
                    "delete of an unknown task must confirm removal"
                );
                break;
            }
            Rx::Ctrl(ServerMsg::Error { code, .. }) => {
                panic!("delete of an unknown task must not error: {code:?}");
            }
            _ => {}
        }
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
    assert!(
        outputs(&frames).is_empty(),
        "should not byte-replay a large backlog"
    );
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
    replay.process(&snap.1, snap.0);
    assert!(
        replay.contents().contains("FINAL"),
        "snapshot must redraw the screen"
    );
}

#[tokio::test]
async fn large_backlog_with_live_buffer_uses_byte_replay() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    state.tasks.inject_chunk(T1, b"initial").await.unwrap();
    for _ in 0..300 {
        state.tasks.inject_chunk(T1, b".").await.unwrap();
    }

    let mut ws = connect(addr).await;
    hello_paced(&mut ws, HashMap::from([(T1.to_string(), 1u64)])).await;
    let frames = read_paced_replay(&mut ws, T1).await;
    let replayed = outputs(&frames);

    assert_eq!(replayed.len(), 300);
    assert_eq!(replayed.first().unwrap().0, 2);
    assert_eq!(replayed.last().unwrap().0, 301);
    assert!(replayed.iter().all(|(_, data)| data == b"."));
    assert!(frames
        .iter()
        .all(|frame| matches!(frame, Frame::Output { .. })));
}

#[tokio::test]
async fn create_reply_overtakes_long_replay() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    state.tasks.inject_chunk(T1, b"initial").await.unwrap();
    for _ in 0..300 {
        state.tasks.inject_chunk(T1, b".").await.unwrap();
    }

    let mut ws = connect(addr).await;
    hello_paced(&mut ws, HashMap::from([(T1.to_string(), 1u64)])).await;
    loop {
        if let Rx::Bin(Frame::Output { seq: 2, .. }) = next_rx(&mut ws).await {
            break;
        }
    }

    send(
        &mut ws,
        &ClientMsg::CreateTask {
            request_id: Some("create-during-replay".into()),
            tool: "switchboard-test-command-that-does-not-exist".into(),
            title: None,
            cwd: None,
            cols: 80,
            rows: 24,
        },
    )
    .await;
    loop {
        match next_rx(&mut ws).await {
            Rx::Ctrl(ServerMsg::Error {
                code, request_id, ..
            }) if code.as_deref() == Some("create_failed") => {
                assert_eq!(request_id.as_deref(), Some("create-during-replay"));
                break;
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn lagged_replay_recovers_task_created_after_broadcast_overflow() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    state.tasks.inject_chunk(T1, b"initial").await.unwrap();
    for _ in 0..300 {
        state.tasks.inject_chunk(T1, b".").await.unwrap();
    }

    let mut ws = connect(addr).await;
    hello_paced(&mut ws, HashMap::from([(T1.to_string(), 1u64)])).await;
    loop {
        if let Rx::Bin(Frame::Output { seq: 2, .. }) = next_rx(&mut ws).await {
            break;
        }
    }

    seed(&state, T2).await;
    state.tasks.notify_created(TaskInfo {
        id: T2.into(),
        tool: "claude".into(),
        title: "created during replay".into(),
        status: TaskStatus::Running,
        created_at: now_millis(),
        last_seq: 0,
    });
    for _ in 0..2100 {
        state.tasks.inject_chunk(T1, b"x").await.unwrap();
    }

    send(
        &mut ws,
        &ClientMsg::Ack {
            task_id: T1.into(),
            seq: 2,
        },
    )
    .await;
    let _ = read_paced_replay(&mut ws, T1).await;
    loop {
        if let Rx::Ctrl(ServerMsg::TasksSnapshot { tasks }) = next_rx(&mut ws).await {
            assert!(tasks.iter().any(|task| task.id == T2));
            break;
        }
    }
}

#[tokio::test]
async fn large_backlog_without_pacing_keeps_snapshot() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    state.tasks.inject_chunk(T1, b"initial").await.unwrap();
    for _ in 0..300 {
        state.tasks.inject_chunk(T1, b".").await.unwrap();
    }

    let mut ws = connect(addr).await;
    hello(&mut ws, HashMap::from([(T1.to_string(), 1u64)])).await;
    let frames = read_through_replay(&mut ws, T1).await;

    assert!(outputs(&frames).is_empty());
    assert!(frames
        .iter()
        .any(|frame| matches!(frame, Frame::Snapshot { seq: 301, .. })));
}

#[tokio::test]
async fn history_http_uses_snapshot_without_raw_ws_history() {
    for count in [0u64, 3, 301] {
        let (addr, state) = start_server().await;
        seed(&state, T1).await;
        for i in 0..count {
            state
                .tasks
                .inject_chunk(T1, format!("chunk-{i}").as_bytes())
                .await
                .unwrap();
        }

        let mut ws = connect(addr).await;
        hello_history_http(&mut ws).await;
        let mut snapshot_seq = None;
        let mut history_start = None;
        let mut order = Vec::new();
        loop {
            match next_rx(&mut ws).await {
                Rx::Bin(Frame::Snapshot { seq, .. }) => {
                    snapshot_seq = Some(seq);
                    order.push("snapshot");
                }
                Rx::Bin(Frame::Output { seq, .. }) => {
                    panic!("historical OUTPUT {seq} sent for {count}-chunk HTTP history")
                }
                Rx::Bin(Frame::History { seq, .. }) => {
                    panic!("legacy HISTORY {seq} sent for HTTP history")
                }
                Rx::Ctrl(ServerMsg::HistoryStart { task_id, last_seq }) if task_id == T1 => {
                    history_start = Some(last_seq);
                    order.push("history_start");
                }
                Rx::Ctrl(ServerMsg::ReplayDone { task_id, last_seq }) if task_id == T1 => {
                    assert_eq!(last_seq, count);
                    break;
                }
                Rx::Ctrl(ServerMsg::HistoryDone { .. }) => {
                    panic!("legacy history completion sent for HTTP history")
                }
                _ => {}
            }
        }
        assert_eq!(snapshot_seq, Some(count));
        assert_eq!(history_start, (count > 0).then_some(count));
        if count > 0 {
            assert_eq!(order, ["history_start", "snapshot"]);
        }

        // The bytes omitted from WS are recoverable through bounded REST pages.
        let mut after = 0;
        let mut sequences = Vec::new();
        while after < count {
            let (status, page) = history_page(&state, T1, after, count).await;
            assert_eq!(status, StatusCode::OK);
            let next = page["next_after"].as_u64().unwrap();
            assert!(next > after && next <= count);
            for chunk in page["chunks"].as_array().unwrap() {
                sequences.push(chunk["seq"].as_u64().unwrap());
            }
            after = next;
        }
        assert_eq!(sequences, (1..=count).collect::<Vec<_>>());

        state.tasks.inject_chunk(T1, b"live").await.unwrap();
        assert_eq!(next_output(&mut ws).await, (count + 1, b"live".to_vec()));
    }
}

#[tokio::test]
async fn history_http_without_screen_uses_rest_and_survives_rest_failure() {
    let (addr, state) = start_server().await;
    let info = TaskInfo {
        id: T1.into(),
        tool: "claude".into(),
        title: "no screen".into(),
        status: TaskStatus::Exited { code: Some(0) },
        created_at: now_millis(),
        last_seq: 0,
    };
    state.store.create_task(&info).await.unwrap();
    state.tasks.inject_chunk(T1, b"one").await.unwrap();
    state.tasks.inject_chunk(T1, b"two").await.unwrap();

    let mut ws = connect(addr).await;
    hello_history_http(&mut ws).await;
    let mut history_start = None;
    loop {
        match next_rx(&mut ws).await {
            Rx::Bin(Frame::Output { seq, .. }) | Rx::Bin(Frame::History { seq, .. }) => {
                panic!("no-screen HTTP history leaked raw WS chunk {seq}")
            }
            Rx::Bin(Frame::Snapshot { .. }) => panic!("no-screen task produced a snapshot"),
            Rx::Ctrl(ServerMsg::HistoryStart { task_id, last_seq }) if task_id == T1 => {
                history_start = Some(last_seq)
            }
            Rx::Ctrl(ServerMsg::ReplayDone { task_id, last_seq }) if task_id == T1 => {
                assert_eq!(last_seq, 2);
                break;
            }
            _ => {}
        }
    }
    assert_eq!(history_start, Some(2));

    let (status, page) = history_page(&state, T1, 0, 2).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["next_after"], 2);
    assert_eq!(page["chunks"][0]["data_b64"], "b25l");
    assert_eq!(page["chunks"][1]["data_b64"], "dHdv");

    // A failed independent REST request must not tear down or stall the WS.
    let (status, _) = history_page(&state, T1, 0, 3).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    send(&mut ws, &ClientMsg::Ping { ts: 9876 }).await;
    state.tasks.inject_chunk(T1, b"live").await.unwrap();
    loop {
        match next_rx(&mut ws).await {
            Rx::Ctrl(ServerMsg::Pong { ts: 9876 }) => break,
            Rx::Bin(Frame::Output { .. }) => panic!("live output arrived before its pong check"),
            _ => {}
        }
    }
    assert_eq!(next_output(&mut ws).await, (3, b"live".to_vec()));
}

#[tokio::test]
async fn legacy_history_flag_does_not_start_in_band_history() {
    let (addr, state) = start_server().await;
    seed(&state, T1).await;
    for _ in 0..301 {
        state.tasks.inject_chunk(T1, b".").await.unwrap();
    }

    let mut ws = connect(addr).await;
    send(
        &mut ws,
        &ClientMsg::Hello {
            client_id: "legacy".into(),
            cursors: HashMap::new(),
            acks: true,
            history: true,
            history_http: false,
        },
    )
    .await;
    let mut snapshot = false;
    loop {
        match next_rx(&mut ws).await {
            Rx::Bin(Frame::Snapshot { seq: 301, .. }) => snapshot = true,
            Rx::Bin(Frame::History { .. }) => panic!("legacy client started a history worker"),
            Rx::Ctrl(ServerMsg::HistoryStart { .. } | ServerMsg::HistoryDone { .. }) => {
                panic!("legacy history control sent without history_http")
            }
            Rx::Ctrl(ServerMsg::ReplayDone { task_id, .. }) if task_id == T1 => break,
            _ => {}
        }
    }
    assert!(snapshot);

    state.tasks.inject_chunk(T1, b"live").await.unwrap();
    loop {
        match next_rx(&mut ws).await {
            Rx::Bin(Frame::Output { seq: 302, data, .. }) => {
                assert_eq!(data, b"live");
                break;
            }
            Rx::Bin(Frame::History { .. }) => panic!("legacy client received raw history"),
            Rx::Ctrl(ServerMsg::HistoryStart { .. } | ServerMsg::HistoryDone { .. }) => {
                panic!("legacy history control sent without history_http")
            }
            _ => {}
        }
    }
}

#[tokio::test]
async fn replay_is_paced_by_ack_frames() {
    let (addr, state) = start_server().await;
    // No authoritative screen: a large gap cannot collapse to a snapshot, so an
    // unpaced replay would dump the whole history in one burst.
    let info = TaskInfo {
        id: T1.into(),
        tool: "claude".into(),
        title: "old".into(),
        status: TaskStatus::Exited { code: Some(0) },
        created_at: now_millis(),
        last_seq: 0,
    };
    state.store.create_task(&info).await.unwrap();
    let n = super::ws::REPLAY_WINDOW * 2 + 88;
    for _ in 0..n {
        state.tasks.inject_chunk(T1, b"x").await.unwrap();
    }

    let mut ws = connect(addr).await;
    hello_paced(&mut ws, HashMap::new()).await;

    let mut got = 0u64;
    let mut window_start = 0u64;
    let mut waits = 0usize;
    loop {
        match tokio::time::timeout(Duration::from_millis(500), ws.next()).await {
            Ok(Some(Ok(WsMessage::Binary(_)))) => got += 1,
            Ok(Some(Ok(WsMessage::Text(t)))) => {
                if let Ok(ServerMsg::ReplayDone { .. }) = serde_json::from_str(t.as_str()) {
                    break;
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => panic!("ws error after {got} frames: {e}"),
            Ok(None) => panic!("stream ended after {got} frames"),
            Err(_) => {
                // The server must have sent exactly one window, then parked.
                assert_eq!(
                    got - window_start,
                    super::ws::REPLAY_WINDOW,
                    "replay sent more than the window before waiting"
                );
                waits += 1;
                window_start = got;
                send(
                    &mut ws,
                    &ClientMsg::Ack {
                        task_id: T1.into(),
                        seq: got,
                    },
                )
                .await;
            }
        }
    }
    assert_eq!(waits, 2, "expected a wait per window");
    assert_eq!(got, n, "the paced replay must still deliver every chunk");
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

#[tokio::test]
async fn ws_handshake_rejects_wrong_token() {
    let (addr, _state) = start_server().await;
    let url = format!("ws://{addr}/ws");
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    // Read the challenge, then reply with a MAC computed under the wrong token.
    let server_nonce = loop {
        if let WsMessage::Text(t) = ws.next().await.unwrap().unwrap() {
            if let Ok(AuthMsg::AuthChallenge { server_nonce }) =
                serde_json::from_str::<AuthMsg>(t.as_str())
            {
                break from_hex(&server_nonce).unwrap();
            }
        }
    };
    let client_nonce = random_nonce::<NONCE_LEN>();
    let mac = ws_mac(b"wrong-token", &server_nonce, &client_nonce, &[]);
    let resp = AuthMsg::AuthResponse {
        client_nonce: hex(&client_nonce),
        mac: hex(&mac),
    };
    ws.send(WsMessage::Text(serde_json::to_string(&resp).unwrap()))
        .await
        .unwrap();
    // Server must send AuthError and then close.
    let mut got_error = false;
    while let Some(Ok(frame)) = ws.next().await {
        if let WsMessage::Text(t) = frame {
            if matches!(
                serde_json::from_str::<AuthMsg>(t.as_str()),
                Ok(AuthMsg::AuthError { .. })
            ) {
                got_error = true;
            }
        }
    }
    assert!(got_error, "wrong-token handshake must be rejected");
}

// ---- REST per-request signing (SWB-REST-v1) --------------------------------

use axum::body::Body;
use axum::http::{Request, StatusCode};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use http_body_util::BodyExt;
use switchboard_shared::auth::{rest_mac, sha256, H_MAC, H_NONCE, H_TS};
use tower::ServiceExt;

/// Build a signed REST request. `cb` is empty (plain-HTTP test server).
fn signed_request(token: &[u8], method: &str, path_and_query: &str, body: &[u8]) -> Request<Body> {
    signed_request_at(token, method, path_and_query, body, now_millis(), None)
}

fn signed_request_at(
    token: &[u8],
    method: &str,
    path_and_query: &str,
    body: &[u8],
    ts: i64,
    nonce_override: Option<[u8; 16]>,
) -> Request<Body> {
    let nonce = nonce_override.unwrap_or_else(random_nonce::<16>);
    let mac = rest_mac(
        token,
        method,
        path_and_query,
        ts,
        &nonce,
        &sha256(body),
        &[],
    );
    Request::builder()
        .method(method)
        .uri(path_and_query)
        .header(H_TS, ts.to_string())
        .header(H_NONCE, hex(&nonce))
        .header(H_MAC, hex(&mac))
        .body(Body::from(body.to_vec()))
        .unwrap()
}

async fn rest_json(resp: axum::response::Response) -> (StatusCode, serde_json::Value) {
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (status, value)
}

async fn history_page(
    state: &Arc<AppState>,
    task_id: &str,
    after: u64,
    through: u64,
) -> (StatusCode, serde_json::Value) {
    history_page_with_token(state, TOKEN.as_bytes(), task_id, after, through).await
}

async fn history_page_with_token(
    state: &Arc<AppState>,
    token: &[u8],
    task_id: &str,
    after: u64,
    through: u64,
) -> (StatusCode, serde_json::Value) {
    let path = format!("/api/tasks/{task_id}/history?after={after}&through={through}");
    let req = signed_request(token, "GET", &path, b"");
    let resp = crate::http::router(state.clone(), true)
        .oneshot(req)
        .await
        .unwrap();
    rest_json(resp).await
}

#[tokio::test]
async fn history_rest_pages_preserve_binary_bytes() {
    let state = build_state().await;
    seed(&state, T1).await;
    let payloads: Vec<Vec<u8>> = (0..10)
        .map(|i| match i {
            0 => vec![0, 0xff, 0x80, 0],
            1 => vec![0, 0xff],
            _ => format!("chunk-{i}\0").into_bytes(),
        })
        .collect();
    for bytes in &payloads {
        state.tasks.inject_chunk(T1, bytes).await.unwrap();
    }

    let (status, first) = history_page(&state, T1, 0, 10).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["next_after"], 8);
    assert_eq!(first["chunks"].as_array().unwrap().len(), 8);
    for (index, chunk) in first["chunks"].as_array().unwrap().iter().enumerate() {
        assert_eq!(chunk["seq"], index as u64 + 1);
        let encoded = chunk["data_b64"].as_str().unwrap();
        assert_eq!(BASE64_STANDARD.decode(encoded).unwrap(), payloads[index]);
        assert_eq!(encoded, BASE64_STANDARD.encode(&payloads[index]));
    }

    let (status, second) = history_page(&state, T1, 8, 10).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["next_after"], 10);
    assert_eq!(second["chunks"].as_array().unwrap().len(), 2);
    for (index, chunk) in second["chunks"].as_array().unwrap().iter().enumerate() {
        let payload_index = index + 8;
        assert_eq!(chunk["seq"], payload_index as u64 + 1);
        assert_eq!(
            BASE64_STANDARD
                .decode(chunk["data_b64"].as_str().unwrap())
                .unwrap(),
            payloads[payload_index]
        );
    }
}

#[tokio::test]
async fn history_rest_page_respects_decoded_byte_limit() {
    let state = build_state().await;
    seed(&state, T1).await;
    state
        .tasks
        .inject_chunk(T1, &vec![0x5a; 40_000])
        .await
        .unwrap();
    state
        .tasks
        .inject_chunk(T1, &vec![0xa5; 40_000])
        .await
        .unwrap();

    let (status, first) = history_page(&state, T1, 0, 2).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["next_after"], 1);
    assert_eq!(first["chunks"].as_array().unwrap().len(), 1);
    assert_eq!(
        BASE64_STANDARD
            .decode(first["chunks"][0]["data_b64"].as_str().unwrap())
            .unwrap()
            .len(),
        40_000
    );

    let (status, second) = history_page(&state, T1, 1, 2).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(second["next_after"], 2);
    assert_eq!(second["chunks"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn history_rest_validates_bounds_existence_and_contiguity() {
    let state = build_state().await;
    seed(&state, T1).await;
    state.tasks.inject_chunk(T1, b"one").await.unwrap();
    state.tasks.inject_chunk(T1, b"two").await.unwrap();

    for (after, through) in [(0, 0), (2, 2), (2, 1), (0, 3)] {
        let (status, _) = history_page(&state, T1, after, through).await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "after={after}, through={through}"
        );
    }
    let (status, _) = history_page(&state, T2, 0, 1).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Metadata promises two chunks but the durable log is empty: never return a
    // successful empty page that would make the client's pagination loop stall.
    state
        .store
        .create_task(&TaskInfo {
            id: T2.into(),
            tool: "claude".into(),
            title: "missing chunks".into(),
            status: TaskStatus::Failed {
                error: "test".into(),
            },
            created_at: now_millis(),
            last_seq: 2,
        })
        .await
        .unwrap();
    let (status, _) = history_page(&state, T2, 0, 2).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn history_rest_requires_a_valid_signature() {
    let state = build_state().await;
    seed(&state, T1).await;
    state.tasks.inject_chunk(T1, b"secret").await.unwrap();
    let path = format!("/api/tasks/{T1}/history?after=0&through=1");

    let req = Request::builder()
        .method("GET")
        .uri(&path)
        .body(Body::empty())
        .unwrap();
    let resp = crate::http::router(state.clone(), true)
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);

    let (status, _) = history_page_with_token(&state, b"wrong-token", T1, 0, 1).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn history_rest_rejects_an_unpageable_oversized_chunk() {
    let state = build_state().await;
    seed(&state, T1).await;
    state
        .tasks
        .inject_chunk(T1, &vec![0x5a; 64 * 1024 + 1])
        .await
        .unwrap();
    let (status, _) = history_page(&state, T1, 0, 1).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn rest_valid_signature_passes() {
    let state = build_state().await;
    let app = crate::http::router(state, true);
    let req = signed_request(TOKEN.as_bytes(), "GET", "/api/info", b"");
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn rest_rejects_tampered_and_replayed() {
    let state = build_state().await;

    // Wrong token.
    let req = signed_request(b"wrong-token", "GET", "/api/info", b"");
    let resp = crate::http::router(state.clone(), true)
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "wrong token");

    // Tampered path: signed for /api/info but sent to /api/tasks.
    let ts = now_millis();
    let nonce = random_nonce::<16>();
    let mac = rest_mac(
        TOKEN.as_bytes(),
        "GET",
        "/api/info",
        ts,
        &nonce,
        &sha256(b""),
        &[],
    );
    let req = Request::builder()
        .method("GET")
        .uri("/api/tasks")
        .header(H_TS, ts.to_string())
        .header(H_NONCE, hex(&nonce))
        .header(H_MAC, hex(&mac))
        .body(Body::empty())
        .unwrap();
    let resp = crate::http::router(state.clone(), true)
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "tampered path");

    // Stale timestamp (outside the skew window).
    let req = signed_request_at(
        TOKEN.as_bytes(),
        "GET",
        "/api/info",
        b"",
        now_millis() - 60_000,
        None,
    );
    let resp = crate::http::router(state.clone(), true)
        .oneshot(req)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "stale timestamp");

    // Replayed nonce: first use passes, second identical request is rejected.
    let fixed_nonce = [9u8; 16];
    let ts = now_millis();
    let first = signed_request_at(
        TOKEN.as_bytes(),
        "GET",
        "/api/info",
        b"",
        ts,
        Some(fixed_nonce),
    );
    let resp = crate::http::router(state.clone(), true)
        .oneshot(first)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "first use of nonce");
    let second = signed_request_at(
        TOKEN.as_bytes(),
        "GET",
        "/api/info",
        b"",
        ts,
        Some(fixed_nonce),
    );
    let resp = crate::http::router(state.clone(), true)
        .oneshot(second)
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "replayed nonce");
}

#[tokio::test]
async fn rest_missing_signature_rejected() {
    let state = build_state().await;
    let req = Request::builder()
        .method("GET")
        .uri("/api/info")
        .body(Body::empty())
        .unwrap();
    let resp = crate::http::router(state, true).oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn garbage_auth_frames_get_the_connection_closed() {
    let (addr, _state) = start_server().await;
    let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/ws"))
        .await
        .unwrap();
    // Consume the challenge, then feed junk without ever answering it.
    let _ = ws.next().await;
    for _ in 0..12 {
        if ws.send(WsMessage::Text("not-json".into())).await.is_err() {
            break;
        }
    }

    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match ws.next().await {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "the server must abandon a handshake fed only garbage"
    );
}
