//! Tests for the worker-side tunnel liveness guard.
//!
//! A repeater whose socket goes *silently* dead (half-open: no Close, no
//! error, no frames) must not park the worker forever — the read window in
//! [`super::demux`] ends the tunnel so [`super::run`] redials and re-pairs.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use switchboard_shared::tunnel::{TunnelFrame, KIND_PING, KIND_PONG};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::{demux, Stream};
use crate::{
    config::{Config, Role},
    state::{AppState, SharedState},
    store::Store,
    task::TaskManager,
};

/// A minimal worker state: real store + task manager, no listeners.
async fn test_state() -> SharedState {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("worker.db").to_string_lossy().into_owned();
    std::mem::forget(dir); // keep the tempdir for the whole process
    let store = Store::connect(&db).await.unwrap();
    let tasks = TaskManager::new(store.clone(), &db);
    Arc::new(AppState {
        config: Config {
            role: Role::WorkerRepeaterClient,
            addr: "127.0.0.1:0".into(),
            token: None,
            db_path: db,
            service_name: "worker-link-test".into(),
            agent_permission_mode: "default".into(),
            tls: None,
            repeater_addr: None,
            repeater_token: None,
            repeater_ca: None,
            log_file: None,
        },
        store,
        tasks,
        cert_fp: Vec::new(),
        nonce_cache: Default::default(),
        tunnel_shutdown: Default::default(),
    })
}

/// A connected worker↔repeater WebSocket pair over an in-memory duplex pipe —
/// no TCP/TLS, so the "repeater" end can go *silent* without ever closing,
/// exactly the half-open failure mode the guard exists for.
async fn ws_pair() -> (
    impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
    tokio_tungstenite::WebSocketStream<tokio::io::DuplexStream>,
) {
    let (worker_io, repeater_io) = tokio::io::duplex(64 * 1024);
    let accept =
        tokio::spawn(async move { tokio_tungstenite::accept_async(repeater_io).await.unwrap() });
    let (worker, _) = tokio_tungstenite::client_async("wss://repeater/repeater", worker_io)
        .await
        .unwrap();
    let repeater = accept.await.unwrap();
    let (_sink, stream) = worker.split();
    (stream, repeater)
}

#[tokio::test]
async fn silent_tunnel_is_torn_down_after_the_idle_window() {
    let (mut stream, _repeater) = ws_pair().await; // the repeater never speaks
    let state = test_state().await;
    let app = crate::http::router(state.clone(), false);
    let (mux_tx, _mux_rx) = mpsc::channel(8);
    let mut streams = HashMap::new();

    let start = Instant::now();
    let err = demux(
        &mut stream,
        &mux_tx,
        &app,
        &state,
        &mut streams,
        Duration::from_millis(100),
    )
    .await
    .expect_err("a silent tunnel must be torn down");
    assert!(
        err.to_string().contains("silently dead"),
        "unexpected: {err}"
    );
    assert!(start.elapsed() >= Duration::from_millis(100));
}

#[tokio::test]
async fn heartbeat_frames_keep_the_tunnel_alive() {
    let (mut stream, mut repeater) = ws_pair().await;
    let state = test_state().await;
    let app = crate::http::router(state.clone(), false);
    let (mux_tx, mut mux_rx) = mpsc::channel(8);
    let mut streams = HashMap::<u64, Stream>::new();

    let idle = Duration::from_millis(150);
    let guard =
        tokio::spawn(
            async move { demux(&mut stream, &mux_tx, &app, &state, &mut streams, idle).await },
        );

    // Three PING beats 50ms apart span twice the idle window: each must be
    // answered with a PONG and none may trip the guard.
    for _ in 0..3 {
        repeater
            .send(WsMessage::Binary(
                TunnelFrame::control(KIND_PING, 0).encode(),
            ))
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_millis(100), mux_rx.recv())
            .await
            .expect("PONG never came")
            .unwrap();
        assert_eq!(TunnelFrame::decode(&pong).unwrap().kind, KIND_PONG);
        assert!(!guard.is_finished());
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Stop heartbeating: the guard must declare the tunnel dead.
    let err = tokio::time::timeout(Duration::from_secs(2), guard)
        .await
        .expect("demux never noticed the silence")
        .unwrap()
        .expect_err("a silent tunnel must be torn down");
    assert!(
        err.to_string().contains("silently dead"),
        "unexpected: {err}"
    );
}
