use std::collections::HashMap;
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use switchboard_shared::port_forward::{PortForwardFrame, MAX_DATA_LEN, MAX_ERROR_LEN};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
    task::JoinHandle,
    time::timeout,
};

use crate::{state::SharedState, ws};

const IN_BUF: usize = 64;
const OUT_BUF: usize = 512;
const STREAM_BUF: usize = 64;
const EVENT_BUF: usize = 256;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Per-session cap on concurrent TCP streams. Each stream owns a worker-side
/// socket and a bridge task, so an unbounded map lets a local process (or a
/// buggy client) exhaust the worker's fds. 256 covers browsers and connection
/// pools over a loopback forward with plenty of headroom.
const MAX_STREAMS: usize = 256;

pub async fn handler(State(state): State<SharedState>, ws: WebSocketUpgrade) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();
    if !ws::ws_handshake(
        &mut sink,
        &mut stream,
        state.config.token.as_deref(),
        &state.cert_fp,
    )
    .await
    {
        return;
    }

    let (in_tx, in_rx) = mpsc::channel::<Vec<u8>>(IN_BUF);
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(OUT_BUF);

    tokio::spawn(async move {
        while let Some(Ok(message)) = stream.next().await {
            let Message::Binary(bytes) = message else {
                if matches!(message, Message::Close(_)) {
                    break;
                }
                continue;
            };
            if in_tx.send(bytes.to_vec()).await.is_err() {
                return;
            }
        }
    });

    tokio::spawn(async move {
        while let Some(bytes) = out_rx.recv().await {
            if sink.send(Message::Binary(bytes.into())).await.is_err() {
                return;
            }
        }
    });

    run_session(in_rx, out_tx).await;
}

pub async fn run_session(mut rx: mpsc::Receiver<Vec<u8>>, out_tx: mpsc::Sender<Vec<u8>>) {
    let (event_tx, mut event_rx) = mpsc::channel::<BridgeEvent>(EVENT_BUF);
    let mut streams = HashMap::<u64, StreamEntry>::new();
    let mut next_generation = 0u64;

    loop {
        tokio::select! {
            incoming = rx.recv() => {
                let Some(bytes) = incoming else { break; };
                let frame = match PortForwardFrame::decode(&bytes) {
                    Ok(frame) => frame,
                    Err(error) => {
                        tracing::warn!(%error, "invalid port-forward frame");
                        continue;
                    }
                };
                match frame {
                    PortForwardFrame::Open { stream_id, remote_port } => {
                        if remote_port == 0 {
                            if !send(&out_tx, PortForwardFrame::OpenErr {
                                stream_id,
                                message: "remote port must be nonzero".into(),
                            }).await {
                                break;
                            }
                            continue;
                        }
                        if streams.contains_key(&stream_id) {
                            if !send(&out_tx, PortForwardFrame::Rst { stream_id }).await {
                                break;
                            }
                            continue;
                        }
                        if streams.len() >= MAX_STREAMS {
                            tracing::warn!(
                                stream = stream_id,
                                max = MAX_STREAMS,
                                "forward stream limit reached; rejecting open"
                            );
                            if !send(&out_tx, PortForwardFrame::OpenErr {
                                stream_id,
                                message: format!("too many streams (max {MAX_STREAMS})"),
                            }).await {
                                break;
                            }
                            continue;
                        }
                        next_generation = next_generation.wrapping_add(1);
                        let generation = next_generation;
                        let (stream_tx, stream_rx) = mpsc::channel(STREAM_BUF);
                        // Keep the task handle so teardown can abort it: a bridge
                        // stuck in `write_all` on a target that stopped reading
                        // otherwise ignores RST/session close and pins the socket.
                        let task = tokio::spawn(bridge_remote(
                            stream_id,
                            generation,
                            remote_port,
                            stream_rx,
                            event_tx.clone(),
                        ));
                        streams.insert(stream_id, StreamEntry {
                            generation,
                            tx: stream_tx,
                            task,
                        });
                    }
                    PortForwardFrame::Data { stream_id, data } => {
                        let Some(entry) = streams.get(&stream_id) else { continue };
                        match entry.tx.try_send(ClientEvent::Data(data)) {
                            Ok(()) => {}
                            Err(mpsc::error::TrySendError::Full(_)) => {
                                streams.remove(&stream_id);
                                tracing::warn!(
                                    stream = stream_id,
                                    "forward stream queue full; resetting"
                                );
                                if !send(&out_tx, PortForwardFrame::Rst { stream_id }).await {
                                    break;
                                }
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => {
                                streams.remove(&stream_id);
                            }
                        }
                    }
                    PortForwardFrame::Fin { stream_id } => {
                        let Some(entry) = streams.get(&stream_id) else { continue };
                        match entry.tx.try_send(ClientEvent::Fin) {
                            Ok(()) => {}
                            Err(mpsc::error::TrySendError::Full(_)) => {
                                streams.remove(&stream_id);
                                tracing::warn!(
                                    stream = stream_id,
                                    "forward stream queue full; resetting"
                                );
                                if !send(&out_tx, PortForwardFrame::Rst { stream_id }).await {
                                    break;
                                }
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => {
                                streams.remove(&stream_id);
                            }
                        }
                    }
                    PortForwardFrame::Rst { stream_id } => {
                        // Dropping the entry aborts a bridge blocked on a write.
                        streams.remove(&stream_id);
                    }
                    PortForwardFrame::OpenOk { .. } | PortForwardFrame::OpenErr { .. } => {
                        tracing::warn!("unexpected server-bound port-forward response");
                    }
                }
            }
            event = event_rx.recv() => {
                let Some(event) = event else { break; };
                if streams.get(&event.stream_id()).is_none_or(|entry| entry.generation != event.generation()) {
                    continue;
                }
                let stream_id = event.stream_id();
                let terminal = event.is_terminal();
                if let Some(frame) = event.frame() {
                    if !send(&out_tx, frame).await {
                        break;
                    }
                }
                if terminal {
                    streams.remove(&stream_id);
                }
            }
        }
    }

    // Dropping every entry aborts its bridge, including one wedged in a write
    // to a target that stopped reading; the session must not leave sockets open.
    streams.clear();
}

async fn send(tx: &mpsc::Sender<Vec<u8>>, frame: PortForwardFrame) -> bool {
    tx.send(frame.encode()).await.is_ok()
}

struct StreamEntry {
    generation: u64,
    tx: mpsc::Sender<ClientEvent>,
    task: JoinHandle<()>,
}

impl Drop for StreamEntry {
    fn drop(&mut self) {
        self.task.abort();
    }
}

enum ClientEvent {
    Data(Vec<u8>),
    Fin,
}

enum BridgeEvent {
    OpenOk {
        stream_id: u64,
        generation: u64,
    },
    OpenErr {
        stream_id: u64,
        generation: u64,
        message: String,
    },
    Data {
        stream_id: u64,
        generation: u64,
        data: Vec<u8>,
    },
    Fin {
        stream_id: u64,
        generation: u64,
    },
    Rst {
        stream_id: u64,
        generation: u64,
    },
    Ended {
        stream_id: u64,
        generation: u64,
    },
}

impl BridgeEvent {
    fn stream_id(&self) -> u64 {
        match self {
            Self::OpenOk { stream_id, .. }
            | Self::OpenErr { stream_id, .. }
            | Self::Data { stream_id, .. }
            | Self::Fin { stream_id, .. }
            | Self::Rst { stream_id, .. }
            | Self::Ended { stream_id, .. } => *stream_id,
        }
    }

    fn generation(&self) -> u64 {
        match self {
            Self::OpenOk { generation, .. }
            | Self::OpenErr { generation, .. }
            | Self::Data { generation, .. }
            | Self::Fin { generation, .. }
            | Self::Rst { generation, .. }
            | Self::Ended { generation, .. } => *generation,
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::OpenErr { .. } | Self::Rst { .. } | Self::Ended { .. }
        )
    }

    fn frame(self) -> Option<PortForwardFrame> {
        match self {
            Self::OpenOk { stream_id, .. } => Some(PortForwardFrame::OpenOk { stream_id }),
            Self::OpenErr {
                stream_id, message, ..
            } => Some(PortForwardFrame::OpenErr { stream_id, message }),
            Self::Data {
                stream_id, data, ..
            } => Some(PortForwardFrame::Data { stream_id, data }),
            Self::Fin { stream_id, .. } => Some(PortForwardFrame::Fin { stream_id }),
            Self::Rst { stream_id, .. } => Some(PortForwardFrame::Rst { stream_id }),
            Self::Ended { .. } => None,
        }
    }
}

async fn bridge_remote(
    stream_id: u64,
    generation: u64,
    remote_port: u16,
    mut client_rx: mpsc::Receiver<ClientEvent>,
    event_tx: mpsc::Sender<BridgeEvent>,
) {
    let stream = match timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, remote_port)),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(error)) => {
            let _ = event_tx
                .send(BridgeEvent::OpenErr {
                    stream_id,
                    generation,
                    message: bounded_error(&error.to_string()),
                })
                .await;
            return;
        }
        Err(_) => {
            let _ = event_tx
                .send(BridgeEvent::OpenErr {
                    stream_id,
                    generation,
                    message: "remote connection timed out".into(),
                })
                .await;
            return;
        }
    };

    if event_tx
        .send(BridgeEvent::OpenOk {
            stream_id,
            generation,
        })
        .await
        .is_err()
    {
        return;
    }

    let (mut read, mut write) = stream.into_split();
    let mut buffer = vec![0; MAX_DATA_LEN.min(32 * 1024)];
    let mut client_finished = false;
    let mut remote_finished = false;
    let mut reset = false;

    while !(client_finished && remote_finished) {
        tokio::select! {
            client = client_rx.recv(), if !client_finished => {
                match client {
                    Some(ClientEvent::Data(data)) => {
                        if write.write_all(&data).await.is_err() {
                            reset = true;
                            break;
                        }
                    }
                    Some(ClientEvent::Fin) => {
                        if write.shutdown().await.is_err() {
                            reset = true;
                            break;
                        }
                        client_finished = true;
                    }
                    // The entry was dropped (RST, session teardown, queue
                    // overflow); its socket is gone with it.
                    None => {
                        reset = true;
                        break;
                    }
                }
            }
            remote = read.read(&mut buffer), if !remote_finished => {
                match remote {
                    Ok(0) => {
                        remote_finished = true;
                        if event_tx.send(BridgeEvent::Fin { stream_id, generation }).await.is_err() {
                            return;
                        }
                    }
                    Ok(count) => {
                        if event_tx.send(BridgeEvent::Data {
                            stream_id,
                            generation,
                            data: buffer[..count].to_vec(),
                        }).await.is_err() {
                            return;
                        }
                    }
                    Err(_) => {
                        reset = true;
                        break;
                    }
                }
            }
        }
    }

    if reset {
        let _ = event_tx
            .send(BridgeEvent::Rst {
                stream_id,
                generation,
            })
            .await;
    } else {
        let _ = event_tx
            .send(BridgeEvent::Ended {
                stream_id,
                generation,
            })
            .await;
    }
}

fn bounded_error(message: &str) -> String {
    message.chars().take(MAX_ERROR_LEN).collect()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::mpsc,
        sync::Notify,
    };

    use super::*;

    async fn next_frame(rx: &mut mpsc::Receiver<Vec<u8>>) -> PortForwardFrame {
        let bytes = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("timed out waiting for forward frame")
            .expect("forward session ended");
        PortForwardFrame::decode(&bytes).unwrap()
    }

    #[tokio::test]
    async fn proxies_loopback_tcp_and_preserves_half_close() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
            stream.shutdown().await.unwrap();
        });

        let (in_tx, in_rx) = mpsc::channel(8);
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let session = tokio::spawn(run_session(in_rx, out_tx));
        let stream_id = 7;

        in_tx
            .send(
                PortForwardFrame::Open {
                    stream_id,
                    remote_port: port,
                }
                .encode(),
            )
            .await
            .unwrap();
        assert_eq!(
            next_frame(&mut out_rx).await,
            PortForwardFrame::OpenOk { stream_id }
        );

        in_tx
            .send(
                PortForwardFrame::Data {
                    stream_id,
                    data: b"ping".to_vec(),
                }
                .encode(),
            )
            .await
            .unwrap();
        in_tx
            .send(PortForwardFrame::Fin { stream_id }.encode())
            .await
            .unwrap();

        assert_eq!(
            next_frame(&mut out_rx).await,
            PortForwardFrame::Data {
                stream_id,
                data: b"ping".to_vec(),
            }
        );
        assert_eq!(
            next_frame(&mut out_rx).await,
            PortForwardFrame::Fin { stream_id }
        );

        drop(in_tx);
        session.await.unwrap();
        echo.await.unwrap();
    }

    #[tokio::test]
    async fn a_stalled_stream_does_not_block_the_session() {
        // A target that accepts but never reads: its bridge eventually wedges in
        // `write_all` and its 64-slot inbound queue fills.
        let stalled = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stalled_port = stalled.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = stalled.accept().await.unwrap();
            std::future::pending::<()>().await;
            drop(stream);
        });

        let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo_listener.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let (mut stream, _) = echo_listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            stream.read_to_end(&mut bytes).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
            stream.shutdown().await.unwrap();
        });

        let (in_tx, in_rx) = mpsc::channel(8);
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let session = tokio::spawn(run_session(in_rx, out_tx));

        let stalled_id = 7;
        in_tx
            .send(
                PortForwardFrame::Open {
                    stream_id: stalled_id,
                    remote_port: stalled_port,
                }
                .encode(),
            )
            .await
            .unwrap();
        assert_eq!(
            next_frame(&mut out_rx).await,
            PortForwardFrame::OpenOk {
                stream_id: stalled_id
            }
        );

        // More data than the queue plus the kernel socket buffers can absorb.
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            let mut reset_seen = false;
            for _ in 0..512 {
                in_tx
                    .send(
                        PortForwardFrame::Data {
                            stream_id: stalled_id,
                            data: vec![0u8; MAX_DATA_LEN.min(32 * 1024)],
                        }
                        .encode(),
                    )
                    .await
                    .unwrap();
            }

            // A brand-new stream must still open and carry data on the same
            // session while the first one is wedged.
            let healthy_id = 8;
            in_tx
                .send(
                    PortForwardFrame::Open {
                        stream_id: healthy_id,
                        remote_port: echo_port,
                    }
                    .encode(),
                )
                .await
                .unwrap();
            loop {
                match next_frame(&mut out_rx).await {
                    PortForwardFrame::OpenOk { stream_id } if stream_id == healthy_id => break,
                    PortForwardFrame::Rst { stream_id } if stream_id == stalled_id => {
                        reset_seen = true;
                    }
                    _ => {}
                }
            }
            assert!(
                reset_seen,
                "the stalled stream should have been reset once its queue filled"
            );
            in_tx
                .send(
                    PortForwardFrame::Data {
                        stream_id: healthy_id,
                        data: b"ping".to_vec(),
                    }
                    .encode(),
                )
                .await
                .unwrap();
            in_tx
                .send(
                    PortForwardFrame::Fin {
                        stream_id: healthy_id,
                    }
                    .encode(),
                )
                .await
                .unwrap();
            assert_eq!(
                next_frame(&mut out_rx).await,
                PortForwardFrame::Data {
                    stream_id: healthy_id,
                    data: b"ping".to_vec(),
                }
            );
            assert_eq!(
                next_frame(&mut out_rx).await,
                PortForwardFrame::Fin {
                    stream_id: healthy_id
                }
            );
        })
        .await;
        assert!(
            result.is_ok(),
            "the stalled stream blocked the whole session"
        );

        drop(in_tx);
        session.await.unwrap();
        echo.await.unwrap();
    }

    #[tokio::test]
    async fn stream_teardown_aborts_a_bridge_blocked_on_write() {
        // A target that accepts but never reads: writes eventually wedge.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
            drop(stream);
        });

        let (event_tx, mut event_rx) = mpsc::channel(8);
        let (stream_tx, stream_rx) = mpsc::channel(1);
        let finished = Arc::new(Notify::new());
        struct Probe(Arc<Notify>);
        impl Drop for Probe {
            fn drop(&mut self) {
                self.0.notify_one();
            }
        }
        let probe = Probe(finished.clone());
        let task = tokio::spawn(async move {
            let _probe = probe;
            bridge_remote(0, 0, port, stream_rx, event_tx).await;
        });
        assert!(matches!(
            event_rx.recv().await.unwrap(),
            BridgeEvent::OpenOk { .. }
        ));

        // Feed until the write queue stays full across a pause: the bridge is
        // now parked in `write_all`, where no queued event can reach it.
        let mut wedged = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            if stream_tx
                .try_send(ClientEvent::Data(vec![0u8; 32 * 1024]))
                .is_ok()
            {
                continue;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            if stream_tx
                .try_send(ClientEvent::Data(vec![0u8; 32 * 1024]))
                .is_err()
            {
                wedged = true;
                break;
            }
        }
        assert!(wedged, "the bridge never blocked on its write");

        let entry = StreamEntry {
            generation: 0,
            tx: stream_tx,
            task,
        };
        drop(entry);

        tokio::time::timeout(Duration::from_secs(1), finished.notified())
            .await
            .expect("tearing down the stream must abort the blocked bridge");
    }

    #[tokio::test]
    async fn rejects_opens_past_the_stream_limit() {
        // Accept and hold every connection so the streams stay live.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream);
            }
        });

        let (in_tx, in_rx) = mpsc::channel(8);
        let (out_tx, mut out_rx) = mpsc::channel(8);
        let session = tokio::spawn(run_session(in_rx, out_tx));

        for stream_id in 1..=MAX_STREAMS as u64 {
            in_tx
                .send(
                    PortForwardFrame::Open {
                        stream_id,
                        remote_port: port,
                    }
                    .encode(),
                )
                .await
                .unwrap();
            assert_eq!(
                next_frame(&mut out_rx).await,
                PortForwardFrame::OpenOk { stream_id }
            );
        }

        let rejected = MAX_STREAMS as u64 + 1;
        in_tx
            .send(
                PortForwardFrame::Open {
                    stream_id: rejected,
                    remote_port: port,
                }
                .encode(),
            )
            .await
            .unwrap();
        match next_frame(&mut out_rx).await {
            PortForwardFrame::OpenErr { stream_id, message } => {
                assert_eq!(stream_id, rejected);
                assert!(
                    message.contains("too many streams"),
                    "unexpected: {message}"
                );
            }
            other => panic!("expected OpenErr, got {other:?}"),
        }

        // Releasing a stream frees a slot.
        in_tx
            .send(PortForwardFrame::Rst { stream_id: 1 }.encode())
            .await
            .unwrap();
        in_tx
            .send(
                PortForwardFrame::Open {
                    stream_id: rejected + 1,
                    remote_port: port,
                }
                .encode(),
            )
            .await
            .unwrap();
        assert_eq!(
            next_frame(&mut out_rx).await,
            PortForwardFrame::OpenOk {
                stream_id: rejected + 1
            }
        );

        drop(in_tx);
        session.await.unwrap();
    }
}
