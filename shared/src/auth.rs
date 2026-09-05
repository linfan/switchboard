//! `SWB-v1` channel-bound challenge-response authentication.
//!
//! The shared token is **never transmitted**. Instead the client proves knowledge
//! of it by returning an HMAC over a server-issued nonce and the TLS channel's
//! cert fingerprint (`cb`), so a captured transcript can't be replayed and the
//! proof can't be relayed onto a different channel (an active MITM's channel has a
//! different `cb`). Two contexts, kept apart by domain-separation tags:
//!
//! - **WS / tunnel** (long-lived, one handshake per connection): server sends
//!   `AuthChallenge { server_nonce }`; client replies `AuthResponse { client_nonce,
//!   mac }` with `mac = ws_mac(token, server_nonce, client_nonce, cb)`.
//! - **REST** (stateless, per request): each request carries `X-Swb-Ts`,
//!   `X-Swb-Nonce`, `X-Swb-Mac`, where the MAC also covers the method, path+query,
//!   and a hash of the body. The server enforces a clock-skew window plus a
//!   single-use nonce cache.
//!
//! Every MAC input is built by [`mac`], which **length-prefixes each field** (u64
//! big-endian) so no field value (a path with a newline, a nonce that looks like a
//! delimiter, …) can be confused for another. This module is shared verbatim by the
//! server and the Rust client bridge so the two can never drift.

use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

/// Domain-separation tag for the WebSocket / tunnel handshake MAC.
pub const WS_DOMAIN: &[u8] = b"SWB-WS-v1";
/// Domain-separation tag for the per-request REST MAC.
pub const REST_DOMAIN: &[u8] = b"SWB-REST-v1";

/// Length of server/client handshake nonces, in bytes.
pub const NONCE_LEN: usize = 32;
/// Length of the per-request REST nonce, in bytes.
pub const REST_NONCE_LEN: usize = 16;
/// Accepted clock skew for a REST request's timestamp, in milliseconds.
pub const REST_MAX_SKEW_MS: i64 = 30_000;

/// Header names for REST request signing (lowercase; HTTP headers are case-insensitive).
pub const H_TS: &str = "x-swb-ts";
pub const H_NONCE: &str = "x-swb-nonce";
pub const H_MAC: &str = "x-swb-mac";

/// SHA-256 digest. Used for the cert fingerprint (`cb`) and the REST body hash.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize().into()
}

/// Lowercase hex encoding.
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// Decode lowercase/uppercase hex; `None` on any non-hex byte or odd length.
pub fn from_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.as_bytes();
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in s.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push((hi << 4 | lo) as u8);
    }
    Some(out)
}

/// Constant-time equality (guards length first, then compares without early-out).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.ct_eq(b).into()
}

/// A cryptographically random nonce of `N` bytes.
pub fn random_nonce<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    rand::thread_rng().fill_bytes(&mut buf);
    buf
}

/// Core MAC: `HMAC-SHA256(key, domain ‖ Σ (len(field) ‖ field))`. Each field
/// (including the domain) is length-prefixed with a u64 big-endian length so the
/// serialization is unambiguous.
pub fn mac(key: &[u8], domain: &[u8], fields: &[&[u8]]) -> [u8; 32] {
    // `new_from_slice` only errors on impossible key sizes; HMAC accepts any length.
    let mut m = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    feed(&mut m, domain);
    for f in fields {
        feed(&mut m, f);
    }
    m.finalize().into_bytes().into()
}

fn feed(m: &mut HmacSha256, field: &[u8]) {
    m.update(&(field.len() as u64).to_be_bytes());
    m.update(field);
}

/// WS / tunnel handshake MAC over the server nonce, client nonce, and channel
/// binding (`cb` = SHA-256 of the server's leaf cert DER).
pub fn ws_mac(token: &[u8], server_nonce: &[u8], client_nonce: &[u8], cb: &[u8]) -> [u8; 32] {
    mac(token, WS_DOMAIN, &[server_nonce, client_nonce, cb])
}

/// Per-request REST MAC. `path_and_query` is the request target (path plus `?query`
/// if present); `body_sha256` is [`sha256`] of the raw request body (of the empty
/// slice for bodyless requests); `cb` is the channel binding.
pub fn rest_mac(
    token: &[u8],
    method: &str,
    path_and_query: &str,
    ts: i64,
    nonce: &[u8],
    body_sha256: &[u8],
    cb: &[u8],
) -> [u8; 32] {
    mac(
        token,
        REST_DOMAIN,
        &[
            method.as_bytes(),
            path_and_query.as_bytes(),
            &ts.to_be_bytes(),
            nonce,
            body_sha256,
            cb,
        ],
    )
}

/// Handshake control messages, exchanged as JSON **text** frames before the normal
/// `Hello`/`Welcome` flow. Handled entirely by the transport layer (server + Rust
/// client bridge); the frontend never sees them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AuthMsg {
    /// Server → client: the per-connection challenge (hex-encoded 32-byte nonce).
    AuthChallenge { server_nonce: String },
    /// Client → server: the channel-bound proof (hex nonce + hex MAC).
    AuthResponse { client_nonce: String, mac: String },
    /// Server → client: authentication accepted.
    AuthOk,
    /// Server → client: authentication rejected.
    AuthError { message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &[u8] = b"super-secret-token";
    const CB: &[u8] = b"channel-binding-fingerprint-bytes";

    #[test]
    fn hex_round_trips() {
        let bytes = [0x00u8, 0x0f, 0xa5, 0xff, 0x10];
        assert_eq!(hex(&bytes), "000fa5ff10");
        assert_eq!(from_hex("000fa5ff10").unwrap(), bytes);
        assert_eq!(from_hex(&hex(&bytes)).unwrap(), bytes);
    }

    #[test]
    fn from_hex_rejects_bad_input() {
        assert!(from_hex("abc").is_none()); // odd length
        assert!(from_hex("zz").is_none()); // non-hex
    }

    #[test]
    fn ct_eq_matches_semantics() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab")); // length mismatch
    }

    #[test]
    fn random_nonce_is_nonzero_and_unique() {
        let a = random_nonce::<NONCE_LEN>();
        let b = random_nonce::<NONCE_LEN>();
        assert_ne!(a, b, "two nonces must not collide");
        assert!(a.iter().any(|&x| x != 0), "nonce must not be all zeros");
    }

    #[test]
    fn ws_mac_is_deterministic() {
        let sn = [1u8; NONCE_LEN];
        let cn = [2u8; NONCE_LEN];
        let a = ws_mac(TOKEN, &sn, &cn, CB);
        let b = ws_mac(TOKEN, &sn, &cn, CB);
        assert_eq!(a, b);
    }

    #[test]
    fn ws_mac_changes_with_every_input() {
        let sn = [1u8; NONCE_LEN];
        let cn = [2u8; NONCE_LEN];
        let base = ws_mac(TOKEN, &sn, &cn, CB);
        assert_ne!(
            base,
            ws_mac(b"other-token", &sn, &cn, CB),
            "token must matter"
        );
        assert_ne!(
            base,
            ws_mac(TOKEN, &[9u8; NONCE_LEN], &cn, CB),
            "server nonce must matter"
        );
        assert_ne!(
            base,
            ws_mac(TOKEN, &sn, &[9u8; NONCE_LEN], CB),
            "client nonce must matter"
        );
        assert_ne!(
            base,
            ws_mac(TOKEN, &sn, &cn, b"different-cb"),
            "channel binding must matter"
        );
    }

    #[test]
    fn rest_mac_changes_with_every_input() {
        let nonce = [7u8; REST_NONCE_LEN];
        let body = sha256(b"{\"k\":1}");
        let base = rest_mac(TOKEN, "GET", "/api/info", 1000, &nonce, &body, CB);
        assert_eq!(
            base,
            rest_mac(TOKEN, "GET", "/api/info", 1000, &nonce, &body, CB),
            "deterministic"
        );
        assert_ne!(
            base,
            rest_mac(TOKEN, "POST", "/api/info", 1000, &nonce, &body, CB)
        );
        assert_ne!(
            base,
            rest_mac(TOKEN, "GET", "/api/tasks", 1000, &nonce, &body, CB)
        );
        assert_ne!(
            base,
            rest_mac(TOKEN, "GET", "/api/info", 1001, &nonce, &body, CB)
        );
        assert_ne!(
            base,
            rest_mac(
                TOKEN,
                "GET",
                "/api/info",
                1000,
                &[8u8; REST_NONCE_LEN],
                &body,
                CB
            )
        );
        assert_ne!(
            base,
            rest_mac(
                TOKEN,
                "GET",
                "/api/info",
                1000,
                &nonce,
                &sha256(b"tampered"),
                CB
            )
        );
        assert_ne!(
            base,
            rest_mac(TOKEN, "GET", "/api/info", 1000, &nonce, &body, b"other-cb")
        );
    }

    #[test]
    fn known_answer_vectors() {
        // Fixed vectors that the TypeScript WebCrypto implementation
        // (`client/src/net/swbauth.ts`) must reproduce byte-for-byte, so the two
        // signers can never drift. Inputs are all-ASCII / fixed-byte so they are
        // trivial to reconstruct on the JS side.
        let token = b"kat-token";
        let cb = b"kat-cb";
        let server_nonce = [0x11u8; NONCE_LEN];
        let client_nonce = [0x22u8; NONCE_LEN];
        assert_eq!(
            hex(&ws_mac(token, &server_nonce, &client_nonce, cb)),
            "fe078d368552867c359838f41602bfaa8f83787e36de22b7040a39effc6ff78f"
        );

        let rest_nonce = [0x33u8; REST_NONCE_LEN];
        let body_hash = sha256(b"{\"hello\":\"world\"}");
        assert_eq!(
            hex(&rest_mac(
                token,
                "POST",
                "/api/file?x=1",
                1_700_000_000_000,
                &rest_nonce,
                &body_hash,
                cb,
            )),
            "b5f3a80f83747edddae69190dcc56a82f90d35f8cca9628efeae3c71409311e4"
        );
    }

    #[test]
    fn domains_are_separated() {
        // Same key/fields under the two domains must not collide.
        let a = mac(TOKEN, WS_DOMAIN, &[b"x", b"y"]);
        let b = mac(TOKEN, REST_DOMAIN, &[b"x", b"y"]);
        assert_ne!(a, b);
    }

    #[test]
    fn length_prefixing_prevents_field_ambiguity() {
        // ["ab","c"] vs ["a","bc"] would collide under naive concatenation; the
        // length prefixes must keep them distinct.
        let a = mac(TOKEN, WS_DOMAIN, &[b"ab", b"c"]);
        let b = mac(TOKEN, WS_DOMAIN, &[b"a", b"bc"]);
        assert_ne!(a, b);
    }

    #[test]
    fn auth_msg_round_trips() {
        let msg = AuthMsg::AuthResponse {
            client_nonce: "aabb".into(),
            mac: " ".repeat(0) + "ccdd",
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"auth_response\""));
        assert_eq!(serde_json::from_str::<AuthMsg>(&json).unwrap(), msg);

        let ch = AuthMsg::AuthChallenge {
            server_nonce: "00ff".into(),
        };
        let j2 = serde_json::to_string(&ch).unwrap();
        assert!(j2.contains("\"type\":\"auth_challenge\""));
    }
}
