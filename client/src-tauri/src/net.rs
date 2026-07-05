//! Native networking bridge.
//!
//! The webview's own `fetch`/`WebSocket` enforce TLS trust and, on macOS, App
//! Transport Security — which makes a self-signed hosting service unreachable
//! from the frontend. We therefore run REST and the WebSocket here in Rust,
//! where we can accept self-signed certificates, and bridge the results back to
//! the frontend (REST as a command return, WS frames as per-connection events).
//!
//! Security note: certificate validation is intentionally disabled, matching
//! the self-signed-cert use case. Traffic is still encrypted but not
//! authenticated, so it is not safe against an active man-in-the-middle.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{
    connect_async_tls_with_config, tungstenite::protocol::Message, Connector,
};

/// Live WebSocket connections, keyed by an id handed back to the frontend.
#[derive(Default)]
pub struct WsInner {
    conns: Mutex<HashMap<u64, mpsc::UnboundedSender<Message>>>,
    next: AtomicU64,
}

pub type WsState = Arc<WsInner>;

pub fn new_state() -> WsState {
    Arc::new(WsInner::default())
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    body: String,
}

/// One-shot REST request (accepts self-signed certs). Returns the status and
/// raw body text; the frontend interprets them exactly as it would a `fetch`.
#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    token: Option<String>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()
        .map_err(|e| e.to_string())?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(method, &url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(b);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(HttpResponse { status, body })
}

/// A frame delivered to the frontend on the per-connection `ws:{id}` event.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum WsEvt {
    Text { data: String },
    /// Base64-encoded binary payload (JSON can't carry raw bytes).
    Binary { data: String },
    Close,
}

/// Open a WebSocket to `url` (accepts self-signed certs) and stream its frames
/// to the frontend as `ws:{id}` events. Returns the connection id.
#[tauri::command]
pub async fn ws_connect(
    app: AppHandle,
    state: State<'_, WsState>,
    url: String,
) -> Result<u64, String> {
    let connector = Connector::NativeTls(
        native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .map_err(|e| e.to_string())?,
    );
    let (stream, _resp) = connect_async_tls_with_config(&url, None, false, Some(connector))
        .await
        .map_err(|e| e.to_string())?;
    let (mut write, mut read) = stream.split();

    let inner = state.inner().clone();
    let id = inner.next.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    inner.conns.lock().await.insert(id, tx);

    // Writer: drain outbound frames until the channel closes (ws_close / drop).
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });

    // Reader: forward inbound frames to the frontend, then signal close.
    let event = format!("ws:{id}");
    let cleanup = inner.clone();
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(t)) => {
                    let _ = app.emit(&event, WsEvt::Text { data: t.to_string() });
                }
                Ok(Message::Binary(b)) => {
                    let _ = app.emit(
                        &event,
                        WsEvt::Binary {
                            data: b64().encode(&b),
                        },
                    );
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        cleanup.conns.lock().await.remove(&id);
        let _ = app.emit(&event, WsEvt::Close);
    });

    Ok(id)
}

/// Send a frame on connection `id`. Exactly one of `text`/`binary_b64` is set.
#[tauri::command]
pub async fn ws_send(
    state: State<'_, WsState>,
    id: u64,
    text: Option<String>,
    binary_b64: Option<String>,
) -> Result<(), String> {
    let msg = if let Some(t) = text {
        Message::Text(t.into())
    } else if let Some(b) = binary_b64 {
        Message::Binary(b64().decode(b).map_err(|e| e.to_string())?.into())
    } else {
        return Ok(());
    };
    if let Some(tx) = state.conns.lock().await.get(&id) {
        tx.send(msg).map_err(|_| "connection closed".to_string())?;
    }
    Ok(())
}

/// Close connection `id` (sends a Close frame; the reader task then cleans up).
#[tauri::command]
pub async fn ws_close(state: State<'_, WsState>, id: u64) -> Result<(), String> {
    if let Some(tx) = state.conns.lock().await.remove(&id) {
        let _ = tx.send(Message::Close(None));
    }
    Ok(())
}
