use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use switchboard_shared::{
    auth::{from_hex, hex, random_nonce, ws_mac, AuthMsg, NONCE_LEN},
    port_forward::{PortForwardFrame, MAX_DATA_LEN},
    tunnel::Tag,
};
use tauri::State;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch, Mutex},
    task::JoinHandle,
};
use tokio_tungstenite::{
    connect_async_tls_with_config, tungstenite, tungstenite::protocol::Message, Connector,
    MaybeTlsStream, WebSocketStream,
};

use crate::net::forwarding_tls_config;

const ACCEPT_BUF: usize = 64;
const OUT_BUF: usize = 512;
const STREAM_BUF: usize = 64;
/// First reconnect delay; doubled per consecutive failure up to the cap.
const RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
/// Bound the TCP/TLS/WS dial plus both auth rounds. A link that accepts the
/// socket but never answers must not leave the session forever "connecting".
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Bound how long a local connection waits for `OpenOk`/`OpenErr`. Covers the
/// server's own 10s remote-connect timeout plus tunnel/RTT headroom.
const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

type LastError = Arc<StdMutex<Option<String>>>;

fn set_error(last_error: &LastError, message: impl Into<String>) {
    *last_error.lock().unwrap() = Some(message.into());
}

fn clear_error(last_error: &LastError) {
    *last_error.lock().unwrap() = None;
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardConfig {
    pub id: String,
    pub local_port: u16,
    pub remote_port: u16,
    /// IP dialed from the hosting worker; loopback mirrors pre-existing rules.
    #[serde(default = "default_remote_host")]
    pub remote_host: String,
    pub service_url: String,
    pub token: String,
    pub tag: Option<Tag>,
    pub cert_fingerprint: Option<String>,
}

fn default_remote_host() -> String {
    switchboard_shared::port_forward::DEFAULT_REMOTE_HOST.into()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardStatus {
    pub id: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub active_connections: usize,
    pub connected: bool,
    pub last_error: Option<String>,
    /// Cumulative application bytes local → remote (the client's upload).
    pub bytes_up: u64,
    /// Cumulative application bytes remote → local (the client's download).
    pub bytes_down: u64,
}

#[derive(Default)]
pub struct PortForwardInner {
    forwards: Mutex<HashMap<String, ForwardHandle>>,
}

pub type PortForwardState = Arc<PortForwardInner>;

pub fn new_state() -> PortForwardState {
    Arc::new(PortForwardInner::default())
}

/// Live counters for one forward. Cloned by reference into the session and each
/// local bridge, so `list_port_forwards` can report them without joining tasks.
#[derive(Clone)]
struct ForwardStats {
    active_connections: Arc<AtomicUsize>,
    connected: Arc<AtomicBool>,
    bytes_up: Arc<AtomicU64>,
    bytes_down: Arc<AtomicU64>,
}

impl ForwardStats {
    fn new() -> Self {
        Self {
            active_connections: Arc::new(AtomicUsize::new(0)),
            connected: Arc::new(AtomicBool::new(false)),
            bytes_up: Arc::new(AtomicU64::new(0)),
            bytes_down: Arc::new(AtomicU64::new(0)),
        }
    }
}

struct ForwardHandle {
    local_port: u16,
    remote_port: u16,
    stats: ForwardStats,
    last_error: LastError,
    stop_tx: watch::Sender<bool>,
    task: JoinHandle<()>,
}

#[tauri::command]
pub async fn start_port_forward(
    state: State<'_, PortForwardState>,
    config: PortForwardConfig,
) -> Result<(), String> {
    validate_config(&config)?;
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, config.local_port))
        .await
        .map_err(|error| format!("cannot listen on 127.0.0.1:{}: {error}", config.local_port))?;

    let mut forwards = state.forwards.lock().await;
    if forwards.contains_key(&config.id) {
        return Err(format!("port forward {} already exists", config.id));
    }

    let (stop_tx, stop_rx) = watch::channel(false);
    let stats = ForwardStats::new();
    let last_error: LastError = Arc::new(StdMutex::new(None));
    let task = tokio::spawn(run_listener(
        listener,
        config.clone(),
        stop_rx,
        stats.clone(),
        last_error.clone(),
    ));
    forwards.insert(
        config.id.clone(),
        ForwardHandle {
            local_port: config.local_port,
            remote_port: config.remote_port,
            stats,
            last_error,
            stop_tx,
            task,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn stop_port_forward(
    state: State<'_, PortForwardState>,
    id: String,
) -> Result<(), String> {
    let handle = state
        .forwards
        .lock()
        .await
        .remove(&id)
        .ok_or_else(|| format!("port forward {id} does not exist"))?;
    let _ = handle.stop_tx.send(true);
    let _ = handle.task.await;
    Ok(())
}

#[tauri::command]
pub async fn list_port_forwards(
    state: State<'_, PortForwardState>,
) -> Result<Vec<PortForwardStatus>, String> {
    Ok(state
        .forwards
        .lock()
        .await
        .iter()
        .map(|(id, handle)| PortForwardStatus {
            id: id.clone(),
            local_port: handle.local_port,
            remote_port: handle.remote_port,
            active_connections: handle.stats.active_connections.load(Ordering::Relaxed),
            connected: handle.stats.connected.load(Ordering::Relaxed),
            last_error: handle.last_error.lock().unwrap().clone(),
            bytes_up: handle.stats.bytes_up.load(Ordering::Relaxed),
            bytes_down: handle.stats.bytes_down.load(Ordering::Relaxed),
        })
        .collect())
}

fn validate_config(config: &PortForwardConfig) -> Result<(), String> {
    if config.id.trim().is_empty() {
        return Err("port forward id cannot be empty".into());
    }
    if config.local_port == 0 || config.remote_port == 0 {
        return Err("local and remote ports must be nonzero".into());
    }
    if config.remote_host.parse::<std::net::IpAddr>().is_err() {
        return Err("remote host must be an IPv4 or IPv6 address".into());
    }
    if config.token.is_empty() {
        return Err("service token cannot be empty".into());
    }
    forward_url(&config.service_url, config.tag.as_ref())?;
    if config.service_url.trim_start().starts_with("https://")
        && config.cert_fingerprint.as_deref().is_none()
    {
        return Err("HTTPS port forwards require a pinned certificate fingerprint".into());
    }
    Ok(())
}

async fn run_listener(
    listener: TcpListener,
    config: PortForwardConfig,
    mut stop_rx: watch::Receiver<bool>,
    stats: ForwardStats,
    last_error: LastError,
) {
    let (accepted_tx, accepted_rx) = mpsc::channel(ACCEPT_BUF);
    let session = tokio::spawn(run_session_manager(
        accepted_rx,
        config,
        stop_rx.clone(),
        stats,
        last_error,
    ));

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    // Keep the loop responsive to stop even while the session
                    // queue is full: waiting to hand this socket over must not
                    // delay shutdown.
                    tokio::select! {
                        changed = stop_rx.changed() => {
                            if changed.is_err() || *stop_rx.borrow() {
                                break;
                            }
                        }
                        sent = accepted_tx.send(stream) => {
                            if sent.is_err() {
                                break;
                            }
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(error = %error, "port-forward listener failed");
                    break;
                }
            },
        }
    }

    drop(accepted_tx);
    session.abort();
    let _ = session.await;
}

async fn run_session_manager(
    mut accepted_rx: mpsc::Receiver<TcpStream>,
    config: PortForwardConfig,
    mut stop_rx: watch::Receiver<bool>,
    stats: ForwardStats,
    last_error: LastError,
) {
    let mut backoff = RECONNECT_DELAY;
    loop {
        if *stop_rx.borrow() || accepted_rx.is_closed() {
            return;
        }

        let connect_config = config.clone();
        let mut connecting = tokio::spawn(async move {
            match tokio::time::timeout(CONNECT_TIMEOUT, connect_forward(connect_config)).await {
                Ok(result) => result,
                Err(_) => Err(format!(
                    "connect timed out after {}s",
                    CONNECT_TIMEOUT.as_secs()
                )),
            }
        });
        let socket = loop {
            tokio::select! {
                connected = &mut connecting => match connected {
                    Ok(Ok(socket)) => break Some(socket),
                    Ok(Err(error)) => {
                        set_error(&last_error, error.clone());
                        tracing::warn!(forward = %config.id, %error, "port-forward connection failed");
                        break None;
                    }
                    Err(error) => {
                        let message = format!("connection task failed: {error}");
                        set_error(&last_error, message.clone());
                        tracing::warn!(forward = %config.id, %message);
                        break None;
                    }
                },
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        connecting.abort();
                        let _ = connecting.await;
                        return;
                    }
                }
                // Local connections are deliberately NOT drained here: leaving
                // them in the bounded queue (and the kernel backlog) lets them
                // be served once the tunnel comes up, instead of being reset
                // during every startup/reconnect window.
            }
        };

        if let Some(socket) = socket {
            stats.connected.store(true, Ordering::Relaxed);
            clear_error(&last_error);
            backoff = RECONNECT_DELAY;
            tracing::info!(forward = %config.id, "port-forward link connected");
            run_connected(
                socket,
                &mut accepted_rx,
                &mut stop_rx,
                &config.remote_host,
                config.remote_port,
                stats.clone(),
                last_error.clone(),
            )
            .await;
            stats.connected.store(false, Ordering::Relaxed);
            tracing::info!(forward = %config.id, "port-forward link disconnected");
            continue;
        }

        let wait = with_jitter(backoff);
        tracing::warn!(
            forward = %config.id,
            retry_in_ms = wait.as_millis(),
            "port-forward link down; reconnecting"
        );
        let retry = tokio::time::sleep(wait);
        tokio::pin!(retry);
        loop {
            tokio::select! {
                _ = &mut retry => break,
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        return;
                    }
                }
            }
        }
        backoff = (backoff * 2).min(MAX_RECONNECT_DELAY);
    }
}

fn with_jitter(base: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let extra = (base.as_millis() as u64) * (nanos as u64 % 256) / 1024;
    base + Duration::from_millis(extra)
}

/// How often the forward link sends a WS Ping.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// Tear the forward link down after this long without any inbound frame. The
/// repeater pings on the same cadence, so three missed beats mean a half-open
/// socket the OS still reports as open.
const LINK_IDLE: Duration = Duration::from_secs(45);

/// What the writer task puts on the wire: either a port-forward frame or a
/// protocol-level Ping used purely to detect a dead link.
enum Outbound {
    Frame(PortForwardFrame),
    Ping,
}

/// The link-side channels one local bridge writes through: frames to the
/// socket writer, and its own id to the session when the bridge finishes.
struct StreamOut {
    out_tx: mpsc::Sender<Outbound>,
    ended_tx: mpsc::Sender<u64>,
}

async fn run_connected(
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    accepted_rx: &mut mpsc::Receiver<TcpStream>,
    stop_rx: &mut watch::Receiver<bool>,
    remote_host: &str,
    remote_port: u16,
    stats: ForwardStats,
    last_error: LastError,
) {
    let (mut sink, mut source) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Outbound>(OUT_BUF);
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel();
    let writer = tokio::spawn(async move {
        while let Some(out) = out_rx.recv().await {
            let message = match out {
                Outbound::Frame(frame) => Message::Binary(frame.encode()),
                Outbound::Ping => Message::Ping(Default::default()),
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
        let _ = writer_done_tx.send(());
    });

    let (ended_tx, mut ended_rx) = mpsc::channel::<u64>(STREAM_BUF);
    let mut streams = HashMap::<u64, LocalStream>::new();
    let mut next_stream_id = 1u64;
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await; // burn the immediate first tick; then every HEARTBEAT
    let mut last_rx = tokio::time::Instant::now();

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            _ = &mut writer_done_rx => break,
            _ = heartbeat.tick() => {
                if last_rx.elapsed() > LINK_IDLE {
                    tracing::warn!(
                        forward = remote_port,
                        "forward link silent past timeout; reconnecting"
                    );
                    break;
                }
                if out_tx.send(Outbound::Ping).await.is_err() {
                    break;
                }
            }
            accepted = accepted_rx.recv() => match accepted {
                Some(stream) => {
                    let stream_id = next_stream_id;
                    next_stream_id = next_stream_id.wrapping_add(1);
                    if stream_id == 0 {
                        break;
                    }
                    let (in_tx, in_rx) = mpsc::channel(STREAM_BUF);
                    stats.active_connections.fetch_add(1, Ordering::Relaxed);
                    let out = StreamOut {
                        out_tx: out_tx.clone(),
                        ended_tx: ended_tx.clone(),
                    };
                    let task = tokio::spawn(bridge_local(
                        stream,
                        stream_id,
                        (remote_host.to_string(), remote_port),
                        in_rx,
                        out,
                        stats.clone(),
                        last_error.clone(),
                    ));
                    streams.insert(stream_id, LocalStream { in_tx, task });
                }
                None => break,
            },
            ended = ended_rx.recv() => {
                if let Some(stream_id) = ended {
                    if streams.remove(&stream_id).is_some() {
                        stats.active_connections.fetch_sub(1, Ordering::Relaxed);
                    }
                }
            }
            incoming = source.next() => match incoming {
                Some(Ok(message)) => {
                    // Any inbound frame — including Pong — proves the link alive.
                    last_rx = tokio::time::Instant::now();
                    match message {
                        Message::Binary(bytes) => {
                            let frame = match PortForwardFrame::decode(&bytes) {
                                Ok(frame) => frame,
                                Err(error) => {
                                    tracing::warn!(%error, "invalid port-forward response");
                                    continue;
                                }
                            };
                            let stream_id = frame.stream_id();
                            if matches!(frame, PortForwardFrame::Rst { .. }) {
                                // A reset must be actionable even while the
                                // bridge is blocked writing to a local app that
                                // stopped reading; abort instead of queueing.
                                if let Some(stream) = streams.remove(&stream_id) {
                                    stream.task.abort();
                                    stats.active_connections.fetch_sub(1, Ordering::Relaxed);
                                }
                                continue;
                            }
                            if let Some(stream) = streams.get(&stream_id) {
                                if stream.in_tx.send(frame).await.is_err() {
                                    if let Some(stream) = streams.remove(&stream_id) {
                                        stream.task.abort();
                                        stats.active_connections.fetch_sub(1, Ordering::Relaxed);
                                    }
                                }
                            }
                        }
                        Message::Close(_) => break,
                        _ => {}
                    }
                }
                None | Some(Err(_)) => break,
            },
        }
    }

    // Every stream still in the map is owned by this incarnation of the
    // connection; aborting them skips `bridge_local`'s tail, so release their
    // slots here — the counter must return to zero for the next reconnect.
    stats
        .active_connections
        .fetch_sub(streams.len(), Ordering::Relaxed);
    streams.clear();
    drop(out_tx);
    writer.abort();
    let _ = writer.await;
}

struct LocalStream {
    in_tx: mpsc::Sender<PortForwardFrame>,
    task: JoinHandle<()>,
}

impl Drop for LocalStream {
    fn drop(&mut self) {
        // Also covers an abrupt teardown of run_connected (stop, session abort):
        // a bridge blocked in `write_all` must not keep its local socket alive.
        self.task.abort();
    }
}

async fn bridge_local(
    stream: TcpStream,
    stream_id: u64,
    remote: (String, u16),
    mut remote_rx: mpsc::Receiver<PortForwardFrame>,
    out: StreamOut,
    stats: ForwardStats,
    last_error: LastError,
) {
    let (remote_host, remote_port) = remote;
    let (mut read, mut write) = stream.into_split();
    let mut buffer = vec![0; MAX_DATA_LEN.min(32 * 1024)];
    let mut opened = false;
    let mut local_finished = false;
    let mut remote_finished = false;
    let mut reset = false;

    // Omit the default so an older worker that only knows `[port]` still serves
    // ordinary loopback rules.
    let remote_host = (remote_host != switchboard_shared::port_forward::DEFAULT_REMOTE_HOST)
        .then_some(remote_host);

    if out
        .out_tx
        .send(Outbound::Frame(PortForwardFrame::Open {
            stream_id,
            remote_port,
            remote_host,
        }))
        .await
        .is_err()
    {
        let _ = out.ended_tx.send(stream_id).await;
        return;
    }

    let open_timeout = tokio::time::sleep(OPEN_TIMEOUT);
    tokio::pin!(open_timeout);

    while !(opened && local_finished && remote_finished) {
        tokio::select! {
            _ = &mut open_timeout, if !opened => {
                let message = format!("open timed out after {}s", OPEN_TIMEOUT.as_secs());
                set_error(&last_error, message.clone());
                tracing::warn!(stream = stream_id, %message, "resetting the local connection");
                let _ = out.out_tx
                    .send(Outbound::Frame(PortForwardFrame::Rst { stream_id }))
                    .await;
                break;
            }
            remote = remote_rx.recv() => match remote {
                Some(PortForwardFrame::OpenOk { .. }) => {
                    opened = true;
                    clear_error(&last_error);
                }
                Some(PortForwardFrame::OpenErr { message, .. }) => {
                    set_error(&last_error, message);
                    break;
                }
                Some(PortForwardFrame::Rst { .. }) => break,
                Some(PortForwardFrame::Data { data, .. }) if opened => {
                    stats.bytes_down.fetch_add(data.len() as u64, Ordering::Relaxed);
                    if write.write_all(&data).await.is_err() {
                        reset = true;
                        break;
                    }
                }
                Some(PortForwardFrame::Fin { .. }) if opened => {
                    if write.shutdown().await.is_err() {
                        reset = true;
                        break;
                    }
                    remote_finished = true;
                }
                Some(_) => {}
                None => break,
            },
            local = read.read(&mut buffer), if opened && !local_finished => match local {
                Ok(0) => {
                    if out.out_tx
                        .send(Outbound::Frame(PortForwardFrame::Fin { stream_id }))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    local_finished = true;
                }
                Ok(count) => {
                    stats.bytes_up.fetch_add(count as u64, Ordering::Relaxed);
                    if out.out_tx
                        .send(Outbound::Frame(PortForwardFrame::Data {
                            stream_id,
                            data: buffer[..count].to_vec(),
                        }))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    reset = true;
                    break;
                }
            },
        }
    }

    if reset {
        let _ = out
            .out_tx
            .send(Outbound::Frame(PortForwardFrame::Rst { stream_id }))
            .await;
    }
    let _ = out.ended_tx.send(stream_id).await;
}

async fn connect_forward(
    config: PortForwardConfig,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, String> {
    let url = forward_url(&config.service_url, config.tag.as_ref())?;
    let channel_binding = match config.cert_fingerprint.as_deref() {
        Some(fingerprint) => {
            from_hex(fingerprint).ok_or_else(|| "invalid certificate fingerprint".to_string())?
        }
        None => Vec::new(),
    };
    let tls = forwarding_tls_config(config.cert_fingerprint.clone())?;
    let (mut socket, _) =
        connect_async_tls_with_config(&url, None, false, Some(Connector::Rustls(tls)))
            .await
            .map_err(|error| match error {
                tungstenite::Error::Http(response) => {
                    let status = response.status();
                    let body = response
                        .body()
                        .as_deref()
                        .map(String::from_utf8_lossy)
                        .unwrap_or_default();
                    if body.is_empty() {
                        format!("server refused the forward link: HTTP {status}")
                    } else {
                        format!("server refused the forward link: HTTP {status}: {body}")
                    }
                }
                other => other.to_string(),
            })?;

    let server_nonce = loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<AuthMsg>(text.as_str()) {
                Ok(AuthMsg::AuthChallenge { server_nonce }) => {
                    break from_hex(&server_nonce).ok_or_else(|| {
                        "server sent an invalid authentication nonce".to_string()
                    })?;
                }
                Ok(AuthMsg::AuthError { message }) => return Err(message),
                _ => {}
            },
            Some(Ok(Message::Close(_))) | None => {
                return Err("server closed during authentication".into())
            }
            Some(Err(error)) => return Err(error.to_string()),
            Some(Ok(_)) => {}
        }
    };
    let client_nonce = random_nonce::<NONCE_LEN>();
    let auth = AuthMsg::AuthResponse {
        client_nonce: hex(&client_nonce),
        mac: hex(&ws_mac(
            config.token.as_bytes(),
            &server_nonce,
            &client_nonce,
            &channel_binding,
        )),
    };
    socket
        .send(Message::Text(
            serde_json::to_string(&auth).map_err(|error| error.to_string())?,
        ))
        .await
        .map_err(|error| error.to_string())?;

    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => match serde_json::from_str::<AuthMsg>(text.as_str()) {
                Ok(AuthMsg::AuthOk) => return Ok(socket),
                Ok(AuthMsg::AuthError { message }) => return Err(message),
                _ => {}
            },
            Some(Ok(Message::Close(_))) | None => {
                return Err("server closed during authentication".into())
            }
            Some(Err(error)) => return Err(error.to_string()),
            Some(Ok(_)) => {}
        }
    }
}

fn forward_url(base: &str, tag: Option<&Tag>) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    let url = if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}/forward")
    } else if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}/forward")
    } else {
        return Err("service URL must start with http:// or https://".into());
    };
    Ok(match tag {
        Some(tag) => format!("{url}?tag={tag}"),
        None => url,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use futures_util::{SinkExt, StreamExt};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::{mpsc, oneshot, watch};
    use tokio_tungstenite::tungstenite::protocol::Message;

    use super::{forward_url, run_connected, validate_config, with_jitter, ForwardStats};
    use switchboard_shared::port_forward::PortForwardFrame;
    use switchboard_shared::tunnel::Tag;

    #[test]
    fn forward_urls_carry_an_optional_tag() {
        assert_eq!(
            forward_url("http://127.0.0.1:8787/", None).unwrap(),
            "ws://127.0.0.1:8787/forward"
        );
        assert_eq!(
            forward_url("https://worker.test", None).unwrap(),
            "wss://worker.test/forward"
        );
        let tag: Tag = serde_json::from_str("\"worker_A-1\"").unwrap();
        assert_eq!(
            forward_url("https://worker.test/", Some(&tag)).unwrap(),
            "wss://worker.test/forward?tag=worker_A-1"
        );
        assert!(serde_json::from_str::<Tag>("\"bad.tag\"").is_err());
    }

    #[test]
    fn jitter_adds_at_most_a_quarter() {
        for base in [Duration::from_secs(1), Duration::from_secs(30)] {
            let delay = with_jitter(base);
            assert!(delay >= base && delay <= base + base / 4);
        }
    }

    #[test]
    fn rejects_non_ip_remote_hosts() {
        let config = super::PortForwardConfig {
            id: "f1".into(),
            local_port: 15_432,
            remote_port: 5432,
            remote_host: "db.internal".into(),
            service_url: "http://127.0.0.1:8787".into(),
            token: "t".into(),
            tag: None,
            cert_fingerprint: None,
        };
        assert!(validate_config(&config).is_err());
        assert!(validate_config(&super::PortForwardConfig {
            remote_host: "127.0.0.1".into(),
            ..config.clone()
        })
        .is_ok());
        assert!(validate_config(&super::PortForwardConfig {
            remote_host: "::1".into(),
            ..config
        })
        .is_ok());
    }

    async fn wait_for(counter: &AtomicUsize, expected: usize) {
        for _ in 0..200 {
            if counter.load(Ordering::Relaxed) == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "active connection count stuck at {} (expected {expected})",
            counter.load(Ordering::Relaxed)
        );
    }

    /// Losing the WS aborts every `bridge_local` task; the counter must still
    /// return to zero so the next reconnect starts clean.
    #[tokio::test]
    async fn aborting_the_link_releases_every_active_connection() {
        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_addr = ws_listener.local_addr().unwrap();
        let (close_tx, close_rx) = oneshot::channel::<()>();
        let server = tokio::spawn(async move {
            let (tcp, _) = ws_listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let _ = close_rx.await;
            let _ = ws.close(None).await;
        });

        let local_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_port = local_listener.local_addr().unwrap().port();
        let (accepted_tx, mut accepted_rx) = mpsc::channel(8);
        let acceptor = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = local_listener.accept().await else {
                    break;
                };
                if accepted_tx.send(stream).await.is_err() {
                    break;
                }
            }
        });

        let (stop_tx, mut stop_rx) = watch::channel(false);
        let stats = ForwardStats::new();
        let counter = stats.active_connections.clone();
        let last_error = Arc::new(std::sync::Mutex::new(None));
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{ws_addr}"))
            .await
            .unwrap();
        let session = tokio::spawn(async move {
            run_connected(
                socket,
                &mut accepted_rx,
                &mut stop_rx,
                "127.0.0.1",
                1,
                stats,
                last_error,
            )
            .await;
        });

        let mut clients = Vec::new();
        for _ in 0..3 {
            clients.push(TcpStream::connect(("127.0.0.1", local_port)).await.unwrap());
        }
        wait_for(&counter, 3).await;

        // The peer closes the WS: run_connected aborts the bridges instead of
        // letting them finish, which used to strand their counter increments.
        close_tx.send(()).unwrap();
        session.await.unwrap();
        assert_eq!(counter.load(Ordering::Relaxed), 0);

        drop(stop_tx);
        drop(clients);
        acceptor.abort();
        server.await.unwrap();
    }

    /// Bytes written by the local app and bytes delivered back to it are both
    /// counted, which is what the status page diffs into up/down rates.
    #[tokio::test]
    async fn counts_forwarded_bytes_in_both_directions() {
        let ws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ws_addr = ws_listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = ws_listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            while let Some(message) = ws.next().await {
                let Ok(Message::Binary(bytes)) = message else {
                    break;
                };
                match PortForwardFrame::decode(&bytes).unwrap() {
                    PortForwardFrame::Open { stream_id, .. } => {
                        let reply = PortForwardFrame::OpenOk { stream_id }.encode();
                        ws.send(Message::Binary(reply)).await.unwrap();
                    }
                    PortForwardFrame::Data { stream_id, data } if data == b"hello" => {
                        let reply = PortForwardFrame::Data {
                            stream_id,
                            data: b"pong".to_vec(),
                        }
                        .encode();
                        ws.send(Message::Binary(reply)).await.unwrap();
                    }
                    _ => {}
                }
            }
        });

        let local_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = local_listener.local_addr().unwrap();
        let (accepted_tx, mut accepted_rx) = mpsc::channel(8);
        // Keep `accepted_tx` alive: a closed channel makes run_connected tear
        // everything down, and the acceptor task exits after one connection.
        let accept_tx = accepted_tx.clone();
        let acceptor = tokio::spawn(async move {
            let (stream, _) = local_listener.accept().await.unwrap();
            let _ = accept_tx.send(stream).await;
        });

        let (stop_tx, mut stop_rx) = watch::channel(false);
        let stats = ForwardStats::new();
        let bytes_up = stats.bytes_up.clone();
        let bytes_down = stats.bytes_down.clone();
        let last_error = Arc::new(std::sync::Mutex::new(None));
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{ws_addr}"))
            .await
            .unwrap();
        let session = tokio::spawn(async move {
            run_connected(
                socket,
                &mut accepted_rx,
                &mut stop_rx,
                "127.0.0.1",
                1,
                stats,
                last_error,
            )
            .await;
        });

        let mut client = TcpStream::connect(local_addr).await.unwrap();
        client.write_all(b"hello").await.unwrap();
        let mut reply = [0u8; 4];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"pong");

        for _ in 0..200 {
            if bytes_up.load(Ordering::Relaxed) == 5 && bytes_down.load(Ordering::Relaxed) == 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(bytes_up.load(Ordering::Relaxed), 5);
        assert_eq!(bytes_down.load(Ordering::Relaxed), 4);

        let _ = stop_tx.send(true);
        session.await.unwrap();
        drop(client);
        acceptor.abort();
        server.await.unwrap();
    }
}
