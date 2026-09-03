use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use switchboard_shared::{
    auth::{from_hex, hex, random_nonce, ws_mac, AuthMsg, NONCE_LEN},
    port_forward::{PortForwardFrame, MAX_DATA_LEN},
};
use tauri::State;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, watch, Mutex},
    task::JoinHandle,
};
use tokio_tungstenite::{
    connect_async_tls_with_config, tungstenite::protocol::Message, Connector, MaybeTlsStream,
    WebSocketStream,
};

use crate::net::forwarding_tls_config;

const ACCEPT_BUF: usize = 64;
const OUT_BUF: usize = 512;
const STREAM_BUF: usize = 64;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardConfig {
    pub id: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub service_url: String,
    pub token: String,
    pub cert_fingerprint: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardStatus {
    pub id: String,
    pub local_port: u16,
    pub remote_port: u16,
    pub active_connections: usize,
}

#[derive(Default)]
pub struct PortForwardInner {
    forwards: Mutex<HashMap<String, ForwardHandle>>,
}

pub type PortForwardState = Arc<PortForwardInner>;

pub fn new_state() -> PortForwardState {
    Arc::new(PortForwardInner::default())
}

struct ForwardHandle {
    local_port: u16,
    remote_port: u16,
    active_connections: Arc<AtomicUsize>,
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
    let active_connections = Arc::new(AtomicUsize::new(0));
    let task = tokio::spawn(run_listener(
        listener,
        config.clone(),
        stop_rx,
        active_connections.clone(),
    ));
    forwards.insert(
        config.id.clone(),
        ForwardHandle {
            local_port: config.local_port,
            remote_port: config.remote_port,
            active_connections,
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
            active_connections: handle.active_connections.load(Ordering::Relaxed),
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
    if config.token.is_empty() {
        return Err("service token cannot be empty".into());
    }
    forward_url(&config.service_url)?;
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
    active_connections: Arc<AtomicUsize>,
) {
    let (accepted_tx, accepted_rx) = mpsc::channel(ACCEPT_BUF);
    let session = tokio::spawn(run_session_manager(
        accepted_rx,
        config,
        stop_rx.clone(),
        active_connections,
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
                    if accepted_tx.send(stream).await.is_err() {
                        break;
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
    active_connections: Arc<AtomicUsize>,
) {
    loop {
        if *stop_rx.borrow() {
            return;
        }

        let mut connecting = tokio::spawn(connect_forward(config.clone()));
        let socket = loop {
            tokio::select! {
                connected = &mut connecting => match connected {
                    Ok(Ok(socket)) => break Some(socket),
                    Ok(Err(error)) => {
                        tracing::warn!(forward = %config.id, %error, "port-forward connection failed");
                        break None;
                    }
                    Err(error) => {
                        tracing::warn!(forward = %config.id, %error, "port-forward connection task failed");
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
                accepted = accepted_rx.recv() => match accepted {
                    Some(_) => {}
                    None => {
                        connecting.abort();
                        let _ = connecting.await;
                        return;
                    }
                },
            }
        };

        if let Some(socket) = socket {
            run_connected(
                socket,
                &mut accepted_rx,
                &mut stop_rx,
                config.remote_port,
                active_connections.clone(),
            )
            .await;
            continue;
        }

        let retry = tokio::time::sleep(RECONNECT_DELAY);
        tokio::pin!(retry);
        loop {
            tokio::select! {
                _ = &mut retry => break,
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        return;
                    }
                }
                accepted = accepted_rx.recv() => {
                    if accepted.is_none() {
                        return;
                    }
                }
            }
        }
    }
}

async fn run_connected(
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    accepted_rx: &mut mpsc::Receiver<TcpStream>,
    stop_rx: &mut watch::Receiver<bool>,
    remote_port: u16,
    active_connections: Arc<AtomicUsize>,
) {
    let (mut sink, mut source) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<PortForwardFrame>(OUT_BUF);
    let (writer_done_tx, mut writer_done_rx) = oneshot::channel();
    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if sink
                .send(Message::Binary(frame.encode().into()))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = writer_done_tx.send(());
    });

    let (ended_tx, mut ended_rx) = mpsc::channel::<u64>(STREAM_BUF);
    let mut streams = HashMap::<u64, LocalStream>::new();
    let mut next_stream_id = 1u64;

    loop {
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            _ = &mut writer_done_rx => break,
            accepted = accepted_rx.recv() => match accepted {
                Some(stream) => {
                    let stream_id = next_stream_id;
                    next_stream_id = next_stream_id.wrapping_add(1);
                    if stream_id == 0 {
                        break;
                    }
                    let (in_tx, in_rx) = mpsc::channel(STREAM_BUF);
                    let task = tokio::spawn(bridge_local(
                        stream,
                        stream_id,
                        remote_port,
                        in_rx,
                        out_tx.clone(),
                        ended_tx.clone(),
                        active_connections.clone(),
                    ));
                    streams.insert(stream_id, LocalStream { in_tx, task });
                }
                None => break,
            },
            ended = ended_rx.recv() => {
                if let Some(stream_id) = ended {
                    streams.remove(&stream_id);
                }
            }
            incoming = source.next() => match incoming {
                Some(Ok(Message::Binary(bytes))) => {
                    let frame = match PortForwardFrame::decode(&bytes) {
                        Ok(frame) => frame,
                        Err(error) => {
                            tracing::warn!(%error, "invalid port-forward response");
                            continue;
                        }
                    };
                    let stream_id = frame.stream_id();
                    if let Some(stream) = streams.get(&stream_id) {
                        if stream.in_tx.send(frame).await.is_err() {
                            if let Some(stream) = streams.remove(&stream_id) {
                                stream.task.abort();
                            }
                        }
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
        }
    }

    for stream in streams.into_values() {
        stream.task.abort();
    }
    drop(out_tx);
    writer.abort();
    let _ = writer.await;
}

struct LocalStream {
    in_tx: mpsc::Sender<PortForwardFrame>,
    task: JoinHandle<()>,
}

async fn bridge_local(
    stream: TcpStream,
    stream_id: u64,
    remote_port: u16,
    mut remote_rx: mpsc::Receiver<PortForwardFrame>,
    out_tx: mpsc::Sender<PortForwardFrame>,
    ended_tx: mpsc::Sender<u64>,
    active_connections: Arc<AtomicUsize>,
) {
    active_connections.fetch_add(1, Ordering::Relaxed);
    let (mut read, mut write) = stream.into_split();
    let mut buffer = vec![0; MAX_DATA_LEN.min(32 * 1024)];
    let mut opened = false;
    let mut local_finished = false;
    let mut remote_finished = false;
    let mut reset = false;

    if out_tx
        .send(PortForwardFrame::Open {
            stream_id,
            remote_port,
        })
        .await
        .is_err()
    {
        active_connections.fetch_sub(1, Ordering::Relaxed);
        let _ = ended_tx.send(stream_id).await;
        return;
    }

    while !(opened && local_finished && remote_finished) {
        tokio::select! {
            remote = remote_rx.recv() => match remote {
                Some(PortForwardFrame::OpenOk { .. }) => opened = true,
                Some(PortForwardFrame::OpenErr { .. }) | Some(PortForwardFrame::Rst { .. }) => break,
                Some(PortForwardFrame::Data { data, .. }) if opened => {
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
                    if out_tx.send(PortForwardFrame::Fin { stream_id }).await.is_err() {
                        break;
                    }
                    local_finished = true;
                }
                Ok(count) => {
                    if out_tx.send(PortForwardFrame::Data {
                        stream_id,
                        data: buffer[..count].to_vec(),
                    }).await.is_err() {
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
        let _ = out_tx.send(PortForwardFrame::Rst { stream_id }).await;
    }
    active_connections.fetch_sub(1, Ordering::Relaxed);
    let _ = ended_tx.send(stream_id).await;
}

async fn connect_forward(
    config: PortForwardConfig,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, String> {
    let url = forward_url(&config.service_url)?;
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
            .map_err(|error| error.to_string())?;

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
            serde_json::to_string(&auth)
                .map_err(|error| error.to_string())?
                .into(),
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

fn forward_url(base: &str) -> Result<String, String> {
    let trimmed = base.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("http://") {
        return Ok(format!("ws://{rest}/forward"));
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return Ok(format!("wss://{rest}/forward"));
    }
    Err("service URL must start with http:// or https://".into())
}
