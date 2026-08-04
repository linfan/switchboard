//! Native networking bridge.
//!
//! The webview's own `fetch`/`WebSocket` enforce TLS trust and, on macOS, App
//! Transport Security — which makes a self-signed hosting service unreachable
//! from the frontend. We therefore run REST and the WebSocket here in Rust.
//!
//! Security model (see the `SWB-v1` protocol in `switchboard-shared::auth`):
//!  1. **Authenticated channel** — TLS is verified by *pinning* the server's leaf
//!     certificate (`SHA-256(leaf_DER)`). The hostname is ignored (so self-signed
//!     works), but an active MITM presenting a different cert is rejected. On the
//!     first probe the pin is unknown, so the verifier runs in *capture* mode
//!     (accept + report the observed fingerprint) for trust-on-first-use.
//!  2. **Channel-bound auth** — the shared token is never sent. The frontend
//!     (`swbauth.ts`) computes all HMAC proofs in JS and hands us only the signed
//!     headers / handshake frames, so this layer never sees the token at all.
//!
//! Thus this bridge is pure transport + pinning: it forwards request bytes and WS
//! frames, and reports captured fingerprints back for TOFU.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use switchboard_shared::auth::{ct_eq, from_hex, hex, sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::protocol::Message, Connector};

/// Live WebSocket connections, keyed by an id handed back to the frontend.
#[derive(Default)]
pub struct WsInner {
    conns: AsyncMutex<HashMap<u64, mpsc::UnboundedSender<Message>>>,
    next: AtomicU64,
}

pub type WsState = Arc<WsInner>;

pub fn new_state() -> WsState {
    Arc::new(WsInner::default())
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Install the ring crypto provider process-wide (idempotent).
fn ensure_crypto() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = ring::default_provider().install_default();
    });
}

/// A rustls verifier that pins the server's leaf certificate by SHA-256 of its
/// DER encoding. With a pin it hard-fails on mismatch (defeating an active MITM);
/// with no pin it accepts and records the fingerprint (trust-on-first-use). The
/// hostname is never checked, so self-signed certs with any SAN work.
#[derive(Debug)]
struct PinnedVerifier {
    /// Expected leaf fingerprint. `None` => capture mode (accept any, record it).
    pin: Option<Vec<u8>>,
    /// The most recently observed leaf fingerprint (for TOFU capture).
    captured: Mutex<Option<Vec<u8>>>,
    supported: WebPkiSupportedAlgorithms,
}

impl PinnedVerifier {
    fn new(pin: Option<Vec<u8>>) -> Arc<Self> {
        Arc::new(Self {
            pin,
            captured: Mutex::new(None),
            supported: ring::default_provider().signature_verification_algorithms,
        })
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = sha256(end_entity.as_ref()).to_vec();
        *self.captured.lock().unwrap() = Some(fp.clone());
        match &self.pin {
            Some(p) if ct_eq(p, &fp) => Ok(ServerCertVerified::assertion()),
            Some(_) => Err(rustls::Error::General(
                "server certificate fingerprint does not match the pinned value".into(),
            )),
            None => Ok(ServerCertVerified::assertion()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}

/// Build a rustls client config using the pinning verifier. Returns the config
/// plus the verifier handle so the caller can read back the captured fingerprint.
fn pinned_config(pin: Option<String>) -> Result<(Arc<ClientConfig>, Arc<PinnedVerifier>), String> {
    ensure_crypto();
    let pin_bytes = match pin {
        Some(h) => Some(from_hex(&h).ok_or_else(|| "invalid pin hex".to_string())?),
        None => None,
    };
    let verifier = PinnedVerifier::new(pin_bytes);
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    Ok((Arc::new(config), verifier))
}

fn reqwest_client(pin: Option<String>) -> Result<(reqwest::Client, Arc<PinnedVerifier>), String> {
    let (config, verifier) = pinned_config(pin)?;
    let client = reqwest::Client::builder()
        // Hand rustls our pinning config; hostname verification is delegated to
        // the verifier (which ignores it), matching the self-signed use case.
        .use_preconfigured_tls((*config).clone())
        .build()
        .map_err(|e| e.to_string())?;
    Ok((client, verifier))
}

/// Hex of the leaf fingerprint the verifier observed on the last handshake, if any.
fn captured_fp(verifier: &PinnedVerifier) -> Option<String> {
    verifier.captured.lock().unwrap().as_deref().map(hex)
}

/// Log any error a Tauri command is about to return to the frontend, then pass
/// it through unchanged. Gives us one guaranteed record of every command failure
/// in the log file regardless of which step produced it.
fn log_err<T>(command: &str, result: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &result {
        tracing::error!(command = %command, error = %e, "client command failed");
    }
    result
}

/// Apply frontend-supplied headers (already includes the SWB signing headers).
fn apply_headers(mut req: reqwest::RequestBuilder, headers: &[(String, String)]) -> reqwest::RequestBuilder {
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    req
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    body: String,
    /// SHA-256 of the server's leaf cert (hex), for trust-on-first-use capture.
    cert_fp: Option<String>,
}

/// One-shot REST request. Certificate trust is enforced by the pin (or captured
/// when `pin` is `None`); `headers` carries the frontend's SWB signing headers.
/// Returns the status, raw body, and the observed cert fingerprint.
#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    pin: Option<String>,
) -> Result<HttpResponse, String> {
    log_err("http_request", async {
        let (client, verifier) = reqwest_client(pin)?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
        let mut req = apply_headers(client.request(method, &url), &headers);
        if let Some(b) = body {
            req = req
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(b);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(|e| e.to_string())?;
        Ok(HttpResponse {
            status,
            body,
            cert_fp: captured_fp(&verifier),
        })
    }
    .await)
}

/// SHA-256 (hex) of a local file's contents. Lets the frontend sign an upload
/// whose bytes live only on the Rust side (the body hash is part of the MAC).
#[tauri::command]
pub async fn hash_file(path: String) -> Result<String, String> {
    log_err("hash_file", async {
        let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
        Ok(hex(&sha256(&bytes)))
    }
    .await)
}

/// Extract a server error message from a JSON body, or fall back to the status.
fn error_message(status: reqwest::StatusCode, body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(String::from))
        .unwrap_or_else(|| format!("HTTP {status}"))
}

/// Download a file from the hosting service to a local `dest` path. Pinned TLS,
/// signed via the frontend's `headers`; binary-safe (no base64 round-trip).
#[tauri::command]
pub async fn download_file(
    url: String,
    headers: Vec<(String, String)>,
    pin: Option<String>,
    dest: String,
) -> Result<(), String> {
    log_err("download_file", async {
        let (client, _) = reqwest_client(pin)?;
        let resp = apply_headers(client.get(&url), &headers)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(error_message(status, &body));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        tokio::fs::write(&dest, &bytes)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await)
}

/// Upload a local file at `src` to the hosting service by POSTing its raw bytes
/// to `url` (which carries the target `?dir=&name=`). Pinned TLS, signed headers.
#[tauri::command]
pub async fn upload_file(
    url: String,
    headers: Vec<(String, String)>,
    pin: Option<String>,
    src: String,
) -> Result<(), String> {
    log_err("upload_file", async {
        let bytes = tokio::fs::read(&src).await.map_err(|e| e.to_string())?;
        let (client, _) = reqwest_client(pin)?;
        let resp = apply_headers(client.post(&url), &headers)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(error_message(status, &body));
        }
        Ok(())
    }
    .await)
}

/// Outer framing tags for the raw bytes streamed to the frontend over the
/// Channel: `[tag][payload]`. Mirrors `tauriSocket.ts`. Raw bytes avoid the
/// base64 + JSON tax the event bus imposed, which used to saturate the webview
/// main thread on a large reconnect replay.
const TAG_TEXT: u8 = 0;
const TAG_BINARY: u8 = 1;
const TAG_CLOSE: u8 = 2;

fn tagged(tag: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + payload.len());
    v.push(tag);
    v.extend_from_slice(payload);
    v
}

/// Open a WebSocket to `url` with pinned TLS and stream its frames to the
/// frontend over `on_frame` as raw bytes. This is a dumb byte pipe: the
/// `SWB-WS-v1` channel-bound handshake is performed by the frontend over these
/// frames (the token never reaches Rust). Returns the connection id (for
/// `ws_send`/`ws_close`).
///
/// A Tauri `Channel` (vs the event bus) both preserves ordering — so interleaved
/// control (text) and data-plane (binary) frames arrive exactly as the server
/// sent them — and carries binary payloads as raw bytes. Its callback is
/// registered on the frontend *before* this command is invoked, so the server's
/// first frame (`auth_challenge`, sent the instant the upgrade completes) can
/// never be dropped.
#[tauri::command]
pub async fn ws_connect(
    state: State<'_, WsState>,
    url: String,
    pin: Option<String>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<u64, String> {
    let (config, _) = pinned_config(pin).map_err(|e| {
        tracing::error!(%url, error = %e, "websocket tls config failed");
        e
    })?;
    let connector = Connector::Rustls(config);
    let (stream, _resp) = connect_async_tls_with_config(&url, None, false, Some(connector))
        .await
        .map_err(|e| {
            let e = e.to_string();
            tracing::warn!(%url, error = %e, "websocket connect failed");
            e
        })?;
    let (mut write, mut read) = stream.split();

    let inner = state.inner().clone();
    let id = inner.next.fetch_add(1, Ordering::Relaxed);
    tracing::info!(%id, %url, "websocket connected");
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    inner.conns.lock().await.insert(id, tx);

    // Writer: drain outbound frames until the channel closes (ws_close / drop).
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Err(e) = write.send(msg).await {
                tracing::warn!(%id, error = %e, "websocket write failed");
                break;
            }
        }
        let _ = write.close().await;
    });

    // Reader: forward inbound frames to the frontend as tagged raw bytes, then
    // signal close and clean up.
    let cleanup = inner.clone();
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            let body = match msg {
                Ok(Message::Text(t)) => tagged(TAG_TEXT, t.as_bytes()),
                Ok(Message::Binary(b)) => tagged(TAG_BINARY, b.as_ref()),
                Ok(Message::Close(_)) => break,
                Err(e) => {
                    tracing::warn!(%id, error = %e, "websocket read error");
                    break;
                }
                _ => continue,
            };
            if on_frame.send(InvokeResponseBody::Raw(body)).is_err() {
                break;
            }
        }
        cleanup.conns.lock().await.remove(&id);
        tracing::info!(%id, "websocket closed");
        let _ = on_frame.send(InvokeResponseBody::Raw(vec![TAG_CLOSE]));
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
    log_err("ws_send", async {
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
    .await)
}

/// Close connection `id` (sends a Close frame; the reader task then cleans up).
#[tauri::command]
pub async fn ws_close(state: State<'_, WsState>, id: u64) -> Result<(), String> {
    if let Some(tx) = state.conns.lock().await.remove(&id) {
        let _ = tx.send(Message::Close(None));
    }
    Ok(())
}
