//! Shared-token authentication.
//!
//! REST requests authenticate via `Authorization: Bearer <token>`. The
//! WebSocket handshake (which cannot set custom headers from a webview) uses a
//! `?token=` query parameter, validated in the ws module via [`token_valid`].

use axum::{
    body::Body,
    extract::State,
    http::{header, Request},
    middleware::Next,
    response::Response,
};

use crate::{error::AppError, state::SharedState};

/// Constant-time-ish token comparison (tokens are short; this is a self-hosted
/// tool, not a public multi-tenant service).
pub fn token_valid(state: &SharedState, presented: &str) -> bool {
    // Length check first, then byte compare — good enough for a shared secret.
    let expected = state.config.token.as_bytes();
    let got = presented.as_bytes();
    expected.len() == got.len()
        && expected
            .iter()
            .zip(got)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// Axum middleware enforcing the bearer token on REST routes.
pub async fn require_bearer(
    State(state): State<SharedState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match presented {
        Some(tok) if token_valid(&state, tok) => Ok(next.run(req).await),
        _ => Err(AppError::Unauthorized),
    }
}
