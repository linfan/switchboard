//! End-to-end transparency tests for repeater mode.
//!
//! Each test boots a **real repeater** and a **real worker-repeater-client** over
//! TLS on loopback, then drives the WS sync protocol and the REST API *through
//! the tunnel*. Because the repeater forwards opaque application bytes, these
//! assertions passing behind a repeater prove the same client behaviour works
//! unchanged — the transparency guarantee. The test client authenticates exactly
//! as a real client does (SWB-WS-v1 handshake / SWB-REST-v1 signing bound to the
//! repeater's cert); only TLS *verification* is relaxed to accept-all, so no PEM
//! trust dance is needed (cert pinning has its own unit coverage).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use switchboard_shared::{
    auth::{
        from_hex, hex, random_nonce, rest_mac, sha256, ws_mac, AuthMsg, H_MAC, H_NONCE, H_TS,
        NONCE_LEN,
    },
    frame::Frame,
    now_millis, ClientMsg, ServerMsg, ServiceInfo, TaskInfo, TaskStatus,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_tungstenite::{
    connect_async_tls_with_config, tungstenite::Message as WsMessage, Connector,
};

use crate::{
    config::{Config, Role, TlsConfig},
    state::{AppState, SharedState},
    store::Store,
    task::TaskManager,
};

const TOKEN: &str = "client-token";
const REPEATER_TOKEN: &str = "tunnel-token";
const T1: &str = "11111111-1111-4111-8111-111111111111";
const BODY_CHUNK: usize = 512 * 1024;

// ---- boot a repeater + a paired worker over TLS ----------------------------

/// A running repeater+worker pair. `cb` is the repeater's leaf-cert fingerprint,
/// used as the channel binding for client auth. `worker` is the worker's own
/// state, so a test can seed tasks / inject PTY chunks it will serve.
struct Harness {
    client_addr: String,
    cb: Vec<u8>,
    worker: SharedState,
}

/// A running repeater with no worker attached yet. `cb` is the leaf-cert
/// fingerprint (channel binding for both client and worker-leg auth); `cert_path`
/// is the PEM a worker pins as its `repeater_ca`.
struct Repeater {
    client_addr: String,
    worker_addr: String,
    cb: Vec<u8>,
    cert_path: String,
}

async fn boot_repeater() -> Repeater {
    let _ = ring::default_provider().install_default();

    let dir = tempfile::tempdir().unwrap();
    let p = |name: &str| dir.path().join(name).to_string_lossy().into_owned();
    let (cert_path, key_path) = (p("cert.pem"), p("key.pem"));
    let rdb = p("repeater.db");
    std::mem::forget(dir); // keep the tempdir for the whole process

    let tls = TlsConfig {
        cert_path: cert_path.clone(),
        key_path,
        extra_sans: vec![],
    };
    crate::tls::ensure_cert(&tls).unwrap();
    let cb = crate::tls::leaf_cert_fingerprint(&tls).unwrap();

    // Bind both listeners to ephemeral ports and hand the *live* sockets to the
    // repeater — no free-port-then-rebind window that could race another test.
    let client_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let worker_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let client_addr = client_listener.local_addr().unwrap().to_string();
    let worker_addr = worker_listener.local_addr().unwrap().to_string();

    // Repeater (runs no tasks; db_path is unused by this role).
    let rcfg = Config {
        role: Role::Repeater,
        addr: client_addr.clone(),
        token: Some(TOKEN.into()),
        db_path: rdb,
        service_name: "repeater-test".into(),
        agent_permission_mode: "default".into(),
        tls: Some(tls.clone()),
        repeater_addr: Some(worker_addr.clone()),
        repeater_token: Some(REPEATER_TOKEN.into()),
        repeater_ca: None,
        log_file: None,
    };
    tokio::spawn(async move {
        let _ = crate::repeater::serve(rcfg, client_listener, worker_listener).await;
    });

    Repeater { client_addr, worker_addr, cb, cert_path }
}

async fn boot() -> Harness {
    let r = boot_repeater().await;

    let dir = tempfile::tempdir().unwrap();
    let wdb = dir.path().join("worker.db").to_string_lossy().into_owned();
    std::mem::forget(dir);

    // Worker-repeater-client: dials the repeater, runs PTYs locally.
    let wcfg = Config {
        role: Role::WorkerRepeaterClient,
        addr: "127.0.0.1:0".into(),
        token: None,
        db_path: wdb.clone(),
        service_name: "worker-test".into(),
        agent_permission_mode: "default".into(),
        tls: None,
        repeater_addr: Some(r.worker_addr.clone()),
        repeater_token: Some(REPEATER_TOKEN.into()),
        repeater_ca: Some(r.cert_path.clone()),
        log_file: None,
    };
    let store = Store::connect(&wdb).await.unwrap();
    let tasks = TaskManager::new(store.clone());
    let worker: SharedState = Arc::new(AppState {
        config: wcfg,
        store,
        tasks,
        cert_fp: Vec::new(),
        nonce_cache: Default::default(),
        tunnel_shutdown: Default::default(),
    });
    {
        let w = worker.clone();
        tokio::spawn(async move {
            let _ = crate::worker_link::run(w).await;
        });
    }

    wait_paired(&r.client_addr, &r.cb).await;
    Harness {
        client_addr: r.client_addr,
        cb: r.cb,
        worker,
    }
}

/// Poll the repeater's locally-answered `/health` until it reports a paired
/// worker (the tunnel is up and authenticated), or panic after a timeout.
async fn wait_paired(addr: &str, _cb: &[u8]) {
    for _ in 0..100 {
        if let Ok((200, body)) = https_request(addr, "GET", "/health", None, b"").await {
            if String::from_utf8_lossy(&body).contains("\"paired\":true") {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("worker never paired with the repeater");
}

// ---- TLS clients (WS + raw HTTP/1.1), verification relaxed to accept-all ----

#[derive(Debug)]
struct AcceptAll(WebPkiSupportedAlgorithms);

fn client_tls() -> Arc<ClientConfig> {
    let _ = ring::default_provider().install_default();
    let algs = ring::default_provider().signature_verification_algorithms;
    Arc::new(
        ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAll(algs)))
            .with_no_client_auth(),
    )
}

impl ServerCertVerifier for AcceptAll {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.supported_schemes()
    }
}

/// Minimal HTTPS/1.1 client: opens a TLS connection, sends one request with
/// `Connection: close`, and reads the whole response. When `cb` is `Some`, the
/// request is SWB-REST-v1 signed with `TOKEN` bound to that channel binding.
/// Returns `(status, body)`. Errors surface as `Err` so `wait_paired` can retry.
async fn https_request(
    addr: &str,
    method: &str,
    path: &str,
    cb: Option<&[u8]>,
    body: &[u8],
) -> std::io::Result<(u16, Vec<u8>)> {
    let connector = tokio_rustls::TlsConnector::from(client_tls());
    let tcp = tokio::net::TcpStream::connect(addr).await?;
    let name = ServerName::try_from("localhost").unwrap();
    let mut tls = connector.connect(name, tcp).await?;

    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(cb) = cb {
        let ts = now_millis();
        let nonce = random_nonce::<16>();
        let mac = rest_mac(TOKEN.as_bytes(), method, path, ts, &nonce, &sha256(body), cb);
        head.push_str(&format!(
            "{H_TS}: {ts}\r\n{H_NONCE}: {}\r\n{H_MAC}: {}\r\n",
            hex(&nonce),
            hex(&mac)
        ));
    }
    head.push_str("\r\n");
    tls.write_all(head.as_bytes()).await?;
    tls.write_all(body).await?;
    tls.flush().await?;

    let mut raw = Vec::new();
    tls.read_to_end(&mut raw).await?;

    let sep = find(&raw, b"\r\n\r\n").expect("response has no header terminator");
    let status_line = &raw[..find(&raw, b"\r\n").unwrap()];
    let status: u16 = std::str::from_utf8(status_line)
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    Ok((status, raw[sep + 4..].to_vec()))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Open a client WS through the repeater and complete the SWB-WS-v1 handshake
/// (channel-bound to the repeater's cert `cb`).
async fn connect_ws(addr: &str, cb: &[u8]) -> WsStream {
    let url = format!("wss://{addr}/ws");
    let connector = Connector::Rustls(client_tls());
    let (mut ws, _) = connect_async_tls_with_config(&url, None, false, Some(connector))
        .await
        .unwrap();

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
    let mac = ws_mac(TOKEN.as_bytes(), &server_nonce, &client_nonce, cb);
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
    ws
}

/// Dial the repeater's worker-facing `/repeater` leg and complete the SWB-WS-v1
/// handshake as a *worker* would (proving `REPEATER_TOKEN`, bound to the repeater
/// cert `cb`). Returns the authenticated socket without running the worker app —
/// enough to occupy the single slot and exercise pairing/eviction.
async fn dial_worker_leg(worker_addr: &str, cb: &[u8]) -> WsStream {
    let url = format!("wss://{worker_addr}/repeater");
    let connector = Connector::Rustls(client_tls());
    let (mut ws, _) = connect_async_tls_with_config(&url, None, false, Some(connector))
        .await
        .unwrap();

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
    let mac = ws_mac(REPEATER_TOKEN.as_bytes(), &server_nonce, &client_nonce, cb);
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
                Ok(AuthMsg::AuthError { message }) => panic!("worker-leg auth failed: {message}"),
                _ => {}
            }
        }
    }
    ws
}

// ---- WS protocol helpers (mirror ws_test) ----------------------------------

async fn seed(worker: &AppState, id: &str) {
    let info = TaskInfo {
        id: id.into(),
        tool: "claude".into(),
        title: "seed".into(),
        status: TaskStatus::Running,
        created_at: now_millis(),
        last_seq: 0,
    };
    worker.store.create_task(&info).await.unwrap();
    worker.tasks.register_terminal(id, 80, 24);
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
        },
    )
    .await;
}

enum Rx {
    Ctrl(ServerMsg),
    Bin(Frame),
}

async fn next_rx(ws: &mut WsStream) -> Rx {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), ws.next())
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

// ---- tests ------------------------------------------------------------------

#[tokio::test]
async fn welcome_and_byte_replay_through_repeater() {
    let h = boot().await;
    seed(&h.worker, T1).await;
    for b in [b"a".as_slice(), b"b", b"c"] {
        h.worker.tasks.inject_chunk(T1, b).await.unwrap();
    }

    let mut ws = connect_ws(&h.client_addr, &h.cb).await;
    hello(&mut ws, HashMap::new()).await;

    let frames = read_through_replay(&mut ws, T1).await;
    assert_eq!(
        outputs(&frames),
        vec![(1, b"a".to_vec()), (2, b"b".to_vec()), (3, b"c".to_vec())],
        "full byte replay must arrive intact through the repeater"
    );
}

#[tokio::test]
async fn cursor_replay_through_repeater() {
    let h = boot().await;
    seed(&h.worker, T1).await;
    for b in [b"a".as_slice(), b"b", b"c", b"d"] {
        h.worker.tasks.inject_chunk(T1, b).await.unwrap();
    }

    let mut ws = connect_ws(&h.client_addr, &h.cb).await;
    hello(&mut ws, HashMap::from([(T1.to_string(), 2u64)])).await;

    let frames = read_through_replay(&mut ws, T1).await;
    assert_eq!(
        outputs(&frames),
        vec![(3, b"c".to_vec()), (4, b"d".to_vec())],
        "cursor must be honoured across the tunnel"
    );
}

#[tokio::test]
async fn live_streaming_through_repeater() {
    let h = boot().await;
    seed(&h.worker, T1).await;
    h.worker.tasks.inject_chunk(T1, b"a").await.unwrap();

    let mut ws = connect_ws(&h.client_addr, &h.cb).await;
    hello(&mut ws, HashMap::new()).await;
    assert_eq!(outputs(&read_through_replay(&mut ws, T1).await), vec![(1, b"a".to_vec())]);

    // Output produced after the client is live must stream through the tunnel.
    h.worker.tasks.inject_chunk(T1, b"b").await.unwrap();
    h.worker.tasks.inject_chunk(T1, b"c").await.unwrap();
    assert_eq!(next_output(&mut ws).await, (2, b"b".to_vec()));
    assert_eq!(next_output(&mut ws).await, (3, b"c".to_vec()));
}

#[tokio::test]
async fn multi_viewer_through_repeater() {
    let h = boot().await;
    seed(&h.worker, T1).await;

    let mut a = connect_ws(&h.client_addr, &h.cb).await;
    hello(&mut a, HashMap::new()).await;
    let _ = read_through_replay(&mut a, T1).await;
    let mut b = connect_ws(&h.client_addr, &h.cb).await;
    hello(&mut b, HashMap::new()).await;
    let _ = read_through_replay(&mut b, T1).await;

    // One worker broadcast must fan out to every client multiplexed on the tunnel.
    h.worker.tasks.inject_chunk(T1, b"shared").await.unwrap();
    assert_eq!(next_output(&mut a).await, (1, b"shared".to_vec()));
    assert_eq!(next_output(&mut b).await, (1, b"shared".to_vec()));
}

#[tokio::test]
async fn ping_pong_through_repeater() {
    let h = boot().await;
    let mut ws = connect_ws(&h.client_addr, &h.cb).await;
    hello(&mut ws, HashMap::new()).await;
    let _ = tokio::time::timeout(Duration::from_secs(5), ws.next()).await; // drain Welcome

    send(&mut ws, &ClientMsg::Ping { ts: 777 }).await;
    let mut got = false;
    for _ in 0..10 {
        if let Rx::Ctrl(ServerMsg::Pong { ts }) = next_rx(&mut ws).await {
            assert_eq!(ts, 777);
            got = true;
            break;
        }
    }
    assert!(got, "control-plane ping/pong must round-trip through the tunnel");
}

#[tokio::test]
async fn delete_task_through_repeater() {
    let h = boot().await;
    seed(&h.worker, T1).await;
    h.worker.tasks.inject_chunk(T1, b"a").await.unwrap();

    let mut ws = connect_ws(&h.client_addr, &h.cb).await;
    hello(&mut ws, HashMap::new()).await;
    read_through_replay(&mut ws, T1).await;

    // DeleteTask travels client → repeater → tunnel → worker over the reliable
    // control path; the worker removes all durable state for the task. (The
    // TaskDeleted *notification* rides the lossy broadcast — a lagging viewer
    // learns of the deletion on its next reconnect instead, so we assert the
    // deterministic effect rather than racing that frame.)
    send(&mut ws, &ClientMsg::DeleteTask { task_id: T1.into() }).await;
    for _ in 0..100 {
        if h.worker.store.get_task(T1).await.unwrap().is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        h.worker.store.get_task(T1).await.unwrap().is_none(),
        "delete must reach the worker through the tunnel"
    );

    // A fresh client's Welcome — rebuilt on the worker and forwarded back — no
    // longer lists the task.
    let mut ws2 = connect_ws(&h.client_addr, &h.cb).await;
    hello(&mut ws2, HashMap::new()).await;
    match next_rx(&mut ws2).await {
        Rx::Ctrl(ServerMsg::Welcome { tasks, .. }) => {
            assert!(tasks.iter().all(|t| t.id != T1), "deleted task must not reappear");
        }
        _ => panic!("expected Welcome as the first control frame"),
    }
}

#[tokio::test]
async fn rest_info_through_repeater() {
    let h = boot().await;
    // Signed GET forwarded opaquely to the worker's /api/info handler.
    let (status, body) = https_request(&h.client_addr, "GET", "/api/info", Some(&h.cb), b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    let info: ServiceInfo = serde_json::from_slice(&body).unwrap();
    assert_eq!(info.name, "worker-test", "REST response must come from the worker");
}

#[tokio::test]
async fn rest_unsigned_rejected_through_repeater() {
    let h = boot().await;
    // No signature: the repeater terminates client auth at ingress → 401,
    // and the request never reaches the worker.
    let (status, _) = https_request(&h.client_addr, "GET", "/api/info", None, b"")
        .await
        .unwrap();
    assert_eq!(status, 401);
}

#[tokio::test]
async fn health_answered_locally_by_repeater() {
    let h = boot().await;
    let (status, body) = https_request(&h.client_addr, "GET", "/health", None, b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    // The repeater answers /health itself (never tunneled) so liveness works
    // even with no worker; it reports its own role and pairing state.
    assert_eq!(v["role"], "repeater");
    assert_eq!(v["paired"], true);
}

#[tokio::test]
async fn large_upload_chunked_through_repeater() {
    let h = boot().await;
    let upload_dir = tempfile::tempdir().unwrap();
    let dir = upload_dir.path().to_string_lossy().into_owned();

    // Bigger than several BODY_CHUNK (512 KiB) frames so the request body must be
    // split into REQ_BODY chunks and reassembled on the worker — the chunking path.
    let payload: Vec<u8> = (0..BODY_CHUNK * 5 + 12_345).map(|i| (i % 251) as u8).collect();
    let path = format!("/api/fs/upload?dir={dir}&name=big.bin");

    let (status, _) = https_request(&h.client_addr, "POST", &path, Some(&h.cb), &payload)
        .await
        .unwrap();
    assert_eq!(status, 204, "chunked upload must succeed through the tunnel");

    // The worker wrote the reassembled bytes to its local disk, byte-for-byte.
    let written = std::fs::read(upload_dir.path().join("big.bin")).unwrap();
    assert_eq!(written.len(), payload.len());
    assert_eq!(written, payload, "reassembled upload must match the original");
}

#[tokio::test]
async fn newer_worker_evicts_incumbent() {
    // Two raw worker legs against a lone repeater (no auto-reconnecting real
    // worker that would fight the newcomer for the slot). This models a
    // self-upgrade re-exec: the new process dials in while the repeater still
    // holds the old, now-dead tunnel.
    let r = boot_repeater().await;

    // First worker pairs and holds the single slot.
    let mut first = dial_worker_leg(&r.worker_addr, &r.cb).await;
    wait_paired(&r.client_addr, &r.cb).await;

    // A second authenticated worker dials in. Last-writer-wins: it takes the slot
    // and the incumbent is torn down — the newcomer is NOT rejected. This is what
    // lets a re-exec'd host re-pair immediately instead of waiting out the old
    // socket's teardown or the 45s idle timeout.
    let _second = dial_worker_leg(&r.worker_addr, &r.cb).await;

    // The incumbent's socket is closed by the repeater upon eviction.
    let evicted = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match first.next().await {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => continue, // heartbeat PING may arrive before the close
            }
        }
    })
    .await;
    assert!(evicted.is_ok(), "the incumbent worker must be disconnected when evicted");

    // The repeater stays paired throughout — now served by the second worker.
    wait_paired(&r.client_addr, &r.cb).await;
}
