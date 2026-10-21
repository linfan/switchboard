//! The **repeater** role: a stable-IP relay that runs no tasks itself.
//!
//! It binds two HTTPS listeners:
//! - **client-facing** (`SWITCHBOARD_ADDR`, `SWITCHBOARD_TOKEN`): identical surface
//!   to a direct worker. `/health` is answered locally; everything else is
//!   forwarded opaquely to the paired worker over the tunnel, so any new REST route
//!   or control message works with no repeater change.
//! - **worker-facing** (`SWITCHBOARD_REPEATER_ADDR`, `SWITCHBOARD_REPEATER_TOKEN`):
//!   a `/repeater` WebSocket a single worker dials in on. Only one worker may be
//!   paired at a time; a second is rejected until the first's tunnel dies.
//!
//! Auth is terminated per hop: the repeater validates the client's `SWB-v1` proof
//! at ingress (its own cert is the channel binding) and authenticates the worker
//! tunnel with `SWITCHBOARD_REPEATER_TOKEN` — **no client credential ever crosses
//! the tunnel**, and the payload it forwards is opaque application bytes.

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use serde_json::json;
use switchboard_shared::{
    auth::{H_MAC, H_NONCE, H_TS},
    now_millis,
    tunnel::{
        ReqHead, RespHead, TunnelFrame, WsOpen, BODY_CHUNK, KIND_PING, KIND_PONG, KIND_REQ_BODY,
        KIND_REQ_END, KIND_REQ_HEAD, KIND_RESP_BODY, KIND_RESP_END, KIND_RESP_HEAD, KIND_RST,
        KIND_WS_BIN, KIND_WS_CLOSE, KIND_WS_OPEN, KIND_WS_TEXT,
    },
};
use tokio::sync::mpsc;

use crate::{auth, config::Config, tls, ws};

/// Outbound (repeater→worker) tunnel channel depth.
const MUX_BUF: usize = 512;
/// Per-stream inbound (worker→repeater) channel depth.
const STREAM_BUF: usize = 256;
/// How long a client request/upgrade waits for a worker to be paired before failing.
const GRACE: Duration = Duration::from_secs(5);
/// Interval between app-level tunnel PINGs.
const HEARTBEAT: Duration = Duration::from_secs(15);
/// Tear the tunnel down (freeing the slot) after this long with no worker frame.
const IDLE_MS: i64 = 45_000;
/// Largest client REST body the repeater buffers to sign-check + forward.
const MAX_BODY: usize = 128 * 1024 * 1024;

/// Request/response headers that must not be forwarded verbatim across the tunnel
/// (auth proofs are terminated here; framing headers are recomputed by hyper).
fn is_stripped_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == H_TS
        || n == H_NONCE
        || n == H_MAC
        || n == "host"
        || n == "content-length"
        || n == "transfer-encoding"
}

/// The one worker↔repeater tunnel: a writer channel plus a stream-id → inbound
/// router so many client interactions multiplex over one WebSocket.
pub struct Tunnel {
    /// Encoded frames destined for the worker (drained by the writer task).
    tx: mpsc::Sender<Vec<u8>>,
    next_stream: AtomicU64,
    routes: StdMutex<HashMap<u64, mpsc::Sender<TunnelFrame>>>,
    /// Fired when a newer worker evicts this tunnel from the single slot, so its
    /// session task tears down at once rather than lingering until the idle
    /// timeout. `notify_one` (not `notify_waiters`) so the signal is not lost if
    /// it races the session reaching its `.notified()` await.
    evicted: tokio::sync::Notify,
}

impl Tunnel {
    fn alloc_stream(&self) -> u64 {
        self.next_stream.fetch_add(1, Ordering::Relaxed)
    }

    /// Register a per-stream inbound receiver; returns it to the caller.
    fn register(&self, id: u64) -> mpsc::Receiver<TunnelFrame> {
        let (tx, rx) = mpsc::channel::<TunnelFrame>(STREAM_BUF);
        self.routes.lock().unwrap().insert(id, tx);
        rx
    }

    fn unregister(&self, id: u64) {
        self.routes.lock().unwrap().remove(&id);
    }

    /// End every stream on this tunnel. Each client bridge holds an `Arc<Tunnel>`,
    /// so the registered senders would otherwise outlive the worker connection
    /// and keep `bridge_client_ws` parked on `rx.recv()` forever — a client that
    /// looks connected but has no peer, until its next write fails. Dropping the
    /// senders wakes every bridge at once so they can close their client socket
    /// and let the client reconnect.
    fn close(&self) {
        self.routes.lock().unwrap().clear();
    }

    /// Send one frame to the worker. `false` if the tunnel writer is gone.
    async fn send(&self, frame: TunnelFrame) -> bool {
        self.tx.send(frame.encode()).await.is_ok()
    }

    /// Best-effort control send: drops the frame when the writer queue is full
    /// instead of stalling the caller (which is the shared demux for PONGs).
    fn send_lossy(&self, kind: u8, stream_id: u64) {
        let _ = self
            .tx
            .try_send(TunnelFrame::control(kind, stream_id).encode());
    }

    /// Deliver an inbound frame to its stream's receiver without ever waiting.
    ///
    /// The demux loop is shared by every multiplexed stream: awaiting here would
    /// let one slow consumer (a stalled terminal client, a target that stopped
    /// reading) freeze the whole tunnel. A full queue therefore resets just that
    /// stream — the client reconnects (`/ws` replays from its cursor, `/forward`
    /// rebuilds per local connection) — and every other stream keeps flowing.
    fn route(&self, frame: TunnelFrame) {
        let id = frame.stream_id;
        let tx = self.routes.lock().unwrap().get(&id).cloned();
        let Some(tx) = tx else { return };
        match tx.try_send(frame) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(frame)) => {
                tracing::warn!(
                    stream = frame.stream_id,
                    kind = frame.kind,
                    "stream queue full; resetting the stream"
                );
                self.send_lossy(KIND_RST, frame.stream_id);
                self.unregister(frame.stream_id);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => self.unregister(id),
        }
    }
}

/// Shared repeater state: auth material + the single tunnel slot.
pub struct RepeaterState {
    config: Config,
    cert_fp: Vec<u8>,
    nonce_cache: auth::ReplayCache,
    /// The one paired worker's tunnel, or `None` when unpaired.
    slot: StdMutex<Option<Arc<Tunnel>>>,
}

impl RepeaterState {
    fn tunnel(&self) -> Option<Arc<Tunnel>> {
        self.slot.lock().unwrap().clone()
    }
}

type Shared = Arc<RepeaterState>;

/// Bind both listeners from the configured addresses, then serve until one exits.
pub async fn run(config: Config) -> Result<()> {
    let repeater_addr = config
        .repeater_addr
        .clone()
        .ok_or_else(|| anyhow!("repeater mode requires SWITCHBOARD_REPEATER_ADDR"))?;

    let client_listener =
        std::net::TcpListener::bind(&config.addr).context("binding SWITCHBOARD_ADDR")?;
    let worker_listener =
        std::net::TcpListener::bind(&repeater_addr).context("binding SWITCHBOARD_REPEATER_ADDR")?;
    tracing::info!(
        client = %client_listener.local_addr()?,
        worker = %worker_listener.local_addr()?,
        "repeater listening (https)"
    );

    serve(config, client_listener, worker_listener).await
}

/// Serve the repeater over two already-bound listeners (both upgraded to HTTPS
/// with one shared self-signed cert). Split out from [`run`] so tests can bind
/// ephemeral `:0` sockets and hand the *live* listeners over — closing the
/// bind-then-rebind window that a "pick a free port, drop, rebind" dance leaves.
pub(crate) async fn serve(
    config: Config,
    client_listener: std::net::TcpListener,
    worker_listener: std::net::TcpListener,
) -> Result<()> {
    let tls_cfg = config
        .tls
        .clone()
        .ok_or_else(|| anyhow!("repeater mode requires TLS (the worker leg is HTTPS/WSS only)"))?;

    rustls::crypto::ring::default_provider()
        .install_default()
        .ok();
    let sans = tls::ensure_cert(&tls_cfg)?;
    tracing::info!(sans = ?sans, "tls certificate ready");
    let cert_fp = tls::leaf_cert_fingerprint(&tls_cfg)?;
    tracing::info!(
        fingerprint = %switchboard_shared::auth::hex(&cert_fp),
        "repeater tls leaf cert SHA-256 (pin this on the client AND provide as the worker's SWITCHBOARD_REPEATER_CA)"
    );

    let state: Shared = Arc::new(RepeaterState {
        config: config.clone(),
        cert_fp,
        nonce_cache: Default::default(),
        slot: StdMutex::new(None),
    });

    let rustls_config =
        axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(tls::server_config(&tls_cfg)?));

    let client_app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(client_ws))
        .route("/forward", get(client_forward))
        .fallback(client_rest)
        .with_state(state.clone());
    let worker_app = Router::new()
        .route("/repeater", get(worker_attach))
        .with_state(state.clone());

    let client_srv = axum_server::from_tcp_rustls(client_listener, rustls_config.clone())
        .serve(client_app.into_make_service());
    let worker_srv = axum_server::from_tcp_rustls(worker_listener, rustls_config)
        .serve(worker_app.into_make_service());

    tokio::select! {
        r = client_srv => r.context("client-facing listener")?,
        r = worker_srv => r.context("worker-facing listener")?,
    }
    Ok(())
}

/// Unauthenticated liveness: always answered locally so it works with no worker.
async fn health(State(st): State<Shared>) -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "role": "repeater",
        "name": st.config.service_name,
        "version": env!("CARGO_PKG_VERSION"),
        "paired": st.tunnel().is_some(),
    }))
}

/// Wait up to [`GRACE`] for a worker to be paired.
async fn wait_for_tunnel(st: &Shared) -> Option<Arc<Tunnel>> {
    let deadline = tokio::time::Instant::now() + GRACE;
    loop {
        if let Some(t) = st.tunnel() {
            return Some(t);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Sends `RST` and unregisters the stream on drop unless disarmed — so a client
/// that disconnects mid-request cancels the worker's in-flight work.
struct StreamGuard {
    tunnel: Arc<Tunnel>,
    id: u64,
    armed: Cell<bool>,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if self.armed.get() {
            let _ = self
                .tunnel
                .tx
                .try_send(TunnelFrame::control(KIND_RST, self.id).encode());
        }
        self.tunnel.unregister(self.id);
    }
}

/// Client-facing REST: verify the `SWB-REST-v1` signature locally, then stream the
/// opaque request to the worker and stream its response back.
async fn client_rest(State(st): State<Shared>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let method = parts.method.as_str().to_string();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| parts.uri.path())
        .to_string();

    // The request body must be buffered whole: SWB-REST-v1 signs SHA-256(body),
    // so the signature cannot be verified without seeing every byte.
    let bytes = match axum::body::to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };

    let header = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok());
    let Some(token) = st.config.token.as_deref() else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    if !auth::verify_signed(
        token.as_bytes(),
        &st.cert_fp,
        &st.nonce_cache,
        &method,
        &path_and_query,
        header(H_TS),
        header(H_NONCE),
        header(H_MAC),
        &bytes,
    ) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let Some(tunnel) = wait_for_tunnel(&st).await else {
        return (StatusCode::BAD_GATEWAY, "no worker paired").into_response();
    };
    let id = tunnel.alloc_stream();
    let mut rx = tunnel.register(id);
    let guard = StreamGuard {
        tunnel: tunnel.clone(),
        id,
        armed: Cell::new(true),
    };

    let headers: Vec<(String, String)> = parts
        .headers
        .iter()
        .filter(|(k, _)| !is_stripped_header(k.as_str()))
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|s| (k.as_str().to_string(), s.to_string()))
        })
        .collect();
    let head = ReqHead {
        method,
        uri: path_and_query,
        headers,
    };
    let head_json = serde_json::to_vec(&head).unwrap_or_default();
    if !tunnel
        .send(TunnelFrame::new(KIND_REQ_HEAD, id, head_json))
        .await
    {
        return (StatusCode::BAD_GATEWAY, "tunnel closed").into_response();
    }
    for chunk in bytes.chunks(BODY_CHUNK) {
        if !tunnel
            .send(TunnelFrame::new(KIND_REQ_BODY, id, chunk.to_vec()))
            .await
        {
            return (StatusCode::BAD_GATEWAY, "tunnel closed").into_response();
        }
    }
    if !tunnel.send(TunnelFrame::control(KIND_REQ_END, id)).await {
        return (StatusCode::BAD_GATEWAY, "tunnel closed").into_response();
    }

    // Await RESP_HEAD, then accumulate RESP_BODY until RESP_END.
    let resp_head = loop {
        match rx.recv().await {
            Some(f) if f.kind == KIND_RESP_HEAD => {
                match serde_json::from_slice::<RespHead>(&f.payload) {
                    Ok(h) => break h,
                    Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
                }
            }
            Some(_) => continue,
            None => return (StatusCode::BAD_GATEWAY, "worker aborted").into_response(),
        }
    };
    // RESP_HEAD is enough to start the response: pull body chunks lazily so a
    // large download is never buffered whole in the repeater. The guard travels
    // with the stream — dropping it early (client disconnect) sends RST and
    // unregisters, stopping the worker's producer at the source.
    let body = Body::from_stream(futures::stream::unfold(
        (rx, guard),
        |(mut rx, guard)| async move {
            loop {
                match rx.recv().await {
                    Some(f) if f.kind == KIND_RESP_BODY => {
                        return Some((
                            Ok::<_, std::io::Error>(Bytes::from(f.payload)),
                            (rx, guard),
                        ));
                    }
                    Some(f) if f.kind == KIND_RESP_END => {
                        guard.armed.set(false); // response complete; no cancel needed
                        return None;
                    }
                    Some(_) => continue,
                    None => {
                        return Some((
                            Err(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "worker aborted the response",
                            )),
                            (rx, guard),
                        ));
                    }
                }
            }
        },
    ));
    build_response(resp_head, body)
}

fn build_response(head: RespHead, body: Body) -> Response {
    let mut builder = Response::builder().status(head.status);
    for (k, v) in &head.headers {
        if !is_stripped_header(k) {
            builder = builder.header(k, v);
        }
    }
    builder
        .body(body)
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// Client-facing `/ws`: authenticate with the client token, then bridge the
/// client socket to a tunneled WS session on the worker.
async fn client_ws(State(st): State<Shared>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| bridge_client_ws(socket, st, "/ws"))
}

async fn client_forward(State(st): State<Shared>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| bridge_client_ws(socket, st, "/forward"))
}

async fn bridge_client_ws(socket: WebSocket, st: Shared, uri: &'static str) {
    let (mut sink, mut stream) = socket.split();
    if !ws::ws_handshake(
        &mut sink,
        &mut stream,
        st.config.token.as_deref(),
        &st.cert_fp,
    )
    .await
    {
        return;
    }

    let Some(tunnel) = wait_for_tunnel(&st).await else {
        tracing::warn!("no worker paired within grace; closing the client socket");
        let _ = sink.send(Message::Close(None)).await;
        return;
    };
    let id = tunnel.alloc_stream();
    let mut rx = tunnel.register(id);
    let guard = StreamGuard {
        tunnel: tunnel.clone(),
        id,
        armed: Cell::new(true),
    };

    let open = serde_json::to_vec(&WsOpen { uri: uri.into() }).unwrap_or_default();
    if !tunnel.send(TunnelFrame::new(KIND_WS_OPEN, id, open)).await {
        return;
    }

    // The client-facing leg crosses the public internet (repeater mode) and is
    // otherwise the one long-lived socket with no liveness check: a dropped NAT
    // entry or a slept host leaves a half-open link whose writes vanish. Ping on
    // the tunnel heartbeat cadence and reap a session that has been silent for
    // three beats in either direction, freeing its worker stream and remote TCP.
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.tick().await;
    let idle_limit = Duration::from_millis(IDLE_MS as u64);
    let mut last_activity = tokio::time::Instant::now();

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if last_activity.elapsed() > idle_limit {
                    tracing::warn!(uri, "client websocket silent past timeout; closing");
                    break;
                }
                if sink.send(Message::Ping(Default::default())).await.is_err() { break; }
            }
            // Worker → client.
            inbound = rx.recv() => match inbound {
                Some(f) => {
                    last_activity = tokio::time::Instant::now();
                    match f.kind {
                        KIND_WS_TEXT => {
                            let t = String::from_utf8_lossy(&f.payload).into_owned();
                            if sink.send(Message::Text(t.into())).await.is_err() { break; }
                        }
                        KIND_WS_BIN => {
                            if sink.send(Message::Binary(f.payload.into())).await.is_err() { break; }
                        }
                        KIND_WS_CLOSE => break,
                        _ => {}
                    }
                }
                None => break, // stream torn down (tunnel died)
            },
            // Client → worker.
            outbound = stream.next() => match outbound {
                Some(Ok(Message::Text(t))) => {
                    last_activity = tokio::time::Instant::now();
                    if !tunnel.send(TunnelFrame::new(KIND_WS_TEXT, id, t.as_bytes().to_vec())).await { break; }
                }
                Some(Ok(Message::Binary(b))) => {
                    last_activity = tokio::time::Instant::now();
                    if !tunnel.send(TunnelFrame::new(KIND_WS_BIN, id, b.to_vec())).await { break; }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => last_activity = tokio::time::Instant::now(), // ping/pong handled by axum
                Some(Err(_)) => break,
            },
        }
    }

    // Tell the worker the session ended; guard's drop sends RST + unregisters.
    // Also close the client socket explicitly: a tunnel teardown wakes us with
    // no inbound close, and the client should learn immediately rather than
    // wait for its own heartbeat to notice.
    let _ = sink.send(Message::Close(None)).await;
    let _ = tunnel.send(TunnelFrame::control(KIND_WS_CLOSE, id)).await;
    drop(guard);
}

/// Worker-facing `/repeater`: authenticate the tunnel token, claim the single
/// slot (reject if occupied), then run the mux writer + demux until it dies.
async fn worker_attach(State(st): State<Shared>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| install_worker(socket, st))
}

async fn install_worker(socket: WebSocket, st: Shared) {
    let (mut sink, mut stream) = socket.split();
    if !ws::ws_handshake(
        &mut sink,
        &mut stream,
        st.config.repeater_token.as_deref(),
        &st.cert_fp,
    )
    .await
    {
        return;
    }

    let (tx, mut mux_rx) = mpsc::channel::<Vec<u8>>(MUX_BUF);
    let tunnel = Arc::new(Tunnel {
        tx,
        next_stream: AtomicU64::new(1),
        routes: StdMutex::new(HashMap::new()),
        evicted: tokio::sync::Notify::new(),
    });

    // Claim the slot with last-writer-wins. A freshly *authenticated* worker is by
    // definition the current one; any incumbent is stale — e.g. the half-open
    // socket a self-upgrade re-exec left behind, which the demux/idle path has not
    // reaped yet. Evict it (signal it to tear down) rather than rejecting the
    // newcomer, so re-pairing is immediate instead of blocked until the old socket
    // is noticed or the 45s idle timeout elapses.
    let previous = {
        let mut slot = st.slot.lock().unwrap();
        slot.replace(tunnel.clone())
    };
    if let Some(old) = previous {
        tracing::warn!("evicting a previously paired worker in favor of a newer one");
        old.evicted.notify_one();
    }
    tracing::info!("worker paired");

    let writer = tokio::spawn(async move {
        while let Some(bytes) = mux_rx.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                break;
            }
        }
    });

    let last_activity = Arc::new(AtomicI64::new(now_millis()));
    let heartbeat = {
        let tunnel = tunnel.clone();
        let last_activity = last_activity.clone();
        async move {
            let mut iv = tokio::time::interval(HEARTBEAT);
            iv.tick().await; // fire immediately once, then on cadence
            loop {
                iv.tick().await;
                if !tunnel.send(TunnelFrame::control(KIND_PING, 0)).await {
                    return;
                }
                if now_millis() - last_activity.load(Ordering::Relaxed) > IDLE_MS {
                    tracing::warn!("worker tunnel idle past timeout; tearing down");
                    return;
                }
            }
        }
    };

    let demux = {
        let tunnel = tunnel.clone();
        let last_activity = last_activity.clone();
        async move {
            while let Some(msg) = stream.next().await {
                let bytes = match msg {
                    Ok(Message::Binary(b)) => b,
                    Ok(Message::Close(_)) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                };
                last_activity.store(now_millis(), Ordering::Relaxed);
                match TunnelFrame::decode(&bytes) {
                    Ok(f) if f.kind == KIND_PING => {
                        tunnel.send_lossy(KIND_PONG, f.stream_id);
                    }
                    Ok(f) if f.kind == KIND_PONG => {}
                    Ok(f) => tunnel.route(f),
                    Err(e) => tracing::warn!(error = %e, "bad tunnel frame from worker"),
                }
            }
        }
    };

    tokio::select! {
        _ = demux => {}
        _ = heartbeat => {}
        // A newer worker took the slot: stop serving this stale tunnel at once.
        _ = tunnel.evicted.notified() => {
            tracing::info!("worker tunnel evicted by a newer worker; tearing down");
        }
    }

    // The worker leg is gone (disconnect, idle timeout, eviction, or writer
    // failure). Wake every bridge now; otherwise each idle `/forward` and `/ws`
    // client would stay "connected" to a dead tunnel until its next write.
    tunnel.close();

    // Free the slot only if it still holds *this* tunnel. After an eviction the
    // slot already points at the newer worker, so this `Arc::ptr_eq` guard leaves
    // it untouched — the incumbent must never clear its successor's slot.
    {
        let mut slot = st.slot.lock().unwrap();
        if slot.as_ref().is_some_and(|t| Arc::ptr_eq(t, &tunnel)) {
            *slot = None;
        }
    }
    writer.abort();
    tracing::info!("worker unpaired");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_full_stream_queue_resets_only_that_stream() {
        let (tx, mut mux_rx) = mpsc::channel(8);
        let tunnel = Tunnel {
            tx,
            next_stream: AtomicU64::new(1),
            routes: StdMutex::new(HashMap::new()),
            evicted: tokio::sync::Notify::new(),
        };

        let stalled = tunnel.alloc_stream();
        let mut stalled_rx = tunnel.register(stalled);
        for _ in 0..STREAM_BUF {
            tunnel.route(TunnelFrame::new(KIND_WS_BIN, stalled, b"x".to_vec()));
        }
        assert!(tunnel.routes.lock().unwrap().contains_key(&stalled));

        // One frame past the queue bound must reset only this stream: no await,
        // no impact on any other stream multiplexed on the same tunnel.
        tunnel.route(TunnelFrame::new(KIND_WS_BIN, stalled, b"x".to_vec()));
        assert!(!tunnel.routes.lock().unwrap().contains_key(&stalled));
        let reset = TunnelFrame::decode(&mux_rx.try_recv().expect("no RST sent")).unwrap();
        assert_eq!((reset.kind, reset.stream_id), (KIND_RST, stalled));

        let healthy = tunnel.alloc_stream();
        let mut healthy_rx = tunnel.register(healthy);
        tunnel.route(TunnelFrame::control(KIND_WS_CLOSE, healthy));
        assert_eq!(healthy_rx.try_recv().unwrap().stream_id, healthy);
        // The drained-but-abandoned stream's receiver still holds its backlog;
        // the router has already forgotten it, so late frames are dropped.
        assert_eq!(stalled_rx.try_recv().unwrap().stream_id, stalled);
    }
}
