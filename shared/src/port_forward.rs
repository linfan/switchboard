//! Binary frames for multiplexed TCP forwarding over a WebSocket.
//!
//! ```text
//! [kind:1][stream_id:u64][payload...]
//! ```

use std::fmt;

pub const KIND_OPEN: u8 = 0x01;
pub const KIND_OPEN_OK: u8 = 0x02;
pub const KIND_OPEN_ERR: u8 = 0x03;
pub const KIND_DATA: u8 = 0x10;
pub const KIND_FIN: u8 = 0x11;
pub const KIND_RST: u8 = 0x12;

const STREAM_LEN: usize = 8;
const PORT_LEN: usize = 2;
pub const MAX_ERROR_LEN: usize = 1024;
pub const MAX_DATA_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortForwardFrame {
    Open { stream_id: u64, remote_port: u16 },
    OpenOk { stream_id: u64 },
    OpenErr { stream_id: u64, message: String },
    Data { stream_id: u64, data: Vec<u8> },
    Fin { stream_id: u64 },
    Rst { stream_id: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortForwardError {
    TooShort,
    UnknownKind(u8),
    InvalidPayload,
    DataTooLong,
    ErrorTooLong,
    InvalidErrorText,
}

impl fmt::Display for PortForwardError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooShort => write!(f, "port-forward frame shorter than its header"),
            Self::UnknownKind(kind) => write!(f, "unknown port-forward frame kind 0x{kind:02x}"),
            Self::InvalidPayload => write!(f, "invalid port-forward frame payload"),
            Self::DataTooLong => write!(f, "port-forward data frame exceeds the limit"),
            Self::ErrorTooLong => write!(f, "port-forward error message exceeds the limit"),
            Self::InvalidErrorText => write!(f, "port-forward error message is not UTF-8"),
        }
    }
}

impl std::error::Error for PortForwardError {}

impl PortForwardFrame {
    pub fn stream_id(&self) -> u64 {
        match self {
            Self::Open { stream_id, .. }
            | Self::OpenOk { stream_id }
            | Self::OpenErr { stream_id, .. }
            | Self::Data { stream_id, .. }
            | Self::Fin { stream_id }
            | Self::Rst { stream_id } => *stream_id,
        }
    }

    pub fn encode(&self) -> Vec<u8> {
        match self {
            Self::Open {
                stream_id,
                remote_port,
            } => {
                let mut out = header(KIND_OPEN, *stream_id, PORT_LEN);
                out.extend_from_slice(&remote_port.to_be_bytes());
                out
            }
            Self::OpenOk { stream_id } => header(KIND_OPEN_OK, *stream_id, 0),
            Self::OpenErr { stream_id, message } => {
                let mut out = header(KIND_OPEN_ERR, *stream_id, message.len());
                out.extend_from_slice(message.as_bytes());
                out
            }
            Self::Data { stream_id, data } => {
                let mut out = header(KIND_DATA, *stream_id, data.len());
                out.extend_from_slice(data);
                out
            }
            Self::Fin { stream_id } => header(KIND_FIN, *stream_id, 0),
            Self::Rst { stream_id } => header(KIND_RST, *stream_id, 0),
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PortForwardError> {
        if bytes.len() < 1 + STREAM_LEN {
            return Err(PortForwardError::TooShort);
        }
        let kind = bytes[0];
        let mut id = [0; STREAM_LEN];
        id.copy_from_slice(&bytes[1..1 + STREAM_LEN]);
        let stream_id = u64::from_be_bytes(id);
        let payload = &bytes[1 + STREAM_LEN..];

        match kind {
            KIND_OPEN => {
                if payload.len() != PORT_LEN {
                    return Err(PortForwardError::InvalidPayload);
                }
                let mut port = [0; PORT_LEN];
                port.copy_from_slice(payload);
                Ok(Self::Open {
                    stream_id,
                    remote_port: u16::from_be_bytes(port),
                })
            }
            KIND_OPEN_OK if payload.is_empty() => Ok(Self::OpenOk { stream_id }),
            KIND_OPEN_ERR => {
                if payload.len() > MAX_ERROR_LEN {
                    return Err(PortForwardError::ErrorTooLong);
                }
                let message = String::from_utf8(payload.to_vec())
                    .map_err(|_| PortForwardError::InvalidErrorText)?;
                Ok(Self::OpenErr { stream_id, message })
            }
            KIND_DATA if payload.len() <= MAX_DATA_LEN => Ok(Self::Data {
                stream_id,
                data: payload.to_vec(),
            }),
            KIND_DATA => Err(PortForwardError::DataTooLong),
            KIND_FIN if payload.is_empty() => Ok(Self::Fin { stream_id }),
            KIND_RST if payload.is_empty() => Ok(Self::Rst { stream_id }),
            KIND_OPEN_OK | KIND_FIN | KIND_RST => Err(PortForwardError::InvalidPayload),
            other => Err(PortForwardError::UnknownKind(other)),
        }
    }
}

fn header(kind: u8, stream_id: u64, payload_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + STREAM_LEN + payload_len);
    out.push(kind);
    out.extend_from_slice(&stream_id.to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const STREAM: u64 = 0x0102_0304_0506_0708;

    #[test]
    fn frames_round_trip() {
        let frames = [
            PortForwardFrame::Open {
                stream_id: STREAM,
                remote_port: 5432,
            },
            PortForwardFrame::OpenOk { stream_id: STREAM },
            PortForwardFrame::OpenErr {
                stream_id: STREAM,
                message: "connection refused".into(),
            },
            PortForwardFrame::Data {
                stream_id: STREAM,
                data: b"\0hello\xff".to_vec(),
            },
            PortForwardFrame::Fin { stream_id: STREAM },
            PortForwardFrame::Rst { stream_id: STREAM },
        ];
        for frame in frames {
            assert_eq!(PortForwardFrame::decode(&frame.encode()).unwrap(), frame);
        }
    }

    #[test]
    fn rejects_malformed_frames() {
        assert_eq!(
            PortForwardFrame::decode(&[]),
            Err(PortForwardError::TooShort)
        );
        assert_eq!(
            PortForwardFrame::decode(&[0xff, 0, 0, 0, 0, 0, 0, 0, 1]),
            Err(PortForwardError::UnknownKind(0xff))
        );
        assert_eq!(
            PortForwardFrame::decode(&[KIND_OPEN, 0, 0, 0, 0, 0, 0, 0, 1]),
            Err(PortForwardError::InvalidPayload)
        );
    }
}
