//! The **worker-repeater-client** role: run tasks locally, but instead of binding
//! a client-facing port, dial *out* to a repeater and serve every client
//! interaction through one reverse tunnel.
//!
//! The worker pins the repeater's leaf cert (SHA-256 of the DER read from
//! `SWITCHBOARD_REPEATER_CA`) so an active MITM on the outbound leg is defeated,
//! then proves knowledge of `SWITCHBOARD_REPEATER_TOKEN` via the channel-bound
//! `SWB-WS-v1` handshake — the token itself never crosses the wire. After that the
//! worker demultiplexes [`switchboard_shared::tunnel`] frames by `stream_id`:
//! `REQ_*` frames are replayed against the local REST router via
//! [`tower::ServiceExt::oneshot`]; `WS_*` frames drive a [`crate::ws::run_session`]
//! exactly as a directly-connected client would. Client auth was already validated
//! at the repeater, so no second handshake runs per stream.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use axum::body::Body;
use axum::http::Request;
use futures::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use rustls::ClientConfig;
use switchboard_shared::{
    auth::{from_hex, hex, random_nonce, ws_mac, AuthMsg, NONCE_LEN},
    tunnel::{
        ReqHead, RespHead, TunnelFrame, WsOpen, BODY_CHUNK, KIND_PING, KIND_PONG, KIND_REQ_BODY,
        KIND_REQ_END, KIND_REQ_HEAD, KIND_RESP_BODY, KIND_RESP_END, KIND_RESP_HEAD, KIND_RST,
        KIND_WS_BIN, KIND_WS_CLOSE, KIND_WS_OPEN, KIND_WS_TEXT,
    },
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::{
    connect_async_tls_with_config, tungstenite::protocol::Message as WsMessage, Connector,
};

use crate::port_forward;
use crate::state::SharedState;
use crate::ws::{run_session, WsIn, WsOut};

mod tls_pin;
use tls_pin::{leaf_der_fingerprint, pinned_client_config};

#[cfg(test)]
mod test;

/// Outbound tunnel channel depth (encoded frames awaiting the socket writer).
/// Bounded so a slow repeater applies backpressure instead of unbounded growth.
const MUX_BUF: usize = 512;
/// Per-WS-session inbound / outbound channel depths (mirror `ws.rs`).
const IN_BUF: usize = 64;
const OUT_BUF: usize = 512;

/// Tear the tunnel down when no frame arrives from the repeater for this long.
/// The repeater heartbeats every 15s, so silence this long means a half-open
/// socket the OS hasn't reported dead (dropped NAT entry, a host that slept
/// through the repeater's FIN) — `read` would otherwise park on it forever and
/// the worker would never redial. Mirrors the repeater's own 45s idle teardown.
const TUNNEL_IDLE: Duration = Duration::from_secs(45);

/// Dial the repeater and serve the tunnel forever, reconnecting with capped
/// exponential backoff when the link drops — including when the link only
/// *silently* dies (no Close, no error, no frames for [`TUNNEL_IDLE`]).
pub async fn run(state: SharedState) -> Result<()> {
    let repeater_addr = state
        .config
        .repeater_addr
        .clone()
        .ok_or_else(|| anyhow!("worker-repeater-client requires SWITCHBOARD_REPEATER_ADDR"))?;
    let token = state
        .config
        .repeater_token
        .clone()
        .ok_or_else(|| anyhow!("worker-repeater-client requires SWITCHBOARD_REPEATER_TOKEN"))?;
    let ca_path = state
        .config
        .repeater_ca
        .clone()
        .ok_or_else(|| anyhow!("worker-repeater-client requires SWITCHBOARD_REPEATER_CA"))?;

    // The pin (and channel binding `cb`) is SHA-256 of the repeater's leaf DER.
    let pin = leaf_der_fingerprint(&ca_path)
        .with_context(|| format!("reading pinned repeater cert from {ca_path}"))?;
    let tls = Arc::new(pinned_client_config(pin.clone()));

    let mut backoff = Duration::from_millis(500);
    let max_backoff = Duration::from_secs(30);
    loop {
        match serve_once(
            &state,
            &repeater_addr,
            token.as_bytes(),
            &pin,
            tls.clone(),
            TUNNEL_IDLE,
        )
        .await
        {
            Ok(Outcome::Dropped) => {
                tracing::info!("repeater tunnel closed; reconnecting");
                backoff = Duration::from_millis(500);
            }
            Ok(Outcome::Shutdown) => {
                // A self-upgrade asked us to unpair: we've already sent a Close so
                // the repeater freed its slot. Do NOT reconnect, and do NOT return
                // — returning would exit `main` and kill the process before the
                // pending re-exec replaces it (leaving the host down with no
                // supervisor). Park until the imminent `execve` takes over.
                tracing::info!("repeater tunnel closed for self-upgrade; awaiting re-exec");
                std::future::pending::<()>().await;
            }
            Err(e) => {
                tracing::warn!(error = %e, backoff_ms = backoff.as_millis(), "repeater tunnel failed; retrying");
            }
        }
        tokio::time::sleep(with_jitter(backoff)).await;
        backoff = (backoff * 2).min(max_backoff);
    }
}

/// Why a single tunnel lifetime ([`serve_once`]) ended.
enum Outcome {
    /// The socket dropped (repeater closed, network error, tunnel died) — the
    /// caller should reconnect with backoff.
    Dropped,
    /// A graceful shutdown was requested via [`AppState::tunnel_shutdown`] (a
    /// self-upgrade re-exec is imminent) — the caller must not reconnect.
    Shutdown,
}

/// One tunnel lifetime: dial, authenticate, then demux until the socket closes,
/// goes silent for `idle_timeout`, or a graceful shutdown is requested.
async fn serve_once(
    state: &SharedState,
    repeater_addr: &str,
    token: &[u8],
    cb: &[u8],
    tls: Arc<ClientConfig>,
    idle_timeout: Duration,
) -> Result<Outcome> {
    let url = format!("wss://{repeater_addr}/repeater");
    let connector = Connector::Rustls(tls);
    let (ws, _resp) = connect_async_tls_with_config(&url, None, false, Some(connector))
        .await
        .with_context(|| format!("dialing {url}"))?;
    let (mut sink, mut stream) = ws.split();

    // SWB-WS-v1 handshake (worker is the "client" proving the tunnel token).
    tunnel_auth(&mut sink, &mut stream, token, cb).await?;
    tracing::info!(%repeater_addr, "repeater tunnel authenticated");

    // Single writer task owns the socket sink; every stream funnels encoded
    // frames through this one bounded channel. When the channel drains (the
    // session tore down on purpose — e.g. a self-upgrade unpair), it sends a
    // courteous WS Close so the repeater frees its worker slot at once instead
    // of waiting to notice a dropped socket.
    let (mux_tx, mut mux_rx) = mpsc::channel::<Vec<u8>>(MUX_BUF);
    let writer = tokio::spawn(async move {
        while let Some(bytes) = mux_rx.recv().await {
            if sink.send(WsMessage::Binary(bytes)).await.is_err() {
                return; // socket already dead; nothing to close gracefully
            }
        }
        let _ = sink.send(WsMessage::Close(None)).await;
        let _ = sink.close().await;
    });

    // App router (no client-facing auth: the repeater already validated it).
    let app = crate::http::router(state.clone(), false);

    let mut streams: HashMap<u64, Stream> = HashMap::new();
    // Race the demux against a graceful-shutdown request: whichever fires first
    // decides the outcome. `notified()` only wakes a live waiter, so a signal
    // raised while we're between connections is simply missed (the re-exec still
    // proceeds; the repeater's last-writer-wins eviction covers that case).
    let outcome = tokio::select! {
        r = demux(&mut stream, &mux_tx, &app, state, &mut streams, idle_timeout) => Demux::Ended(r),
        _ = state.tunnel_shutdown.notified() => Demux::Shutdown,
    };

    // Tear down: abort in-flight work, drop the writer channel (which triggers
    // the graceful Close above), then let that Close flush before we return —
    // bounded, so a wedged socket can't stall us.
    for (_, s) in streams.drain() {
        s.abort();
    }
    drop(mux_tx);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;

    match outcome {
        Demux::Ended(r) => r.map(|()| Outcome::Dropped),
        Demux::Shutdown => Ok(Outcome::Shutdown),
    }
}

/// Internal result of the demux/shutdown race in [`serve_once`].
enum Demux {
    Ended(Result<()>),
    Shutdown,
}

/// Per-stream state on the worker side: either an in-flight REST request being
/// assembled/served, or a live WS session bridged to `run_session`.
enum Stream {
    /// Buffering a request body until `REQ_END`.
    ReqBuffering { head: ReqHead, body: Vec<u8> },
    /// A dispatched request whose response is streaming back.
    ReqInFlight { handle: JoinHandle<()> },
    /// A live WS session: `WsIn` feeds the session, plus its two pump tasks.
    Ws {
        in_tx: mpsc::Sender<WsIn>,
        session: JoinHandle<()>,
        drain: JoinHandle<()>,
    },
    Forward {
        in_tx: mpsc::Sender<Vec<u8>>,
        session: JoinHandle<()>,
        drain: JoinHandle<()>,
    },
}

impl Stream {
    fn abort(self) {
        match self {
            Stream::ReqBuffering { .. } => {}
            Stream::ReqInFlight { handle } => handle.abort(),
            Stream::Ws { session, drain, .. } | Stream::Forward { session, drain, .. } => {
                session.abort();
                drain.abort();
            }
        }
    }
}

/// Read tunnel frames and route them by `stream_id` until the socket ends.
/// `idle_timeout` bounds how long the socket may go without delivering *any*
/// frame: the repeater heartbeats on a fixed cadence, so total silence means
/// the link is dead even though the OS still reports it open.
async fn demux(
    stream: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
              + Unpin),
    mux_tx: &mpsc::Sender<Vec<u8>>,
    app: &axum::Router,
    state: &SharedState,
    streams: &mut HashMap<u64, Stream>,
    idle_timeout: Duration,
) -> Result<()> {
    loop {
        let msg = match tokio::time::timeout(idle_timeout, stream.next()).await {
            Ok(Some(msg)) => msg,
            Ok(None) => break,
            Err(_) => {
                return Err(anyhow!(
                    "no frame from the repeater in {idle_timeout:?}; tunnel is silently dead"
                ))
            }
        };
        let bytes = match msg? {
            WsMessage::Binary(b) => b,
            WsMessage::Close(_) => break,
            _ => continue, // text/ping/pong at the WS layer are not tunnel frames
        };
        let frame = match TunnelFrame::decode(&bytes) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!(error = %e, "bad tunnel frame");
                continue;
            }
        };
        dispatch(frame, mux_tx, app, state, streams).await;
    }
    Ok(())
}

/// Handle one decoded tunnel frame.
async fn dispatch(
    frame: TunnelFrame,
    mux_tx: &mpsc::Sender<Vec<u8>>,
    app: &axum::Router,
    state: &SharedState,
    streams: &mut HashMap<u64, Stream>,
) {
    let id = frame.stream_id;
    match frame.kind {
        KIND_PING => {
            let _ = mux_tx
                .send(TunnelFrame::control(KIND_PONG, id).encode())
                .await;
        }
        KIND_PONG => {}

        KIND_REQ_HEAD => match serde_json::from_slice::<ReqHead>(&frame.payload) {
            Ok(head) => {
                streams.insert(
                    id,
                    Stream::ReqBuffering {
                        head,
                        body: Vec::new(),
                    },
                );
            }
            Err(e) => tracing::warn!(stream = id, error = %e, "bad REQ_HEAD"),
        },
        KIND_REQ_BODY => {
            if let Some(Stream::ReqBuffering { body, .. }) = streams.get_mut(&id) {
                body.extend_from_slice(&frame.payload);
            }
        }
        KIND_REQ_END => {
            if let Some(Stream::ReqBuffering { head, body }) = streams.remove(&id) {
                let handle = spawn_request(id, head, body, app.clone(), mux_tx.clone());
                streams.insert(id, Stream::ReqInFlight { handle });
            }
        }

        KIND_WS_OPEN => match serde_json::from_slice::<WsOpen>(&frame.payload) {
            Ok(open) => {
                let entry = match open.uri.as_str() {
                    "/ws" => Some(open_ws_session(id, state.clone(), mux_tx.clone())),
                    "/forward" => Some(open_forward_session(id, mux_tx.clone())),
                    uri => {
                        tracing::warn!(stream = id, %uri, "unsupported tunneled websocket endpoint");
                        None
                    }
                };
                if let Some(entry) = entry {
                    streams.insert(id, entry);
                } else {
                    let _ = mux_tx
                        .send(TunnelFrame::control(KIND_WS_CLOSE, id).encode())
                        .await;
                }
            }
            Err(e) => tracing::warn!(stream = id, error = %e, "bad WS_OPEN"),
        },
        KIND_WS_TEXT => {
            if let Some(Stream::Ws { in_tx, .. }) = streams.get(&id) {
                if let Ok(t) = String::from_utf8(frame.payload) {
                    let _ = in_tx.send(WsIn::Text(t)).await;
                }
            }
        }
        KIND_WS_BIN => match streams.get(&id) {
            Some(Stream::Ws { in_tx, .. }) => {
                let _ = in_tx.send(WsIn::Binary(frame.payload)).await;
            }
            Some(Stream::Forward { in_tx, .. }) => {
                let _ = in_tx.send(frame.payload).await;
            }
            _ => {}
        },
        KIND_WS_CLOSE => {
            if let Some(Stream::Ws { in_tx, .. }) = streams.get(&id) {
                let _ = in_tx.send(WsIn::Close).await;
            }
            if let Some(s) = streams.remove(&id) {
                s.abort();
            }
        }

        KIND_RST => {
            if let Some(s) = streams.remove(&id) {
                s.abort();
            }
        }
        other => tracing::warn!(
            stream = id,
            kind = other,
            "unexpected tunnel frame on worker"
        ),
    }
}

/// Reconstruct the buffered request, drive it through the local router, and stream
/// the response back as `RESP_HEAD` + chunked `RESP_BODY` + `RESP_END`.
fn spawn_request(
    id: u64,
    head: ReqHead,
    body: Vec<u8>,
    app: axum::Router,
    mux_tx: mpsc::Sender<Vec<u8>>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut builder = Request::builder()
            .method(head.method.as_str())
            .uri(head.uri.as_str());
        for (k, v) in &head.headers {
            builder = builder.header(k, v);
        }
        let req = match builder.body(Body::from(body)) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(stream = id, error = %e, "rebuilding tunneled request failed");
                return;
            }
        };

        use tower::ServiceExt;
        let resp = match app.oneshot(req).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(stream = id, error = %e, "local router error");
                return;
            }
        };

        let status = resp.status().as_u16();
        let headers: Vec<(String, String)> = resp
            .headers()
            .iter()
            .filter_map(|(k, v)| {
                v.to_str()
                    .ok()
                    .map(|s| (k.as_str().to_string(), s.to_string()))
            })
            .collect();
        let head = RespHead { status, headers };
        let head_json = serde_json::to_vec(&head).unwrap_or_default();
        if mux_tx
            .send(TunnelFrame::new(KIND_RESP_HEAD, id, head_json).encode())
            .await
            .is_err()
        {
            return;
        }

        let bytes = match resp.into_body().collect().await {
            Ok(c) => c.to_bytes(),
            Err(e) => {
                tracing::warn!(stream = id, error = %e, "collecting response body failed");
                let _ = mux_tx
                    .send(TunnelFrame::control(KIND_RESP_END, id).encode())
                    .await;
                return;
            }
        };
        for chunk in bytes.chunks(BODY_CHUNK) {
            if mux_tx
                .send(TunnelFrame::new(KIND_RESP_BODY, id, chunk.to_vec()).encode())
                .await
                .is_err()
            {
                return;
            }
        }
        let _ = mux_tx
            .send(TunnelFrame::control(KIND_RESP_END, id).encode())
            .await;
    })
}

/// Start a `run_session` for a new tunneled WS session and wire its `WsOut` back
/// out as `WS_TEXT`/`WS_BIN`, emitting `WS_CLOSE` when the session ends.
fn open_ws_session(id: u64, state: SharedState, mux_tx: mpsc::Sender<Vec<u8>>) -> Stream {
    let (in_tx, in_rx) = mpsc::channel::<WsIn>(IN_BUF);
    let (out_tx, mut out_rx) = mpsc::channel::<WsOut>(OUT_BUF);

    let session = tokio::spawn(run_session(in_rx, out_tx, state));
    let drain = tokio::spawn(async move {
        while let Some(out) = out_rx.recv().await {
            let frame = match out {
                WsOut::Text(t) => TunnelFrame::new(KIND_WS_TEXT, id, t.into_bytes()),
                WsOut::Binary(b) => TunnelFrame::new(KIND_WS_BIN, id, b),
            };
            if mux_tx.send(frame.encode()).await.is_err() {
                return;
            }
        }
        // Session ended (out_tx dropped): tell the repeater the WS is closed.
        let _ = mux_tx
            .send(TunnelFrame::control(KIND_WS_CLOSE, id).encode())
            .await;
    });

    Stream::Ws {
        in_tx,
        session,
        drain,
    }
}

fn open_forward_session(id: u64, mux_tx: mpsc::Sender<Vec<u8>>) -> Stream {
    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>(IN_BUF);
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(OUT_BUF);

    let session = tokio::spawn(port_forward::run_session(in_rx, out_tx));
    let drain = tokio::spawn(async move {
        while let Some(bytes) = out_rx.recv().await {
            if mux_tx
                .send(TunnelFrame::new(KIND_WS_BIN, id, bytes).encode())
                .await
                .is_err()
            {
                return;
            }
        }
        let _ = mux_tx
            .send(TunnelFrame::control(KIND_WS_CLOSE, id).encode())
            .await;
    });

    Stream::Forward {
        in_tx,
        session,
        drain,
    }
}

/// Client side of the `SWB-WS-v1` handshake over the tunnel socket.
async fn tunnel_auth(
    sink: &mut (impl SinkExt<WsMessage, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    stream: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>>
              + Unpin),
    token: &[u8],
    cb: &[u8],
) -> Result<()> {
    // 1. Await the challenge.
    let server_nonce = loop {
        match stream.next().await {
            Some(Ok(WsMessage::Text(t))) => {
                if let Ok(AuthMsg::AuthChallenge { server_nonce }) =
                    serde_json::from_str::<AuthMsg>(t.as_str())
                {
                    break from_hex(&server_nonce)
                        .ok_or_else(|| anyhow!("repeater sent a non-hex server_nonce"))?;
                }
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e).context("reading auth challenge"),
            None => return Err(anyhow!("tunnel closed before auth challenge")),
        }
    };

    // 2. Reply with the channel-bound proof.
    let client_nonce = random_nonce::<NONCE_LEN>();
    let mac = ws_mac(token, &server_nonce, &client_nonce, cb);
    let resp = AuthMsg::AuthResponse {
        client_nonce: hex(&client_nonce),
        mac: hex(&mac),
    };
    sink.send(WsMessage::Text(serde_json::to_string(&resp)?))
        .await
        .context("sending auth response")?;

    // 3. Await the verdict.
    loop {
        match stream.next().await {
            Some(Ok(WsMessage::Text(t))) => match serde_json::from_str::<AuthMsg>(t.as_str()) {
                Ok(AuthMsg::AuthOk) => return Ok(()),
                Ok(AuthMsg::AuthError { message }) => {
                    return Err(anyhow!("repeater rejected tunnel auth: {message}"))
                }
                _ => continue,
            },
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(e).context("reading auth verdict"),
            None => return Err(anyhow!("tunnel closed during auth")),
        }
    }
}

/// Add up to ~25% random jitter so many workers reconnecting at once desynchronize.
fn with_jitter(base: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let extra = (base.as_millis() as u64) * (nanos as u64 % 256) / 1024;
    base + Duration::from_millis(extra)
}
