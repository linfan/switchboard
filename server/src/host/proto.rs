//! Wire protocol between the server and a pty-host process.
//!
//! Framing is `[kind:u8][len:u32le][payload]`. Control messages carry JSON
//! (low rate, worth the readability); the two hot-path messages carry raw
//! terminal bytes with no copy beyond the frame itself.
//!
//! # This is a compatibility boundary
//!
//! A host keeps running across a server upgrade, so a *new* server routinely
//! talks to hosts spawned by an *older* one. Treat this module as frozen: add
//! new message kinds (unknown kinds are skipped, not fatal) rather than changing
//! the meaning of existing ones, and bump [`PROTO_VERSION`] only for a genuine
//! break — at which point the server declines to adopt the host and the task
//! reconciles to `Detached` instead of misbehaving.

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::error::{AppError, AppResult};

/// Current protocol version. See the module docs before changing this.
pub const PROTO_VERSION: u16 = 1;

/// Cap on a single frame's payload. Output frames are bounded by the host's read
/// chunk (8 KiB) and input by client keystrokes, so this is pure sanity
/// checking against a desynchronized stream.
const MAX_FRAME: u32 = 1024 * 1024;

// Host -> server.
const KIND_HELLO: u8 = 0x01;
const KIND_OUTPUT: u8 = 0x02;
const KIND_EXITED: u8 = 0x03;
// Server -> host.
const KIND_ATTACH: u8 = 0x10;
const KIND_INPUT: u8 = 0x11;
const KIND_RESIZE: u8 = 0x12;
const KIND_ACK: u8 = 0x13;
const KIND_TERMINATE: u8 = 0x14;

/// Host's opening message, sent as soon as a server connects.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hello {
    /// Protocol version this host speaks.
    pub proto: u16,
    /// OS pid of the agent process the host supervises, when known.
    pub agent_pid: Option<u32>,
    /// OS pid of the host process itself. Optional because hosts from before
    /// this field existed do not send it — JSON plus `serde(default)` keeps them
    /// adoptable, which is the whole point of the protocol's compat rules.
    #[serde(default)]
    pub host_pid: Option<u32>,
    /// Terminal size the host currently has applied.
    pub cols: u16,
    pub rows: u16,
    /// Total bytes the host has produced so far. Lets the server detect that a
    /// host restarted underneath it (offset went backwards) rather than
    /// silently replaying a different stream.
    pub produced: u64,
    /// Lowest offset the host can still replay. A server whose durable offset is
    /// below this has lost bytes — visible rather than silent.
    pub retained_from: u64,
}

/// Server's reply to [`Hello`]: resume the byte stream after `after`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Attach {
    pub proto: u16,
    /// Count of bytes the server has durably persisted. The host resends
    /// everything from this offset on, which makes delivery exactly-once.
    pub after: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Exited {
    pub code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Resize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Ack {
    /// Offset one past the last byte the server has durably persisted.
    pub offset: u64,
}

/// A message from the host to the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FromHost {
    Hello(Hello),
    /// Raw terminal bytes, and the offset of the first byte in the host's
    /// lifetime output stream.
    Output {
        offset: u64,
        bytes: Vec<u8>,
    },
    Exited(Exited),
}

/// A message from the server to the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToHost {
    Attach(Attach),
    Input(Vec<u8>),
    Resize(Resize),
    Ack(Ack),
    Terminate,
}

/// Frames whose kind we don't recognize are skipped, so an older peer stays
/// usable when a newer one adds a message. This distinguishes "nothing left"
/// from "something we ignored".
enum Decoded<T> {
    Msg(T),
    Skipped,
}

impl FromHost {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            FromHost::Hello(h) => frame_json(KIND_HELLO, h),
            FromHost::Output { offset, bytes } => {
                let mut payload = Vec::with_capacity(8 + bytes.len());
                payload.extend_from_slice(&offset.to_le_bytes());
                payload.extend_from_slice(bytes);
                frame(KIND_OUTPUT, &payload)
            }
            FromHost::Exited(e) => frame_json(KIND_EXITED, e),
        }
    }

    fn decode(kind: u8, payload: Vec<u8>) -> AppResult<Decoded<Self>> {
        Ok(match kind {
            KIND_HELLO => Decoded::Msg(FromHost::Hello(from_json(&payload)?)),
            KIND_OUTPUT => {
                if payload.len() < 8 {
                    return Err(protocol_err("OUTPUT frame shorter than its offset header"));
                }
                let offset = u64::from_le_bytes(payload[..8].try_into().expect("8 bytes"));
                Decoded::Msg(FromHost::Output {
                    offset,
                    bytes: payload[8..].to_vec(),
                })
            }
            KIND_EXITED => Decoded::Msg(FromHost::Exited(from_json(&payload)?)),
            _ => Decoded::Skipped,
        })
    }
}

impl ToHost {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            ToHost::Attach(a) => frame_json(KIND_ATTACH, a),
            ToHost::Input(bytes) => frame(KIND_INPUT, bytes),
            ToHost::Resize(r) => frame_json(KIND_RESIZE, r),
            ToHost::Ack(a) => frame_json(KIND_ACK, a),
            ToHost::Terminate => frame(KIND_TERMINATE, &[]),
        }
    }

    fn decode(kind: u8, payload: Vec<u8>) -> AppResult<Decoded<Self>> {
        Ok(match kind {
            KIND_ATTACH => Decoded::Msg(ToHost::Attach(from_json(&payload)?)),
            KIND_INPUT => Decoded::Msg(ToHost::Input(payload)),
            KIND_RESIZE => Decoded::Msg(ToHost::Resize(from_json(&payload)?)),
            KIND_ACK => Decoded::Msg(ToHost::Ack(from_json(&payload)?)),
            KIND_TERMINATE => Decoded::Msg(ToHost::Terminate),
            _ => Decoded::Skipped,
        })
    }
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + payload.len());
    out.push(kind);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

fn frame_json<T: Serialize>(kind: u8, value: &T) -> Vec<u8> {
    // These are plain structs of scalars; serialization cannot fail.
    let json = serde_json::to_vec(value).expect("host control message is serializable");
    frame(kind, &json)
}

fn from_json<T: for<'de> Deserialize<'de>>(payload: &[u8]) -> AppResult<T> {
    serde_json::from_slice(payload)
        .map_err(|e| protocol_err(&format!("malformed control payload: {e}")))
}

fn protocol_err(msg: &str) -> AppError {
    AppError::Other(anyhow::anyhow!("host protocol error: {msg}"))
}

/// Read one frame header + payload. `Ok(None)` means the peer closed cleanly at
/// a frame boundary.
async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> AppResult<Option<(u8, Vec<u8>)>> {
    // Read the kind byte alone first: EOF *there* is the peer closing on a frame
    // boundary, while EOF partway through the length is a truncation. Reading the
    // whole header at once cannot tell those apart.
    let mut kind = [0u8; 1];
    match r.read_exact(&mut kind).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(protocol_err(&format!("read failed: {e}"))),
    }
    let mut len_bytes = [0u8; 4];
    r.read_exact(&mut len_bytes)
        .await
        .map_err(|e| protocol_err(&format!("truncated frame header: {e}")))?;
    let len = u32::from_le_bytes(len_bytes);
    if len > MAX_FRAME {
        return Err(protocol_err(&format!(
            "frame of {len} bytes exceeds the {MAX_FRAME}-byte cap"
        )));
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload)
        .await
        .map_err(|e| protocol_err(&format!("truncated payload: {e}")))?;
    Ok(Some((kind[0], payload)))
}

/// Read the next message the server understands, skipping unknown kinds.
pub async fn read_from_host<R: AsyncRead + Unpin>(r: &mut R) -> AppResult<Option<FromHost>> {
    loop {
        let Some((kind, payload)) = read_frame(r).await? else {
            return Ok(None);
        };
        match FromHost::decode(kind, payload)? {
            Decoded::Msg(m) => return Ok(Some(m)),
            Decoded::Skipped => {
                tracing::debug!(kind, "skipping unknown host->server frame")
            }
        }
    }
}

/// Read the next message the host understands, skipping unknown kinds.
pub async fn read_to_host<R: AsyncRead + Unpin>(r: &mut R) -> AppResult<Option<ToHost>> {
    loop {
        let Some((kind, payload)) = read_frame(r).await? else {
            return Ok(None);
        };
        match ToHost::decode(kind, payload)? {
            Decoded::Msg(m) => return Ok(Some(m)),
            Decoded::Skipped => {
                tracing::debug!(kind, "skipping unknown server->host frame")
            }
        }
    }
}

/// Write one message and flush it. Every message is either interactive
/// (keystrokes, resize) or carries terminal output a human is waiting on, so
/// buffering would only add latency.
pub async fn write_msg<W: AsyncWrite + Unpin>(w: &mut W, bytes: &[u8]) -> AppResult<()> {
    w.write_all(bytes)
        .await
        .map_err(|e| protocol_err(&format!("write failed: {e}")))?;
    w.flush()
        .await
        .map_err(|e| protocol_err(&format!("flush failed: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> Hello {
        Hello {
            proto: PROTO_VERSION,
            agent_pid: Some(4242),
            host_pid: Some(1717),
            cols: 120,
            rows: 40,
            produced: 9000,
            retained_from: 8000,
        }
    }

    #[tokio::test]
    async fn host_messages_round_trip_in_order() {
        let msgs = vec![
            FromHost::Hello(hello()),
            FromHost::Output {
                offset: 0,
                bytes: b"hello \x1b[32mworld\x1b[0m".to_vec(),
            },
            // An empty payload must survive framing too.
            FromHost::Output {
                offset: 21,
                bytes: Vec::new(),
            },
            FromHost::Exited(Exited { code: Some(3) }),
            FromHost::Exited(Exited { code: None }),
        ];
        let mut wire = Vec::new();
        for m in &msgs {
            wire.extend_from_slice(&m.encode());
        }

        let mut cursor = std::io::Cursor::new(wire);
        for expect in &msgs {
            let got = read_from_host(&mut cursor).await.unwrap().unwrap();
            assert_eq!(&got, expect);
        }
        assert!(read_from_host(&mut cursor).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn server_messages_round_trip_in_order() {
        let msgs = vec![
            ToHost::Attach(Attach {
                proto: PROTO_VERSION,
                after: 512,
            }),
            ToHost::Input(b"ls -la\r".to_vec()),
            ToHost::Resize(Resize { cols: 80, rows: 24 }),
            ToHost::Ack(Ack { offset: 4096 }),
            ToHost::Terminate,
        ];
        let mut wire = Vec::new();
        for m in &msgs {
            wire.extend_from_slice(&m.encode());
        }

        let mut cursor = std::io::Cursor::new(wire);
        for expect in &msgs {
            let got = read_to_host(&mut cursor).await.unwrap().unwrap();
            assert_eq!(&got, expect);
        }
        assert!(read_to_host(&mut cursor).await.unwrap().is_none());
    }

    /// Forward compatibility: a host from a newer build may send a kind this
    /// server has never heard of. It must be stepped over, not fatal — that is
    /// what keeps an upgrade from bricking live tasks.
    #[tokio::test]
    async fn unknown_kinds_are_skipped() {
        let mut wire = frame(0x7f, b"from the future");
        wire.extend_from_slice(&FromHost::Exited(Exited { code: Some(0) }).encode());
        let mut cursor = std::io::Cursor::new(wire);
        assert_eq!(
            read_from_host(&mut cursor).await.unwrap().unwrap(),
            FromHost::Exited(Exited { code: Some(0) })
        );
    }

    #[tokio::test]
    async fn oversized_and_truncated_frames_are_rejected() {
        // Length header beyond the cap.
        let mut bad = vec![KIND_OUTPUT];
        bad.extend_from_slice(&(MAX_FRAME + 1).to_le_bytes());
        assert!(read_from_host(&mut std::io::Cursor::new(bad))
            .await
            .is_err());

        // Header promises more payload than follows.
        let mut short = vec![KIND_INPUT];
        short.extend_from_slice(&64u32.to_le_bytes());
        short.extend_from_slice(b"only a little");
        assert!(read_to_host(&mut std::io::Cursor::new(short))
            .await
            .is_err());

        // An OUTPUT frame must at least carry its 8-byte offset.
        let stub = frame(KIND_OUTPUT, b"abc");
        assert!(read_from_host(&mut std::io::Cursor::new(stub))
            .await
            .is_err());
    }

    /// A partial frame at EOF is a truncation error, but a clean close exactly on
    /// a boundary is normal shutdown.
    #[tokio::test]
    async fn eof_between_frames_is_clean() {
        let mut cursor = std::io::Cursor::new(Vec::new());
        assert!(read_from_host(&mut cursor).await.unwrap().is_none());
        let mut partial = std::io::Cursor::new(vec![KIND_HELLO, 0x01]);
        assert!(read_from_host(&mut partial).await.is_err());
    }

    /// A host from a build before `host_pid` existed sends a HELLO without it.
    /// It must decode — with the field defaulting to `None` — so an upgrade
    /// never strands the tasks those hosts are keeping alive.
    #[test]
    fn hello_without_host_pid_decodes() {
        let legacy =
            br#"{"proto":1,"agent_pid":4242,"cols":80,"rows":24,"produced":10,"retained_from":0}"#;
        let h: Hello = serde_json::from_slice(legacy).unwrap();
        assert_eq!(h.host_pid, None);
        assert_eq!(h.agent_pid, Some(4242));
        assert_eq!(h.produced, 10);
    }
}
