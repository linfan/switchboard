//! Reverse-tunnel multiplexing codec for **repeater mode**.
//!
//! A repeater with no local task execution forwards every client interaction to a
//! single paired worker over one worker↔repeater WebSocket. Many client
//! interactions (REST request/response exchanges and full WS sessions) are
//! multiplexed over that one connection, each tagged by a `u64` **stream id**. The
//! repeater never interprets application semantics — it shuttles opaque payloads —
//! so new REST routes and new control messages tunnel transparently.
//!
//! Wire layout (big-endian), one [`TunnelFrame`] per WebSocket **binary** message:
//!
//! ```text
//!   [kind:1][stream_id:8][payload...]
//! ```
//!
//! Payload by kind:
//! - `REQ_HEAD` / `RESP_HEAD` / `WS_OPEN` — JSON of [`ReqHead`] / [`RespHead`] /
//!   [`WsOpen`]. Kept as JSON (not a packed struct) so metadata can evolve without
//!   a codec change.
//! - `REQ_BODY` / `RESP_BODY` — a raw body chunk (bodies are chunked so a 100 MiB
//!   upload streams and stays under the WebSocket message-size cap).
//! - `WS_TEXT` / `WS_BIN` — one tunneled WebSocket text/binary frame's payload.
//! - `REQ_END` / `RESP_END` / `WS_CLOSE` / `RST` / `PING` / `PONG` — empty payload.
//!   `RST` aborts an in-flight stream (client disconnected / cancel). `PING`/`PONG`
//!   are an app-level heartbeat and ignore the stream id.

use serde::{Deserialize, Serialize};

/// Frame-kind discriminants (first byte on the wire).
pub const KIND_REQ_HEAD: u8 = 0x01;
pub const KIND_REQ_BODY: u8 = 0x02;
pub const KIND_REQ_END: u8 = 0x03;
pub const KIND_RESP_HEAD: u8 = 0x11;
pub const KIND_RESP_BODY: u8 = 0x12;
pub const KIND_RESP_END: u8 = 0x13;
pub const KIND_WS_OPEN: u8 = 0x21;
pub const KIND_WS_TEXT: u8 = 0x22;
pub const KIND_WS_BIN: u8 = 0x23;
pub const KIND_WS_CLOSE: u8 = 0x24;
pub const KIND_RST: u8 = 0x30;
pub const KIND_PING: u8 = 0x31;
pub const KIND_PONG: u8 = 0x32;

const STREAM_LEN: usize = 8;

/// Suggested body-chunk size (512 KiB): small enough to interleave fairly with the
/// hot PTY-output path over the shared tunnel and to stay well under the WebSocket
/// message-size limit; large enough to keep per-chunk overhead negligible.
pub const BODY_CHUNK: usize = 512 * 1024;

/// A decoded tunnel frame: a kind, the stream it belongs to, and an opaque payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelFrame {
    pub kind: u8,
    pub stream_id: u64,
    pub payload: Vec<u8>,
}

/// Start of a tunneled HTTP request (`REQ_HEAD` payload).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReqHead {
    pub method: String,
    /// Path plus query, e.g. `/api/fs?path=/tmp`.
    pub uri: String,
    /// Forwarded request headers (auth headers are stripped before tunneling).
    pub headers: Vec<(String, String)>,
}

/// Start of a tunneled HTTP response (`RESP_HEAD` payload).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RespHead {
    pub status: u16,
    pub headers: Vec<(String, String)>,
}

/// A new tunneled client WebSocket session (`WS_OPEN` payload).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WsOpen {
    /// Path plus query the client dialed, e.g. `/ws`.
    pub uri: String,
}

/// Why a byte slice could not be decoded into a [`TunnelFrame`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    /// Fewer bytes than the fixed `[kind][stream_id]` header requires.
    TooShort,
    /// First byte is not a known frame kind.
    UnknownKind(u8),
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TunnelError::TooShort => write!(f, "tunnel frame shorter than its header"),
            TunnelError::UnknownKind(k) => write!(f, "unknown tunnel frame kind 0x{k:02x}"),
        }
    }
}

impl std::error::Error for TunnelError {}

fn known_kind(kind: u8) -> bool {
    matches!(
        kind,
        KIND_REQ_HEAD
            | KIND_REQ_BODY
            | KIND_REQ_END
            | KIND_RESP_HEAD
            | KIND_RESP_BODY
            | KIND_RESP_END
            | KIND_WS_OPEN
            | KIND_WS_TEXT
            | KIND_WS_BIN
            | KIND_WS_CLOSE
            | KIND_RST
            | KIND_PING
            | KIND_PONG
    )
}

impl TunnelFrame {
    /// Build a frame from a kind, stream id, and payload bytes.
    pub fn new(kind: u8, stream_id: u64, payload: Vec<u8>) -> Self {
        Self {
            kind,
            stream_id,
            payload,
        }
    }

    /// A payloadless control frame (`REQ_END`, `WS_CLOSE`, `RST`, `PING`, …).
    pub fn control(kind: u8, stream_id: u64) -> Self {
        Self {
            kind,
            stream_id,
            payload: Vec::new(),
        }
    }

    /// Serialize to the wire format.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(1 + STREAM_LEN + self.payload.len());
        out.push(self.kind);
        out.extend_from_slice(&self.stream_id.to_be_bytes());
        out.extend_from_slice(&self.payload);
        out
    }

    /// Parse a tunnel frame. The payload is copied out of `bytes`.
    pub fn decode(bytes: &[u8]) -> Result<TunnelFrame, TunnelError> {
        let (&kind, rest) = bytes.split_first().ok_or(TunnelError::TooShort)?;
        if !known_kind(kind) {
            return Err(TunnelError::UnknownKind(kind));
        }
        if rest.len() < STREAM_LEN {
            return Err(TunnelError::TooShort);
        }
        let mut id = [0u8; STREAM_LEN];
        id.copy_from_slice(&rest[..STREAM_LEN]);
        Ok(TunnelFrame {
            kind,
            stream_id: u64::from_be_bytes(id),
            payload: rest[STREAM_LEN..].to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_all_kinds() {
        for kind in [
            KIND_REQ_HEAD,
            KIND_REQ_BODY,
            KIND_REQ_END,
            KIND_RESP_HEAD,
            KIND_RESP_BODY,
            KIND_RESP_END,
            KIND_WS_OPEN,
            KIND_WS_TEXT,
            KIND_WS_BIN,
            KIND_WS_CLOSE,
            KIND_RST,
            KIND_PING,
            KIND_PONG,
        ] {
            let f = TunnelFrame::new(kind, 0xdead_beef_0011_2233, b"payload\x00\xff".to_vec());
            assert_eq!(TunnelFrame::decode(&f.encode()).unwrap(), f);
        }
    }

    #[test]
    fn empty_payload_round_trips() {
        let f = TunnelFrame::control(KIND_RST, 42);
        let bytes = f.encode();
        assert_eq!(bytes.len(), 1 + STREAM_LEN);
        assert_eq!(TunnelFrame::decode(&bytes).unwrap(), f);
    }

    #[test]
    fn stream_id_is_big_endian_after_kind() {
        let f = TunnelFrame::control(KIND_PING, 1);
        let bytes = f.encode();
        assert_eq!(bytes[0], KIND_PING);
        assert_eq!(&bytes[1..9], &1u64.to_be_bytes());
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(TunnelFrame::decode(&[]), Err(TunnelError::TooShort));
    }

    #[test]
    fn rejects_unknown_kind() {
        assert_eq!(
            TunnelFrame::decode(&[0xAA, 0, 0, 0, 0, 0, 0, 0, 0]),
            Err(TunnelError::UnknownKind(0xAA))
        );
    }

    #[test]
    fn rejects_truncated_stream_id() {
        assert_eq!(
            TunnelFrame::decode(&[KIND_REQ_END, 0, 0, 0]),
            Err(TunnelError::TooShort)
        );
    }

    #[test]
    fn heads_json_round_trip() {
        let head = ReqHead {
            method: "POST".into(),
            uri: "/api/fs/upload?dir=/tmp&name=a.bin".into(),
            headers: vec![("content-type".into(), "application/octet-stream".into())],
        };
        let bytes = serde_json::to_vec(&head).unwrap();
        let f = TunnelFrame::new(KIND_REQ_HEAD, 7, bytes);
        let back = TunnelFrame::decode(&f.encode()).unwrap();
        assert_eq!(
            serde_json::from_slice::<ReqHead>(&back.payload).unwrap(),
            head
        );

        let resp = RespHead {
            status: 204,
            headers: vec![],
        };
        assert_eq!(
            serde_json::from_slice::<RespHead>(&serde_json::to_vec(&resp).unwrap()).unwrap(),
            resp
        );
        let open = WsOpen { uri: "/ws".into() };
        assert_eq!(
            serde_json::from_slice::<WsOpen>(&serde_json::to_vec(&open).unwrap()).unwrap(),
            open
        );
    }
}
