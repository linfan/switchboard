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
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
    ring, verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::Serialize;
use switchboard_shared::auth::{ct_eq, from_hex, hex, sha256};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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

/// Cancel flags for in-flight byte transfers, keyed by the id the frontend
/// allocated for them. The id comes from the frontend because a transfer's own
/// `invoke` only resolves when it is over — a cancel has to reach us while that
/// call is still pending.
#[derive(Default)]
pub struct TransferInner {
    flags: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

pub type TransferState = Arc<TransferInner>;

pub fn new_transfer_state() -> TransferState {
    Arc::new(TransferInner::default())
}

impl TransferInner {
    /// The flag a transfer polls, creating it if this is the first mention of
    /// `id`. A `cancel_transfer` that arrives before the transfer registers
    /// inserts an already-set flag, which the transfer then observes at once.
    fn flag(&self, id: u64) -> Arc<AtomicBool> {
        self.flags.lock().unwrap().entry(id).or_default().clone()
    }

    fn forget(&self, id: u64) {
        self.flags.lock().unwrap().remove(&id);
    }
}

/// Ask the transfer with this id to stop. Its streaming loop notices between
/// chunks and unwinds; the command then reports cancellation rather than an error.
#[tauri::command]
pub async fn cancel_transfer(state: State<'_, TransferState>, id: u64) -> Result<(), String> {
    state.flag(id).store(true, Ordering::Relaxed);
    Ok(())
}

/// One progress tick for a byte transfer. `total` is absent when the size isn't
/// known up front (a download whose response carried no `Content-Length`).
#[derive(Serialize)]
pub struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Pushes {@link Progress} to the frontend, coalescing ticks so a fast transfer
/// can't flood the webview with a render per chunk: after the opening tick only a
/// whole-percent change or `MIN_GAP` of silence sends another. The final tick is
/// always sent so the bar lands exactly on 100%.
struct ProgressEmitter {
    channel: Channel<Progress>,
    total: Option<u64>,
    done: u64,
    sent_at: Instant,
    sent_pct: Option<u64>,
}

impl ProgressEmitter {
    const MIN_GAP: Duration = Duration::from_millis(100);

    fn new(channel: Channel<Progress>, total: Option<u64>) -> Self {
        let mut me = Self {
            channel,
            total,
            done: 0,
            sent_at: Instant::now(),
            sent_pct: None,
        };
        me.send();
        me
    }

    fn advance(&mut self, bytes: u64) {
        self.done += bytes;
        let pct = self.percent();
        if pct != self.sent_pct || self.sent_at.elapsed() >= Self::MIN_GAP {
            self.send();
        }
    }

    /// Report the transfer as complete, so the frontend never leaves a bar shy of
    /// its total because the last tick was coalesced away.
    fn finish(&mut self) {
        self.send();
    }

    fn percent(&self) -> Option<u64> {
        match self.total {
            Some(t) if t > 0 => Some(self.done * 100 / t),
            _ => None,
        }
    }

    fn send(&mut self) {
        let _ = self.channel.send(Progress {
            done: self.done,
            total: self.total,
        });
        self.sent_at = Instant::now();
        self.sent_pct = self.percent();
    }
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

pub(crate) fn forwarding_tls_config(pin: Option<String>) -> Result<Arc<ClientConfig>, String> {
    pinned_config(pin).map(|(config, _)| config)
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
fn apply_headers(
    mut req: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> reqwest::RequestBuilder {
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
    log_err(
        "http_request",
        async {
            let (client, verifier) = reqwest_client(pin)?;
            let method =
                reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
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
        .await,
    )
}

/// SHA-256 (hex) of a local file's contents. Lets the frontend sign an upload
/// whose bytes live only on the Rust side (the body hash is part of the MAC).
#[tauri::command]
pub async fn hash_file(path: String) -> Result<String, String> {
    log_err(
        "hash_file",
        async {
            let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
            Ok(hex(&sha256(&bytes)))
        }
        .await,
    )
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
///
/// The bytes stream straight to disk, reporting progress on `on_progress`, and the
/// loop polls the `transfer_id` cancel flag between chunks. Returns whether the
/// file was written: `false` means the user cancelled, which is not an error, and
/// leaves no partial file behind.
#[tauri::command]
pub async fn download_file(
    state: State<'_, TransferState>,
    url: String,
    headers: Vec<(String, String)>,
    pin: Option<String>,
    dest: String,
    transfer_id: u64,
    on_progress: Channel<Progress>,
) -> Result<bool, String> {
    let cancel = state.flag(transfer_id);
    let result = log_err(
        "download_file",
        async {
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

            let mut progress = ProgressEmitter::new(on_progress, resp.content_length());
            let mut file = tokio::fs::File::create(&dest)
                .await
                .map_err(|e| e.to_string())?;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                if cancel.load(Ordering::Relaxed) {
                    drop(file);
                    // A truncated file is worse than none: the user asked to stop.
                    let _ = tokio::fs::remove_file(&dest).await;
                    return Ok(false);
                }
                let chunk = chunk.map_err(|e| e.to_string())?;
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
                progress.advance(chunk.len() as u64);
            }
            file.flush().await.map_err(|e| e.to_string())?;
            progress.finish();
            Ok(true)
        }
        .await,
    );
    state.forget(transfer_id);
    result
}

/// Where downloaded media previews live: `<app cache dir>/preview`. One file per
/// open preview tab, named by the frontend's cache key.
fn preview_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("preview"))
}

/// Delete every cached media preview. Run at startup and exit so a crash (or a
/// kill that skips the per-tab release) can't leak files indefinitely.
pub fn sweep_preview_dir(app: &AppHandle) {
    let dir = match preview_dir(app) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(error = %e, "cannot locate media preview cache");
            return;
        }
    };
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => tracing::info!(dir = %dir.display(), "swept media preview cache"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::warn!(dir = %dir.display(), error = %e, "cannot sweep media preview cache")
        }
    }
}

/// Restrict a frontend-supplied cache file name component to ASCII alphanumerics,
/// so neither half can carry a separator or `..` out of the preview directory.
fn is_name_safe(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric())
}

/// Download the media file at `url` into the preview cache as `<key>.<ext>` and
/// return its local path, which the frontend hands to `convertFileSrc` to stream
/// over `asset:`. The bytes go straight to disk (never buffered whole in memory),
/// and the file is allowed on the asset-protocol scope so the webview may read it.
#[tauri::command]
pub async fn cache_media(
    app: AppHandle,
    url: String,
    headers: Vec<(String, String)>,
    pin: Option<String>,
    key: String,
    ext: String,
) -> Result<String, String> {
    log_err(
        "cache_media",
        async {
            if !is_name_safe(&key) || !is_name_safe(&ext) {
                return Err(format!("invalid preview cache name: {key}.{ext}"));
            }
            let dir = preview_dir(&app)?;
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| e.to_string())?;
            let dest = dir.join(format!("{key}.{ext}"));

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

            let mut file = tokio::fs::File::create(&dest)
                .await
                .map_err(|e| e.to_string())?;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| e.to_string())?;
                file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            }
            file.flush().await.map_err(|e| e.to_string())?;

            app.asset_protocol_scope()
                .allow_file(&dest)
                .map_err(|e| e.to_string())?;
            Ok(dest.to_string_lossy().into_owned())
        }
        .await,
    )
}

/// Delete one cached preview once its tab closed. Anything outside the preview
/// directory is refused, so a stray call can't remove arbitrary files. The asset
/// scope keeps its (now dangling) entry deliberately: `forbid_file` would also
/// block re-allowing the same path if the very same file is previewed again.
#[tauri::command]
pub async fn drop_cached_media(app: AppHandle, path: String) -> Result<(), String> {
    log_err(
        "drop_cached_media",
        async {
            let dir = preview_dir(&app)?;
            let file = PathBuf::from(&path);
            if file.parent() != Some(dir.as_path()) {
                return Err(format!("not a cached preview: {path}"));
            }
            match tokio::fs::remove_file(&file).await {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            }
        }
        .await,
    )
}

/// How much of the source file each upload body chunk carries. Small enough that
/// progress moves smoothly, large enough not to make a syscall per kilobyte.
const UPLOAD_CHUNK: usize = 64 * 1024;

/// Upload a local file at `src` to the hosting service by POSTing its raw bytes
/// to `url` (which carries the target `?dir=&name=`). Pinned TLS, signed headers.
///
/// The body streams from disk (so a large file never sits in memory whole),
/// reporting progress on `on_progress` as chunks are handed to the connection and
/// stopping if the `transfer_id` cancel flag is set. Returns whether the upload
/// completed: `false` means the user cancelled, which is not an error.
#[tauri::command]
pub async fn upload_file(
    state: State<'_, TransferState>,
    url: String,
    headers: Vec<(String, String)>,
    pin: Option<String>,
    src: String,
    transfer_id: u64,
    on_progress: Channel<Progress>,
) -> Result<bool, String> {
    let cancel = state.flag(transfer_id);
    let result = log_err(
        "upload_file",
        async {
            let total = tokio::fs::metadata(&src)
                .await
                .map_err(|e| e.to_string())?
                .len();
            let file = tokio::fs::File::open(&src)
                .await
                .map_err(|e| e.to_string())?;
            let progress = ProgressEmitter::new(on_progress, Some(total));

            // Feed the request body a chunk at a time, counting bytes as the
            // connection drains them. Erroring out of the stream is how a cancel
            // aborts the request mid-flight; the flag is re-checked below to tell
            // that apart from a genuine transport failure.
            let cancelled = cancel.clone();
            let body = reqwest::Body::wrap_stream(futures_util::stream::try_unfold(
                (file, progress),
                move |(mut file, mut progress)| {
                    let cancelled = cancelled.clone();
                    async move {
                        if cancelled.load(Ordering::Relaxed) {
                            return Err(std::io::Error::other("cancelled"));
                        }
                        let mut buf = vec![0u8; UPLOAD_CHUNK];
                        let n = file.read(&mut buf).await?;
                        if n == 0 {
                            progress.finish();
                            return Ok(None);
                        }
                        buf.truncate(n);
                        progress.advance(n as u64);
                        Ok(Some((buf, (file, progress))))
                    }
                },
            ));

            let (client, _) = reqwest_client(pin)?;
            let sent = apply_headers(client.post(&url), &headers)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(body)
                .send()
                .await;
            if cancel.load(Ordering::Relaxed) {
                return Ok(false);
            }
            let resp = sent.map_err(|e| e.to_string())?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(error_message(status, &body));
            }
            Ok(true)
        }
        .await,
    );
    state.forget(transfer_id);
    result
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

/// Queue a frame on connection `id`. Exactly one of `text`/`binary_b64` is set.
///
/// An unknown `id` is an error, not a silent no-op. The reader task removes the
/// connection as soon as the socket dies, but the frontend's `readyState` stays
/// OPEN until that close notification round-trips to it — so a frame discarded
/// here would otherwise be reported to the caller as delivered.
async fn send_frame(
    state: &WsInner,
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
    let tx = state
        .conns
        .lock()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("connection {id} is closed"))?;
    tx.send(msg).map_err(|_| "connection closed".to_string())
}

/// Tauri command wrapper around [`send_frame`], which holds the contract.
#[tauri::command]
pub async fn ws_send(
    state: State<'_, WsState>,
    id: u64,
    text: Option<String>,
    binary_b64: Option<String>,
) -> Result<(), String> {
    log_err("ws_send", send_frame(&state, id, text, binary_b64).await)
}

/// Close connection `id` (sends a Close frame; the reader task then cleans up).
#[tauri::command]
pub async fn ws_close(state: State<'_, WsState>, id: u64) -> Result<(), String> {
    if let Some(tx) = state.conns.lock().await.remove(&id) {
        let _ = tx.send(Message::Close(None));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend cannot tell a dead socket from a live one until the reader
    /// task's close notification reaches it, so `send_frame` must report the drop
    /// rather than swallow it.
    #[tokio::test]
    async fn send_frame_rejects_an_unknown_connection() {
        let state = WsInner::default();
        let err = send_frame(&state, 7, Some("keystroke".into()), None)
            .await
            .expect_err("an unknown connection must not report success");
        assert!(err.contains("closed"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn send_frame_delivers_text() {
        let state = WsInner::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        state.conns.lock().await.insert(3, tx);

        send_frame(&state, 3, Some("resize".into()), None)
            .await
            .expect("live connection");

        match rx.recv().await.expect("a queued frame") {
            Message::Text(t) => assert_eq!(t.as_str(), "resize"),
            other => panic!("expected a text frame, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_frame_decodes_binary() {
        let state = WsInner::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        state.conns.lock().await.insert(4, tx);

        let payload = [0x10u8, 0xaa, 0x68, 0x69];
        send_frame(&state, 4, None, Some(b64().encode(payload)))
            .await
            .expect("live connection");

        match rx.recv().await.expect("a queued frame") {
            Message::Binary(b) => assert_eq!(&b[..], &payload),
            other => panic!("expected a binary frame, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_frame_rejects_invalid_base64() {
        let state = WsInner::default();
        let (tx, _rx) = mpsc::unbounded_channel();
        state.conns.lock().await.insert(5, tx);
        assert!(send_frame(&state, 5, None, Some("not base64!!".into()))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn send_frame_without_a_payload_is_a_no_op() {
        let state = WsInner::default();
        send_frame(&state, 1, None, None)
            .await
            .expect("no payload means nothing to send");
    }
}
