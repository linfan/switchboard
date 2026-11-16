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
use rustls::crypto::{
    ring, verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use switchboard_shared::{
    auth::{
        from_hex, hex, random_nonce, rest_mac, sha256, ws_mac, AuthMsg, H_MAC, H_NONCE, H_TS,
        NONCE_LEN,
    },
    frame::Frame,
    now_millis,
    port_forward::PortForwardFrame,
    tunnel::{
        ReqHead, RespHead, Tag, TunnelFrame, WorkerHello, KIND_HELLO, KIND_REQ_END, KIND_REQ_HEAD,
        KIND_RESP_END, KIND_RESP_HEAD, PROTO,
    },
    ClientMsg, ServerMsg, ServiceInfo, TaskInfo, TaskStatus,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
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
const TAG_A: &str = "worker-a";
const TAG_B: &str = "worker-b";
const T1: &str = "11111111-1111-4111-8111-111111111111";
const BODY_CHUNK: usize = 512 * 1024;

fn tagged(path: &str, tag: &str) -> String {
    let separator = if path.contains('?') { '&' } else { '?' };
    format!("{path}{separator}tag={tag}")
}

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
        tag: None,
        log_file: None,
    };
    tokio::spawn(async move {
        let _ = crate::repeater::serve(rcfg, client_listener, worker_listener).await;
    });

    Repeater {
        client_addr,
        worker_addr,
        cb,
        cert_path,
    }
}

async fn boot() -> Harness {
    let r = boot_repeater().await;
    let worker = boot_worker(&r, TAG_A, "worker-test").await;
    Harness {
        client_addr: r.client_addr,
        cb: r.cb,
        worker,
    }
}

/// Boot one independent real worker against `repeater`. Each worker gets its own
/// database, service name and AppState, so equal application ids cannot share
/// state accidentally inside the test harness itself.
async fn boot_worker(repeater: &Repeater, tag: &str, service_name: &str) -> SharedState {
    let dir = tempfile::tempdir().unwrap();
    let wdb = dir.path().join("worker.db").to_string_lossy().into_owned();
    std::mem::forget(dir);

    // Worker-repeater-client: dials the repeater, runs PTYs locally.
    let wcfg = Config {
        role: Role::WorkerRepeaterClient,
        addr: "127.0.0.1:0".into(),
        token: None,
        db_path: wdb.clone(),
        service_name: service_name.into(),
        agent_permission_mode: "default".into(),
        tls: None,
        repeater_addr: Some(repeater.worker_addr.clone()),
        repeater_token: Some(REPEATER_TOKEN.into()),
        repeater_ca: Some(repeater.cert_path.clone()),
        tag: Some(Tag::parse(tag).unwrap()),
        log_file: None,
    };
    let store = Store::connect(&wdb).await.unwrap();
    let tasks = TaskManager::new(store.clone(), &wdb);
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

    wait_paired(&repeater.client_addr, tag).await;
    worker
}

/// Poll the repeater's locally-answered `/health` until the selected TAG reports
/// a paired worker (the tunnel is up and authenticated), or panic after a timeout.
async fn wait_paired(addr: &str, tag: &str) {
    for _ in 0..100 {
        let path = tagged("/health", tag);
        if let Ok((200, body)) = https_request(addr, "GET", &path, None, b"").await {
            if serde_json::from_slice::<serde_json::Value>(&body)
                .is_ok_and(|v| v["tag"] == tag && v["paired"] == true)
            {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("worker {tag} never paired with the repeater");
}

async fn wait_unpaired(addr: &str, tag: &str) {
    for _ in 0..100 {
        let path = tagged("/health", tag);
        if let Ok((200, body)) = https_request(addr, "GET", &path, None, b"").await {
            if serde_json::from_slice::<serde_json::Value>(&body)
                .is_ok_and(|v| v["tag"] == tag && v["paired"] == false)
            {
                return;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("worker {tag} never unpaired from the repeater");
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
    https_request_with_signature_target(addr, method, path, path, cb, body).await
}

/// Variant that deliberately signs a target other than the actual request URL.
/// Normal callers must use `https_request`, which keeps the two identical.
async fn https_request_with_signature_target(
    addr: &str,
    method: &str,
    path: &str,
    signature_target: &str,
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
        let mac = rest_mac(
            TOKEN.as_bytes(),
            method,
            signature_target,
            ts,
            &nonce,
            &sha256(body),
            cb,
        );
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
    let chunked = String::from_utf8_lossy(&raw[..sep])
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked");
    let body = raw[sep + 4..].to_vec();
    Ok((status, if chunked { decode_chunked(&body) } else { body }))
}

/// Minimal `Transfer-Encoding: chunked` decoder for responses whose length is
/// only known while streaming (the repeater no longer buffers REST bodies).
fn decode_chunked(input: &[u8]) -> Vec<u8> {
    let mut rest = input;
    let mut out = Vec::new();
    loop {
        let line_end = find(rest, b"\r\n").expect("chunk size line");
        let size_line = std::str::from_utf8(&rest[..line_end]).unwrap();
        let size = usize::from_str_radix(size_line.split(';').next().unwrap().trim(), 16)
            .expect("hex chunk size");
        rest = &rest[line_end + 2..];
        if size == 0 {
            return out;
        }
        out.extend_from_slice(&rest[..size]);
        rest = &rest[size + 2..];
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Open a client WS through the repeater and complete the SWB-WS-v1 handshake
/// (channel-bound to the repeater's cert `cb`).
async fn connect_ws(addr: &str, cb: &[u8], tag: &str) -> WsStream {
    connect_endpoint(addr, cb, "/ws", tag).await
}

async fn connect_forward(addr: &str, cb: &[u8], tag: &str) -> WsStream {
    connect_endpoint(addr, cb, "/forward", tag).await
}

async fn connect_endpoint(addr: &str, cb: &[u8], path: &str, tag: &str) -> WsStream {
    let url = format!("wss://{addr}{}", tagged(path, tag));
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

/// Dial the repeater's worker-facing `/repeater` leg, authenticate as a worker,
/// and send a normal protocol-current HELLO for the default TAG.
async fn dial_worker_leg(worker_addr: &str, cb: &[u8]) -> WsStream {
    dial_worker_leg_with_caps(worker_addr, cb, TAG_A, &["ws", "forward"]).await
}

/// Authenticate a raw worker and announce a legal TAG and the selected PROTO.
async fn dial_worker_leg_with_proto(
    worker_addr: &str,
    cb: &[u8],
    tag: &str,
    proto: u32,
    features: &[&str],
) -> WsStream {
    let hello = WorkerHello {
        proto,
        version: "9.9.9-test".into(),
        tag: Tag::parse(tag).unwrap(),
        features: features.iter().map(|f| (*f).into()).collect(),
    };
    let frame = TunnelFrame::new(KIND_HELLO, 0, serde_json::to_vec(&hello).unwrap());
    dial_worker_leg_raw(worker_addr, cb, Some(WsMessage::Binary(frame.encode()))).await
}

async fn dial_worker_leg_with_caps(
    worker_addr: &str,
    cb: &[u8],
    tag: &str,
    features: &[&str],
) -> WsStream {
    dial_worker_leg_with_proto(worker_addr, cb, tag, PROTO, features).await
}

/// Authenticate a raw worker and optionally send an arbitrary first message.
/// `None` models a worker that never sends the mandatory HELLO.
async fn dial_worker_leg_raw(worker_addr: &str, cb: &[u8], first: Option<WsMessage>) -> WsStream {
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
    if let Some(first) = first {
        ws.send(first).await.unwrap();
    }
    ws
}

async fn wait_ws_closed(ws: &mut WsStream, message: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match ws.next().await {
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{message}"));
}

async fn next_tunnel_frame(ws: &mut WsStream, kind: u8) -> TunnelFrame {
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for tunnel frame")
            .expect("worker leg ended")
            .expect("worker leg error");
        if let WsMessage::Binary(bytes) = message {
            let frame = TunnelFrame::decode(&bytes).unwrap();
            if frame.kind == kind {
                return frame;
            }
        }
    }
}

/// Attempt a client-facing upgrade and return its pre-auth HTTP rejection.
async fn upgrade_error(addr: &str, path: &str) -> tokio_tungstenite::tungstenite::Error {
    let url = format!("wss://{addr}{path}");
    let connector = Connector::Rustls(client_tls());
    connect_async_tls_with_config(&url, None, false, Some(connector))
        .await
        .expect_err("the upgrade should be refused before the handshake")
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
            acks: false,
            history: false,
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

async fn next_forward_frame(ws: &mut WsStream) -> PortForwardFrame {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(10), ws.next())
            .await
            .expect("timed out")
            .expect("stream ended")
            .expect("ws error");
        if let WsMessage::Binary(bytes) = frame {
            return PortForwardFrame::decode(&bytes).unwrap();
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
async fn tcp_forwarding_through_repeater() {
    let h = boot().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let echo = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.shutdown().await.unwrap();
    });

    let stream_id = 17;
    let mut ws = connect_forward(&h.client_addr, &h.cb, TAG_A).await;
    ws.send(WsMessage::Binary(
        PortForwardFrame::Open {
            stream_id,
            remote_port: port,
        }
        .encode(),
    ))
    .await
    .unwrap();
    assert_eq!(
        next_forward_frame(&mut ws).await,
        PortForwardFrame::OpenOk { stream_id }
    );

    ws.send(WsMessage::Binary(
        PortForwardFrame::Data {
            stream_id,
            data: b"through-repeater".to_vec(),
        }
        .encode(),
    ))
    .await
    .unwrap();
    ws.send(WsMessage::Binary(
        PortForwardFrame::Fin { stream_id }.encode(),
    ))
    .await
    .unwrap();

    assert_eq!(
        next_forward_frame(&mut ws).await,
        PortForwardFrame::Data {
            stream_id,
            data: b"through-repeater".to_vec(),
        }
    );
    assert_eq!(
        next_forward_frame(&mut ws).await,
        PortForwardFrame::Fin { stream_id }
    );
    echo.await.unwrap();
}

#[tokio::test]
async fn tcp_forwarding_is_isolated_by_tag() {
    let r = boot_repeater().await;
    boot_worker(&r, TAG_A, "worker-a-service").await;
    boot_worker(&r, TAG_B, "worker-b-service").await;

    let listener_a = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port_a = listener_a.local_addr().unwrap().port();
    let echo_a = tokio::spawn(async move {
        let (mut stream, _) = listener_a.accept().await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        stream.write_all(b"from-a:").await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    let listener_b = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port_b = listener_b.local_addr().unwrap().port();
    let echo_b = tokio::spawn(async move {
        let (mut stream, _) = listener_b.accept().await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        stream.write_all(b"from-b:").await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.shutdown().await.unwrap();
    });

    // These are the first outer streams on their respective worker tunnels, and
    // both application sessions deliberately reuse stream id 17.
    let mut a = connect_forward(&r.client_addr, &r.cb, TAG_A).await;
    let mut b = connect_forward(&r.client_addr, &r.cb, TAG_B).await;
    for (ws, remote_port) in [(&mut a, port_a), (&mut b, port_b)] {
        ws.send(WsMessage::Binary(
            PortForwardFrame::Open {
                stream_id: 17,
                remote_port,
            }
            .encode(),
        ))
        .await
        .unwrap();
        assert_eq!(
            next_forward_frame(ws).await,
            PortForwardFrame::OpenOk { stream_id: 17 }
        );
        ws.send(WsMessage::Binary(
            PortForwardFrame::Data {
                stream_id: 17,
                data: b"ping".to_vec(),
            }
            .encode(),
        ))
        .await
        .unwrap();
        ws.send(WsMessage::Binary(
            PortForwardFrame::Fin { stream_id: 17 }.encode(),
        ))
        .await
        .unwrap();
    }

    for (ws, expected) in [
        (&mut a, b"from-a:ping".to_vec()),
        (&mut b, b"from-b:ping".to_vec()),
    ] {
        assert_eq!(
            next_forward_frame(ws).await,
            PortForwardFrame::Data {
                stream_id: 17,
                data: expected,
            }
        );
        assert_eq!(
            next_forward_frame(ws).await,
            PortForwardFrame::Fin { stream_id: 17 }
        );
    }
    echo_a.await.unwrap();
    echo_b.await.unwrap();
}

#[tokio::test]
async fn welcome_and_byte_replay_through_repeater() {
    let h = boot().await;
    seed(&h.worker, T1).await;
    for b in [b"a".as_slice(), b"b", b"c"] {
        h.worker.tasks.inject_chunk(T1, b).await.unwrap();
    }

    let mut ws = connect_ws(&h.client_addr, &h.cb, TAG_A).await;
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

    let mut ws = connect_ws(&h.client_addr, &h.cb, TAG_A).await;
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

    let mut ws = connect_ws(&h.client_addr, &h.cb, TAG_A).await;
    hello(&mut ws, HashMap::new()).await;
    assert_eq!(
        outputs(&read_through_replay(&mut ws, T1).await),
        vec![(1, b"a".to_vec())]
    );

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

    let mut a = connect_ws(&h.client_addr, &h.cb, TAG_A).await;
    hello(&mut a, HashMap::new()).await;
    let _ = read_through_replay(&mut a, T1).await;
    let mut b = connect_ws(&h.client_addr, &h.cb, TAG_A).await;
    hello(&mut b, HashMap::new()).await;
    let _ = read_through_replay(&mut b, T1).await;

    // One worker broadcast must fan out to every client multiplexed on the tunnel.
    h.worker.tasks.inject_chunk(T1, b"shared").await.unwrap();
    assert_eq!(next_output(&mut a).await, (1, b"shared".to_vec()));
    assert_eq!(next_output(&mut b).await, (1, b"shared".to_vec()));
}

#[tokio::test]
async fn ws_replay_live_and_fanout_are_isolated_by_tag() {
    let r = boot_repeater().await;
    let worker_a = boot_worker(&r, TAG_A, "worker-a-service").await;
    let worker_b = boot_worker(&r, TAG_B, "worker-b-service").await;

    // Deliberately use the same task id in both independent stores. The first
    // client on each tunnel also receives outer stream id 1.
    seed(&worker_a, T1).await;
    seed(&worker_b, T1).await;
    worker_a.tasks.inject_chunk(T1, b"a-replay").await.unwrap();
    worker_b.tasks.inject_chunk(T1, b"b-replay").await.unwrap();

    let mut a1 = connect_ws(&r.client_addr, &r.cb, TAG_A).await;
    hello(&mut a1, HashMap::new()).await;
    assert_eq!(
        outputs(&read_through_replay(&mut a1, T1).await),
        vec![(1, b"a-replay".to_vec())]
    );
    let mut a2 = connect_ws(&r.client_addr, &r.cb, TAG_A).await;
    hello(&mut a2, HashMap::new()).await;
    assert_eq!(
        outputs(&read_through_replay(&mut a2, T1).await),
        vec![(1, b"a-replay".to_vec())]
    );
    let mut b = connect_ws(&r.client_addr, &r.cb, TAG_B).await;
    hello(&mut b, HashMap::new()).await;
    assert_eq!(
        outputs(&read_through_replay(&mut b, T1).await),
        vec![(1, b"b-replay".to_vec())]
    );

    // A's live output fans out to both A clients. B's next output must still be
    // its own payload, proving that no A frame crossed into B's stream id 1.
    worker_a.tasks.inject_chunk(T1, b"a-live-1").await.unwrap();
    assert_eq!(next_output(&mut a1).await, (2, b"a-live-1".to_vec()));
    assert_eq!(next_output(&mut a2).await, (2, b"a-live-1".to_vec()));
    worker_b.tasks.inject_chunk(T1, b"b-live-1").await.unwrap();
    assert_eq!(next_output(&mut b).await, (2, b"b-live-1".to_vec()));

    // Check the reverse direction too: any leaked B frame would be observed
    // before the next expected A output on either A client.
    worker_b.tasks.inject_chunk(T1, b"b-live-2").await.unwrap();
    assert_eq!(next_output(&mut b).await, (3, b"b-live-2".to_vec()));
    worker_a.tasks.inject_chunk(T1, b"a-live-2").await.unwrap();
    assert_eq!(next_output(&mut a1).await, (3, b"a-live-2".to_vec()));
    assert_eq!(next_output(&mut a2).await, (3, b"a-live-2".to_vec()));
}

#[tokio::test]
async fn ping_pong_through_repeater() {
    let h = boot().await;
    let mut ws = connect_ws(&h.client_addr, &h.cb, TAG_A).await;
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
    assert!(
        got,
        "control-plane ping/pong must round-trip through the tunnel"
    );
}

#[tokio::test]
async fn delete_task_through_repeater() {
    let h = boot().await;
    seed(&h.worker, T1).await;
    h.worker.tasks.inject_chunk(T1, b"a").await.unwrap();

    let mut ws = connect_ws(&h.client_addr, &h.cb, TAG_A).await;
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
    let mut ws2 = connect_ws(&h.client_addr, &h.cb, TAG_A).await;
    hello(&mut ws2, HashMap::new()).await;
    match next_rx(&mut ws2).await {
        Rx::Ctrl(ServerMsg::Welcome { tasks, .. }) => {
            assert!(
                tasks.iter().all(|t| t.id != T1),
                "deleted task must not reappear"
            );
        }
        _ => panic!("expected Welcome as the first control frame"),
    }
}

#[tokio::test]
async fn rest_info_through_repeater() {
    let h = boot().await;
    // Signed GET forwarded opaquely to the worker's /api/info handler.
    let path = tagged("/api/info", TAG_A);
    let (status, body) = https_request(&h.client_addr, "GET", &path, Some(&h.cb), b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    let info: ServiceInfo = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        info.name, "worker-test",
        "REST response must come from the worker"
    );
}

#[tokio::test]
async fn rest_info_and_health_route_to_independent_tags() {
    let r = boot_repeater().await;
    let _worker_a = boot_worker(&r, TAG_A, "worker-a-service").await;
    let _worker_b = boot_worker(&r, TAG_B, "worker-b-service").await;

    for (tag, service_name) in [(TAG_A, "worker-a-service"), (TAG_B, "worker-b-service")] {
        let health_path = tagged("/health", tag);
        let (status, body) = https_request(&r.client_addr, "GET", &health_path, None, b"")
            .await
            .unwrap();
        assert_eq!(status, 200);
        let health: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(health["tag"], tag);
        assert_eq!(health["paired"], true);
        assert_eq!(health["worker_version"], crate::version::full());

        let info_path = tagged("/api/info", tag);
        let (status, body) = https_request(&r.client_addr, "GET", &info_path, Some(&r.cb), b"")
            .await
            .unwrap();
        assert_eq!(status, 200);
        let info: ServiceInfo = serde_json::from_slice(&body).unwrap();
        assert_eq!(info.name, service_name);
    }
}

#[tokio::test]
async fn rest_signature_must_match_the_actual_tagged_target() {
    let h = boot().await;
    let actual = tagged("/api/info", TAG_A);
    let (status, _) = https_request_with_signature_target(
        &h.client_addr,
        "GET",
        &actual,
        "/api/info",
        Some(&h.cb),
        b"",
    )
    .await
    .unwrap();
    assert_eq!(status, 401);
}

#[tokio::test]
async fn rest_strips_only_tag_and_preserves_the_remaining_raw_query() {
    let r = boot_repeater().await;
    let mut worker = dial_worker_leg(&r.worker_addr, &r.cb).await;
    wait_paired(&r.client_addr, TAG_A).await;

    let path = "/api/info?first=a%2Fb&tag=worker-a&second=x+y&&third=%2e";
    let client = https_request(&r.client_addr, "GET", path, Some(&r.cb), b"");
    let respond = async {
        let frame = next_tunnel_frame(&mut worker, KIND_REQ_HEAD).await;
        let head: ReqHead = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(
            head.uri, "/api/info?first=a%2Fb&second=x+y&&third=%2e",
            "worker must receive the original path/query without its routing TAG"
        );
        let end = next_tunnel_frame(&mut worker, KIND_REQ_END).await;
        assert_eq!(end.stream_id, frame.stream_id);

        let response = RespHead {
            status: 200,
            headers: vec![],
        };
        worker
            .send(WsMessage::Binary(
                TunnelFrame::new(
                    KIND_RESP_HEAD,
                    frame.stream_id,
                    serde_json::to_vec(&response).unwrap(),
                )
                .encode(),
            ))
            .await
            .unwrap();
        worker
            .send(WsMessage::Binary(
                TunnelFrame::control(KIND_RESP_END, frame.stream_id).encode(),
            ))
            .await
            .unwrap();
    };
    let (response, ()) = tokio::join!(client, respond);
    let (status, body) = response.unwrap();
    assert_eq!(status, 200);
    assert!(body.is_empty());
}

#[tokio::test]
async fn rest_unsigned_rejected_through_repeater() {
    let h = boot().await;
    // No signature: the repeater terminates client auth at ingress → 401,
    // and the request never reaches the worker.
    let path = tagged("/api/info", TAG_A);
    let (status, _) = https_request(&h.client_addr, "GET", &path, None, b"")
        .await
        .unwrap();
    assert_eq!(status, 401);
}

#[tokio::test]
async fn health_answered_locally_by_repeater() {
    let h = boot().await;
    let path = tagged("/health", TAG_A);
    let (status, body) = https_request(&h.client_addr, "GET", &path, None, b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    // The repeater answers /health itself (never tunneled) so liveness works
    // even with no worker; it reports its own role and pairing state.
    assert_eq!(v["role"], "repeater");
    assert_eq!(v["tag"], TAG_A);
    assert_eq!(v["paired"], true);
}

#[tokio::test]
async fn health_reports_worker_capabilities() {
    let h = boot().await;
    let path = tagged("/health", TAG_A);
    let (status, body) = https_request(&h.client_addr, "GET", &path, None, b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["worker_version"], crate::version::full());
    let features = v["worker_features"].as_array().expect("features array");
    assert!(features.iter().any(|f| f == "forward"));
    assert!(features.iter().any(|f| f == "ws"));
}

#[tokio::test]
async fn health_and_rest_require_exactly_one_known_valid_tag() {
    let h = boot().await;
    let invalid = [
        "/health",
        "/health?tag=",
        "/health?tag=bad%20tag",
        "/health?tag=worker-a&tag=worker-a",
        "/health?tag=worker-a&%74ag=worker-a",
    ];
    for health_path in invalid {
        let (status, _) = https_request(&h.client_addr, "GET", health_path, None, b"")
            .await
            .unwrap();
        assert_eq!(status, 400, "health accepted {health_path}");

        let rest_path = health_path.replacen("/health", "/api/info", 1);
        let (status, _) = https_request(&h.client_addr, "GET", &rest_path, Some(&h.cb), b"")
            .await
            .unwrap();
        assert_eq!(status, 400, "REST accepted {rest_path}");
    }

    let unknown_health = tagged("/health", "unknown-worker");
    let (status, body) = https_request(&h.client_addr, "GET", &unknown_health, None, b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    let health: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(health["tag"], "unknown-worker");
    assert_eq!(health["paired"], false);
    assert!(health["worker_version"].is_null());
    assert!(health["worker_features"].is_null());

    // A is online throughout: an unknown TAG must wait for its own worker and
    // fail rather than silently falling back to the only registered tunnel.
    let unknown_rest = tagged("/api/info", "unknown-worker");
    let (status, _) = https_request(&h.client_addr, "GET", &unknown_rest, Some(&h.cb), b"")
        .await
        .unwrap();
    assert_eq!(status, 502);

    let mut unknown_ws = connect_ws(&h.client_addr, &h.cb, "unknown-worker").await;
    wait_ws_closed(&mut unknown_ws, "unknown TAG fell back to worker A").await;
}

#[tokio::test]
async fn ws_and_forward_reject_invalid_tags_before_upgrade() {
    let r = boot_repeater().await;
    let suffixes = [
        "",
        "?tag=",
        "?tag=bad%20tag",
        "?tag=worker-a&tag=worker-a",
        "?tag=worker-a&%74ag=worker-a",
    ];
    for endpoint in ["/ws", "/forward"] {
        for suffix in suffixes {
            let path = format!("{endpoint}{suffix}");
            match upgrade_error(&r.client_addr, &path).await {
                tokio_tungstenite::tungstenite::Error::Http(response) => {
                    assert_eq!(response.status(), 400, "upgrade accepted {path}");
                }
                other => panic!("expected an HTTP rejection for {path}, got {other}"),
            }
        }
    }
}

#[tokio::test]
async fn invalid_worker_hellos_fail_closed_without_replacing_incumbent() {
    let r = boot_repeater().await;
    let _incumbent = dial_worker_leg(&r.worker_addr, &r.cb).await;
    wait_paired(&r.client_addr, TAG_A).await;

    let malformed = TunnelFrame::new(KIND_HELLO, 0, b"{not-json".to_vec());
    let invalid_tag = serde_json::json!({
        "proto": PROTO,
        "version": "invalid-tag",
        "tag": "not a legal tag",
        "features": ["ws", "forward"],
    });
    let invalid_tag = TunnelFrame::new(KIND_HELLO, 0, serde_json::to_vec(&invalid_tag).unwrap());

    // Every failure is detected before registry mutation. In particular, a silent
    // legacy worker must not evict a healthy incumbent after the HELLO timeout.
    let attempts = vec![
        dial_worker_leg_raw(&r.worker_addr, &r.cb, None).await,
        dial_worker_leg_raw(
            &r.worker_addr,
            &r.cb,
            Some(WsMessage::Binary(malformed.encode())),
        )
        .await,
        dial_worker_leg_with_proto(&r.worker_addr, &r.cb, TAG_A, PROTO + 1, &["ws", "forward"])
            .await,
        dial_worker_leg_raw(
            &r.worker_addr,
            &r.cb,
            Some(WsMessage::Binary(invalid_tag.encode())),
        )
        .await,
    ];
    for (index, mut attempt) in attempts.into_iter().enumerate() {
        wait_ws_closed(&mut attempt, "invalid worker HELLO was not closed").await;
        let path = tagged("/health", TAG_A);
        let (status, body) = https_request(&r.client_addr, "GET", &path, None, b"")
            .await
            .unwrap();
        assert_eq!(status, 200);
        let health: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            health["paired"], true,
            "failed HELLO {index} unpaired incumbent"
        );
        assert_eq!(
            health["worker_version"], "9.9.9-test",
            "failed HELLO {index} replaced incumbent"
        );
    }
}

#[tokio::test]
async fn worker_without_forward_capability_is_refused() {
    let r = boot_repeater().await;
    let _worker = dial_worker_leg_with_caps(&r.worker_addr, &r.cb, TAG_A, &["ws"]).await;
    wait_paired(&r.client_addr, TAG_A).await;

    match upgrade_error(&r.client_addr, &tagged("/forward", TAG_A)).await {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            assert_eq!(response.status(), 503);
        }
        other => panic!("expected an HTTP rejection, got {other}"),
    }
}

#[tokio::test]
async fn large_upload_chunked_through_repeater() {
    let h = boot().await;
    let upload_dir = tempfile::tempdir().unwrap();
    let dir = upload_dir.path().to_string_lossy().into_owned();

    // Bigger than several BODY_CHUNK (512 KiB) frames so the request body must be
    // split into REQ_BODY chunks and reassembled on the worker — the chunking path.
    let payload: Vec<u8> = (0..BODY_CHUNK * 5 + 12_345)
        .map(|i| (i % 251) as u8)
        .collect();
    let path = tagged(&format!("/api/fs/upload?dir={dir}&name=big.bin"), TAG_A);

    let (status, _) = https_request(&h.client_addr, "POST", &path, Some(&h.cb), &payload)
        .await
        .unwrap();
    assert_eq!(
        status, 204,
        "chunked upload must succeed through the tunnel"
    );

    // The worker wrote the reassembled bytes to its local disk, byte-for-byte.
    let written = std::fs::read(upload_dir.path().join("big.bin")).unwrap();
    assert_eq!(written.len(), payload.len());
    assert_eq!(
        written, payload,
        "reassembled upload must match the original"
    );
}

#[tokio::test]
async fn worker_replacement_closes_idle_client_bridges() {
    // An idle client bridge holds an `Arc<Tunnel>`, so clearing the slot alone
    // would leave it parked on a receiver that never closes. The tunnel's
    // teardown must wake it so the client reconnects at once.
    let r = boot_repeater().await;
    let _first = dial_worker_leg_with_caps(&r.worker_addr, &r.cb, TAG_A, &["ws", "forward"]).await;
    wait_paired(&r.client_addr, TAG_A).await;

    let mut client = connect_forward(&r.client_addr, &r.cb, TAG_A).await;

    let _second = dial_worker_leg(&r.worker_addr, &r.cb).await;

    wait_ws_closed(
        &mut client,
        "replacing the worker must close an idle forward bridge",
    )
    .await;
}

#[tokio::test]
async fn worker_disconnect_closes_idle_client_bridges() {
    let r = boot_repeater().await;
    let first = dial_worker_leg_with_caps(&r.worker_addr, &r.cb, TAG_A, &["ws", "forward"]).await;
    wait_paired(&r.client_addr, TAG_A).await;

    let mut client = connect_forward(&r.client_addr, &r.cb, TAG_A).await;

    drop(first); // the worker's socket dies without a graceful tunnel close

    wait_ws_closed(
        &mut client,
        "losing the worker must close an idle forward bridge",
    )
    .await;
}

#[tokio::test]
async fn replacement_and_disconnect_of_a_do_not_disturb_b() {
    let r = boot_repeater().await;
    let mut first_a = dial_worker_leg(&r.worker_addr, &r.cb).await;
    wait_paired(&r.client_addr, TAG_A).await;
    let worker_b = boot_worker(&r, TAG_B, "worker-b-service").await;

    seed(&worker_b, T1).await;
    worker_b.tasks.inject_chunk(T1, b"b-before").await.unwrap();
    let mut a_forward = connect_forward(&r.client_addr, &r.cb, TAG_A).await;
    let mut b_ws = connect_ws(&r.client_addr, &r.cb, TAG_B).await;
    hello(&mut b_ws, HashMap::new()).await;
    assert_eq!(
        outputs(&read_through_replay(&mut b_ws, T1).await),
        vec![(1, b"b-before".to_vec())]
    );

    // Replace only A. Its old worker and bridge close, while B's existing WS and
    // subsequent REST requests continue to use B's untouched tunnel.
    let second_a = dial_worker_leg(&r.worker_addr, &r.cb).await;
    wait_ws_closed(&mut first_a, "old A was not evicted").await;
    wait_ws_closed(&mut a_forward, "old A bridge was not closed").await;
    worker_b
        .tasks
        .inject_chunk(T1, b"b-after-replacement")
        .await
        .unwrap();
    assert_eq!(
        next_output(&mut b_ws).await,
        (2, b"b-after-replacement".to_vec())
    );
    let info_path = tagged("/api/info", TAG_B);
    let (status, body) = https_request(&r.client_addr, "GET", &info_path, Some(&r.cb), b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<ServiceInfo>(&body).unwrap().name,
        "worker-b-service"
    );

    // A full disconnect is equally local to A's registry entry and streams.
    drop(second_a);
    wait_unpaired(&r.client_addr, TAG_A).await;
    worker_b
        .tasks
        .inject_chunk(T1, b"b-after-disconnect")
        .await
        .unwrap();
    assert_eq!(
        next_output(&mut b_ws).await,
        (3, b"b-after-disconnect".to_vec())
    );
    let (status, body) = https_request(&r.client_addr, "GET", &info_path, Some(&r.cb), b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        serde_json::from_slice::<ServiceInfo>(&body).unwrap().name,
        "worker-b-service"
    );
}

#[tokio::test]
async fn large_download_streamed_through_repeater() {
    let h = boot().await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("big-download.bin");
    // Several RESP_BODY frames: the repeater must relay them lazily and intact.
    let payload: Vec<u8> = (0..BODY_CHUNK * 4 + 7).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &payload).unwrap();

    let uri = tagged(
        &format!("/api/fs/download?path={}", path.to_string_lossy()),
        TAG_A,
    );
    let (status, body) = https_request(&h.client_addr, "GET", &uri, Some(&h.cb), b"")
        .await
        .unwrap();
    assert_eq!(status, 200);
    assert_eq!(
        body.len(),
        payload.len(),
        "streamed download length mismatch"
    );
    assert!(
        body == payload,
        "streamed download must match the worker's file byte-for-byte"
    );
}

#[tokio::test]
async fn newer_worker_evicts_incumbent() {
    // Two raw worker legs against a lone repeater (no auto-reconnecting real
    // worker that would fight the newcomer for the slot). This models a
    // self-upgrade re-exec: the new process dials in while the repeater still
    // holds the old, now-dead tunnel.
    let r = boot_repeater().await;

    // First worker pairs and holds TAG A.
    let mut first = dial_worker_leg(&r.worker_addr, &r.cb).await;
    wait_paired(&r.client_addr, TAG_A).await;

    // A second authenticated worker dials in. Last-writer-wins: it takes the slot
    // and the incumbent is torn down — the newcomer is NOT rejected. This is what
    // lets a re-exec'd host re-pair immediately instead of waiting out the old
    // socket's teardown or the 45s idle timeout.
    let _second = dial_worker_leg(&r.worker_addr, &r.cb).await;

    // The incumbent's socket is closed by the repeater upon eviction.
    wait_ws_closed(
        &mut first,
        "the incumbent worker must be disconnected when evicted",
    )
    .await;

    // The repeater stays paired throughout — now served by the second worker.
    wait_paired(&r.client_addr, TAG_A).await;
}
