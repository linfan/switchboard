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

/// Verify a `SWB-REST-v1` signature against the given secret and channel binding.
/// Checks (in order) the clock-skew window, the MAC, then burns the nonce (only
/// after the MAC checks out, so a forged request can't evict a legitimate one).
/// This is the single source of truth for REST auth — both the worker-direct
/// middleware and the repeater's client-facing ingress call it, so they can't
/// drift. The three header values are passed as raw strings; `body` is the raw
/// request body already buffered by the caller.
#[allow(clippy::too_many_arguments)]
pub fn verify_signed(
    token: &[u8],
    cert_fp: &[u8],
    cache: &ReplayCache,
    method: &str,
    path_and_query: &str,
    ts_header: Option<&str>,
    nonce_header: Option<&str>,
    mac_header: Option<&str>,
    body: &[u8],
) -> bool {
    let (Some(ts), Some(nonce), Some(presented_mac)) = (
        ts_header.and_then(|v| v.parse::<i64>().ok()),
        nonce_header.and_then(from_hex),
        mac_header.and_then(from_hex),
    ) else {
        return false;
    };

    let now = now_millis();
    if (now - ts).abs() > REST_MAX_SKEW_MS {
        return false;
    }

    let expected = rest_mac(token, method, path_and_query, ts, &nonce, &sha256(body), cert_fp);
    if !ct_eq(&expected, &presented_mac) {
        return false;
    }
    cache.check_and_insert(&nonce, now, ts + REST_MAX_SKEW_MS)
}

/// Axum middleware enforcing the per-request `SWB-REST-v1` signature. Buffers the
/// body to hash it, verifies via [`verify_signed`], then forwards the
/// reconstructed request downstream.
pub async fn require_signed(
    State(state): State<SharedState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let (parts, body) = req.into_parts();

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

    // This middleware is only mounted where a client-facing token exists
    // (worker-direct, repeater ingress). Absence means auth is misconfigured.
    let token = state.config.token.as_deref().ok_or(AppError::Unauthorized)?;

    let bytes = axum::body::to_bytes(body, MAX_SIGNED_BODY)
        .await
        .map_err(|_| AppError::BadRequest("request body too large".into()))?;

    if !verify_signed(
        token.as_bytes(),
        &state.cert_fp,
        &state.nonce_cache,
        &method,
        &path_and_query,
        header(&parts, H_TS),
        header(&parts, H_NONCE),
        header(&parts, H_MAC),
        &bytes,
    ) {
        return Err(AppError::Unauthorized);
    }

    let req = Request::from_parts(parts, Body::from(bytes));
    Ok(next.run(req).await)
}

fn header<'a>(parts: &'a axum::http::request::Parts, name: &str) -> Option<&'a str> {
    parts.headers.get(name).and_then(|v| v.to_str().ok())
}
