//! `SWB-v1` request authentication (server side).
//!
//! The shared token is **never transmitted**. REST requests are signed per
//! request with an HMAC over the method, path+query, timestamp, a single-use
//! nonce, a hash of the body, and the TLS channel binding (`cb`); see
//! [`switchboard_shared::auth`] for the wire details. The WebSocket / tunnel
//! handshake is a challenge-response handled in the `ws` module. Both sides share
//! the crypto in the `switchboard-shared` crate so they cannot drift.

use std::collections::HashMap;
use std::sync::Mutex;

use axum::{
    body::Body,
    extract::State,
    http::Request,
    middleware::Next,
    response::Response,
};
use switchboard_shared::{
    auth::{ct_eq, from_hex, rest_mac, sha256, H_MAC, H_NONCE, H_TS, REST_MAX_SKEW_MS},
    now_millis,
};

use crate::{error::AppError, state::SharedState};

/// Largest REST body we buffer to verify its signature. Must clear the largest
/// route limit (`/api/fs/upload` allows 100 MiB) with headroom.
const MAX_SIGNED_BODY: usize = 128 * 1024 * 1024;

/// Time-bounded single-use nonce cache. A REST nonce is accepted at most once
/// within the skew window; entries expire (and are pruned) after it, bounding
/// memory to the request rate over one window.
#[derive(Default)]
pub struct ReplayCache {
    seen: Mutex<HashMap<Vec<u8>, i64>>,
}

impl ReplayCache {
    /// Record `nonce` as used until `expiry_ms`. Returns `false` if it was
    /// already present (a replay). Prunes entries that expired by `now_ms`.
    pub fn check_and_insert(&self, nonce: &[u8], now_ms: i64, expiry_ms: i64) -> bool {
        let mut seen = self.seen.lock().unwrap();
        seen.retain(|_, &mut exp| exp > now_ms);
        if seen.contains_key(nonce) {
            return false;
        }
        seen.insert(nonce.to_vec(), expiry_ms);
        true
    }
}

/// Axum middleware enforcing the per-request `SWB-REST-v1` signature. Buffers the
/// body to hash it, verifies the MAC, timestamp window, and nonce freshness, then
/// forwards the reconstructed request downstream.
pub async fn require_signed(
    State(state): State<SharedState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let (parts, body) = req.into_parts();

    let ts: i64 = header(&parts, H_TS)
        .and_then(|v| v.parse().ok())
        .ok_or(AppError::Unauthorized)?;
    let nonce = header(&parts, H_NONCE)
        .and_then(from_hex)
        .ok_or(AppError::Unauthorized)?;
    let presented_mac = header(&parts, H_MAC)
        .and_then(from_hex)
        .ok_or(AppError::Unauthorized)?;

    // Clock-skew window: reject stale or far-future timestamps.
    let now = now_millis();
    if (now - ts).abs() > REST_MAX_SKEW_MS {
        return Err(AppError::Unauthorized);
    }

    // Sign over the full request target (path + query), including any `/api`
    // prefix stripped by nesting — so use the original URI when present.
    let uri = parts
        .extensions
        .get::<axum::extract::OriginalUri>()
        .map(|o| &o.0)
        .unwrap_or(&parts.uri);
    let path_and_query = uri
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| uri.path())
        .to_string();
    let method = parts.method.as_str().to_string();

    let bytes = axum::body::to_bytes(body, MAX_SIGNED_BODY)
        .await
        .map_err(|_| AppError::BadRequest("request body too large".into()))?;
    let body_hash = sha256(&bytes);

    let expected = rest_mac(
        state.config.token.as_bytes(),
        &method,
        &path_and_query,
        ts,
        &nonce,
        &body_hash,
        &state.cert_fp,
    );
    if !ct_eq(&expected, &presented_mac) {
        return Err(AppError::Unauthorized);
    }

    // Only burn the nonce after the MAC checks out, so a forged request can't
    // evict a legitimate one.
    if !state
        .nonce_cache
        .check_and_insert(&nonce, now, ts + REST_MAX_SKEW_MS)
    {
        return Err(AppError::Unauthorized);
    }

    let req = Request::from_parts(parts, Body::from(bytes));
    Ok(next.run(req).await)
}

fn header<'a>(parts: &'a axum::http::request::Parts, name: &str) -> Option<&'a str> {
    parts.headers.get(name).and_then(|v| v.to_str().ok())
}
