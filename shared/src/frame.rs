//! Binary WebSocket **data-plane** frames for PTY terminal I/O.
//!
//! The control plane (`ClientMsg`/`ServerMsg`) travels as JSON **text** frames.
//! The high-volume terminal byte stream travels as **binary** frames with a
//! compact fixed header, so we avoid base64's ~33% overhead on the hot path.
//! Receivers branch on the WebSocket frame opcode: text → JSON control, binary
//! → [`Frame`].
//!
//! Layout (integers big-endian, `task_id` = the 16 raw bytes of the task UUID):
//!
//! ```text
//!   OUTPUT    [0x01][task_id:16][seq:u64][data...]   server -> client
//!   SNAPSHOT  [0x02][task_id:16][seq:u64][data...]   server -> client
//!   INPUT     [0x10][task_id:16][data...]            client -> server
//! ```
//!
//! `seq` is the monotonic per-task chunk sequence. On `SNAPSHOT` it is the chunk
//! seq the snapshot already reflects (the client's live position resumes there).
//! `INPUT` carries no seq: WebSocket/TCP preserves order and the server writes
//! keystroke bytes to the PTY in arrival order.
//!
//! This codec is hand-mirrored in TypeScript at `client/src/net/frame.ts`; the
//! two must stay byte-for-byte compatible (both are round-trip tested).

use std::fmt;

use uuid::Uuid;

/// Frame-kind discriminants (first byte on the wire).
pub const KIND_OUTPUT: u8 = 0x01;
pub const KIND_SNAPSHOT: u8 = 0x02;
pub const KIND_INPUT: u8 = 0x10;

const UUID_LEN: usize = 16;
const SEQ_LEN: usize = 8;

/// A decoded binary data-plane frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// Live terminal output chunk for a task (server → client).
    Output {
        task_id: Uuid,
        seq: u64,
        data: Vec<u8>,
    },
    /// Screen snapshot that reconstructs terminal state on (re)connect
    /// (server → client). `data` is ANSI that redraws the current screen.
    Snapshot {
        task_id: Uuid,
        seq: u64,
        data: Vec<u8>,
    },
    /// Keystroke bytes for a task (client → server).
    Input { task_id: Uuid, data: Vec<u8> },
}

/// Why a byte slice could not be decoded into a [`Frame`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Zero-length input; no kind byte.
    Empty,
    /// Fewer bytes than the frame kind's fixed header requires.
    TooShort,
    /// First byte is not a known frame kind.
    UnknownKind(u8),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::Empty => write!(f, "empty frame"),
            FrameError::TooShort => write!(f, "frame shorter than its header"),
            FrameError::UnknownKind(k) => write!(f, "unknown frame kind 0x{k:02x}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl Frame {
    /// The frame's task id.
    pub fn task_id(&self) -> Uuid {
        match self {
            Frame::Output { task_id, .. }
            | Frame::Snapshot { task_id, .. }
            | Frame::Input { task_id, .. } => *task_id,
        }
    }

    /// Serialize to the wire format.
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Frame::Output { task_id, seq, data } => encode_seq(KIND_OUTPUT, task_id, *seq, data),
            Frame::Snapshot { task_id, seq, data } => {
                encode_seq(KIND_SNAPSHOT, task_id, *seq, data)
            }
            Frame::Input { task_id, data } => {
                let mut out = Vec::with_capacity(1 + UUID_LEN + data.len());
                out.push(KIND_INPUT);
                out.extend_from_slice(task_id.as_bytes());
                out.extend_from_slice(data);
                out
            }
        }
    }

    /// Parse a binary frame. `data` is copied out of `bytes`.
    pub fn decode(bytes: &[u8]) -> Result<Frame, FrameError> {
        let (&kind, rest) = bytes.split_first().ok_or(FrameError::Empty)?;
        match kind {
            KIND_OUTPUT | KIND_SNAPSHOT => {
                if rest.len() < UUID_LEN + SEQ_LEN {
                    return Err(FrameError::TooShort);
                }
                let task_id = uuid_from(&rest[..UUID_LEN]);
                let mut seq_bytes = [0u8; SEQ_LEN];
                seq_bytes.copy_from_slice(&rest[UUID_LEN..UUID_LEN + SEQ_LEN]);
                let seq = u64::from_be_bytes(seq_bytes);
                let data = rest[UUID_LEN + SEQ_LEN..].to_vec();
                Ok(if kind == KIND_OUTPUT {
                    Frame::Output { task_id, seq, data }
                } else {
                    Frame::Snapshot { task_id, seq, data }
                })
            }
            KIND_INPUT => {
                if rest.len() < UUID_LEN {
                    return Err(FrameError::TooShort);
                }
                let task_id = uuid_from(&rest[..UUID_LEN]);
                let data = rest[UUID_LEN..].to_vec();
                Ok(Frame::Input { task_id, data })
            }
            other => Err(FrameError::UnknownKind(other)),
        }
    }
}

fn encode_seq(kind: u8, task_id: &Uuid, seq: u64, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + UUID_LEN + SEQ_LEN + data.len());
    out.push(kind);
    out.extend_from_slice(task_id.as_bytes());
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(data);
    out
}

fn uuid_from(bytes: &[u8]) -> Uuid {
    let mut arr = [0u8; UUID_LEN];
    arr.copy_from_slice(bytes);
    Uuid::from_bytes(arr)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tid() -> Uuid {
        Uuid::parse_str("11223344-5566-7788-99aa-bbccddeeff00").unwrap()
    }

    #[test]
    fn output_round_trips() {
        let f = Frame::Output {
            task_id: tid(),
            seq: 0x0102_0304_0506_0708,
            data: b"hello \x1b[31mred\x1b[0m".to_vec(),
        };
        let bytes = f.encode();
        assert_eq!(bytes[0], KIND_OUTPUT);
        assert_eq!(Frame::decode(&bytes).unwrap(), f);
    }

    #[test]
    fn snapshot_round_trips() {
        let f = Frame::Snapshot {
            task_id: tid(),
            seq: 42,
            data: b"\x1b[2J\x1b[H$ ".to_vec(),
        };
        let bytes = f.encode();
        assert_eq!(bytes[0], KIND_SNAPSHOT);
        assert_eq!(Frame::decode(&bytes).unwrap(), f);
    }

    #[test]
    fn input_round_trips() {
        let f = Frame::Input {
            task_id: tid(),
            data: b"ls -la\r".to_vec(),
        };
        let bytes = f.encode();
        assert_eq!(bytes[0], KIND_INPUT);
        assert_eq!(Frame::decode(&bytes).unwrap(), f);
    }

    #[test]
    fn empty_data_round_trips() {
        for f in [
            Frame::Output {
                task_id: tid(),
                seq: 1,
                data: vec![],
            },
            Frame::Input {
                task_id: tid(),
                data: vec![],
            },
        ] {
            assert_eq!(Frame::decode(&f.encode()).unwrap(), f);
        }
    }

    #[test]
    fn task_id_is_16_raw_bytes() {
        let f = Frame::Input {
            task_id: tid(),
            data: vec![],
        };
        let bytes = f.encode();
        assert_eq!(&bytes[1..17], tid().as_bytes());
    }

    #[test]
    fn rejects_empty() {
        assert_eq!(Frame::decode(&[]), Err(FrameError::Empty));
    }

    #[test]
    fn rejects_unknown_kind() {
        assert_eq!(Frame::decode(&[0xff]), Err(FrameError::UnknownKind(0xff)));
    }

    #[test]
    fn rejects_too_short() {
        // OUTPUT with a truncated header (missing seq + part of uuid).
        assert_eq!(
            Frame::decode(&[KIND_OUTPUT, 0, 0, 0]),
            Err(FrameError::TooShort)
        );
        // INPUT with a truncated uuid.
        assert_eq!(
            Frame::decode(&[KIND_INPUT, 0, 0]),
            Err(FrameError::TooShort)
        );
    }
}
