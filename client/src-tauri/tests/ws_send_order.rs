//! Ordering guarantees on the webview → Rust IPC hop that carries keystrokes.
//!
//! `tauriSocket.ts` sends every frame through a promise chain so that at most one
//! `ws_send` is in flight per socket. These tests pin down *why* that is load
//! bearing rather than redundant, by modelling both dispatch styles against the
//! shape of `net.rs::send_frame` (decode base64, take the connection lock, push
//! onto that connection's unbounded mpsc). The connection map is private to
//! `net.rs` — which tests it directly in `net::tests` — so the map here is a
//! faithful stand-in; what these tests actually measure is scheduler behaviour.
//!
//! Tauri runs each async command invocation as its own task on a multi-threaded
//! runtime (`tauri-2.11.5/src/ipc/mod.rs:329`, `:375`), and the webview issues
//! each invocation as an independent `fetch`
//! (`tauri-2.11.5/scripts/ipc-protocol.js:36-42`). Neither hop preserves dispatch
//! order, so fire-and-forget sends reach the socket scrambled — which the user
//! experiences as characters missing from the command they typed, because a `\r`
//! that overtakes trailing bytes makes the shell run an incomplete command.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_tungstenite::tungstenite::Message;

/// Mirrors `net::WsInner`: connection id -> that connection's outbound queue.
#[derive(Default)]
struct Conns {
    map: AsyncMutex<HashMap<u64, mpsc::UnboundedSender<Message>>>,
}

/// Mirrors the body of `net::send_frame`.
async fn send_frame(conns: Arc<Conns>, id: u64, b64: String) {
    let msg = Message::Binary(
        base64::engine::general_purpose::STANDARD
            .decode(&b64)
            .expect("valid base64"),
    );
    if let Some(tx) = conns.map.lock().await.get(&id) {
        let _ = tx.send(msg);
    }
}

const FRAMES: u64 = 4000;
const CONN: u64 = 1;

/// Each payload carries its own send index, so arrival order is observable.
fn payload(i: u64) -> String {
    base64::engine::general_purpose::STANDARD.encode(i.to_be_bytes())
}

fn index_of(msg: Message) -> u64 {
    match msg {
        Message::Binary(b) => {
            let mut raw = [0u8; 8];
            raw.copy_from_slice(&b);
            u64::from_be_bytes(raw)
        }
        other => panic!("expected a binary frame, got {other:?}"),
    }
}

async fn drain(rx: &mut mpsc::UnboundedReceiver<Message>) -> Vec<u64> {
    let mut got = Vec::with_capacity(FRAMES as usize);
    while let Some(msg) = rx.recv().await {
        got.push(index_of(msg));
        if got.len() as u64 == FRAMES {
            break;
        }
    }
    got
}

/// Adjacent pairs that arrived out of order.
fn transpositions(got: &[u64]) -> usize {
    got.windows(2).filter(|w| w[1] != w[0] + 1).count()
}

fn assert_complete(got: &[u64]) {
    assert_eq!(got.len() as u64, FRAMES, "frames were lost");
}

/// The hazard: one spawned task per frame, which is exactly what a fire-and-forget
/// `invoke("ws_send", ...)` produces. Nothing is *lost* — the channel is unbounded
/// — but frames arrive scrambled, and nothing downstream can detect it.
///
/// The measured rate is ~63% of adjacent pairs, so zero violations would mean the
/// platform changed enough to invalidate the justification for the chain in
/// `tauriSocket.ts`. Catching that is the point of this test.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_sends_reorder_frames() {
    let conns = Arc::new(Conns::default());
    let (tx, mut rx) = mpsc::unbounded_channel();
    conns.map.lock().await.insert(CONN, tx);

    for i in 0..FRAMES {
        let c = Arc::clone(&conns);
        let frame = payload(i);
        // Tauri spawns one task per command invocation; nothing serializes them.
        tokio::spawn(async move { send_frame(c, CONN, frame).await });
        // Let the runtime interleave them, as a busy webview would.
        if i % 16 == 15 {
            tokio::task::yield_now().await;
        }
    }

    let got = drain(&mut rx).await;
    assert_complete(&got);
    let scrambled = transpositions(&got);
    assert!(
        scrambled > 0,
        "concurrent dispatch preserved order, so the serializing chain in \
         tauriSocket.ts may no longer be load bearing"
    );
}

/// The guarantee the chain buys: holding one send in flight at a time delivers
/// every frame exactly once, in order. This is the invariant the keystroke path
/// depends on, so it must never regress.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn serialized_sends_preserve_order() {
    let conns = Arc::new(Conns::default());
    let (tx, mut rx) = mpsc::unbounded_channel();
    conns.map.lock().await.insert(CONN, tx);

    for i in 0..FRAMES {
        let c = Arc::clone(&conns);
        let frame = payload(i);
        // Await each one before issuing the next, as the promise chain does.
        tokio::spawn(async move { send_frame(c, CONN, frame).await })
            .await
            .expect("send task panicked");
    }

    let got = drain(&mut rx).await;
    assert_complete(&got);
    assert_eq!(
        transpositions(&got),
        0,
        "serialized dispatch must preserve order exactly"
    );
    assert_eq!(got.first(), Some(&0));
    assert_eq!(got.last(), Some(&(FRAMES - 1)));
}

/// Removing the `await` before the enqueue does not help: the race is in which
/// spawned task the scheduler polls first, not in the lock. This rules out the
/// tempting one-line "fix" of swapping `AsyncMutex` for a synchronous one.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn a_synchronous_lock_does_not_fix_concurrent_dispatch() {
    struct Sync {
        map: std::sync::Mutex<HashMap<u64, mpsc::UnboundedSender<Message>>>,
    }
    let conns = Arc::new(Sync {
        map: std::sync::Mutex::new(HashMap::new()),
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    conns.map.lock().unwrap().insert(CONN, tx);

    for i in 0..FRAMES {
        let c = Arc::clone(&conns);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload(i))
            .expect("valid base64");
        tokio::spawn(async move {
            // No await point between the task starting and the enqueue.
            let msg = Message::Binary(bytes);
            if let Some(tx) = c.map.lock().unwrap().get(&CONN) {
                let _ = tx.send(msg);
            }
        });
        if i % 16 == 15 {
            tokio::task::yield_now().await;
        }
    }

    let got = drain(&mut rx).await;
    assert_complete(&got);
    assert!(
        transpositions(&got) > 0,
        "a synchronous lock made concurrent dispatch ordered, so the root cause \
         may not be task scheduling after all"
    );
}
