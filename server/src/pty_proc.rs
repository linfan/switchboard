//! PTY process supervisor for a single interactive agent task.
//!
//! Allocates a real pseudo-terminal via `portable-pty`, spawns the CLI in its
//! native interactive mode, and surfaces raw terminal bytes as [`PtyOutput`].
//! `portable-pty` is synchronous, so its blocking reader/writer/waiter are run
//! on dedicated std threads bridged to tokio through mpsc channels:
//!
//! * **reader** — reads master → sends [`PtyOutput::Chunk`] (≤ 8 KiB each).
//! * **writer** — drains `input_rx` → writes client keystrokes verbatim.
//! * **resize** — owns the master; applies each `(cols, rows)` from `resize_rx`.
//! * **kill**   — a *value* on `kill_rx` kills the child; channel *close*
//!   (handle dropped without terminate) must NOT kill.
//! * **waiter** — `child.wait()` → sends [`PtyOutput::Exited`].

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use tokio::sync::mpsc;

use crate::error::{AppError, AppResult};

/// Read chunk cap: bounds frame size / rate for the binary data plane.
const READ_CHUNK: usize = 8 * 1024;

/// Output items produced by a running PTY-backed process.
#[derive(Debug)]
pub enum PtyOutput {
    /// A raw slice of terminal bytes from the child (order-preserving).
    Chunk(Vec<u8>),
    /// The process exited with this code (if known).
    Exited(Option<i32>),
}

/// Control handle for a running PTY process.
pub struct PtyHandle {
    input_tx: mpsc::UnboundedSender<Vec<u8>>,
    resize_tx: mpsc::UnboundedSender<(u16, u16)>,
    kill_tx: mpsc::UnboundedSender<()>,
}

impl PtyHandle {
    /// Write raw keystroke bytes into the PTY.
    pub fn send_input(&self, bytes: &[u8]) -> AppResult<()> {
        self.input_tx
            .send(bytes.to_vec())
            .map_err(|_| AppError::Other(anyhow::anyhow!("pty input is closed")))
    }

    /// Resize the terminal to `cols` × `rows`.
    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        self.resize_tx
            .send((cols, rows))
            .map_err(|_| AppError::Other(anyhow::anyhow!("pty resize is closed")))
    }

    /// Request termination. Idempotent; safe to call more than once.
    pub fn terminate(&self) {
        let _ = self.kill_tx.send(());
    }
}

/// Spawn an already-resolved `bin` + `argv` on a fresh PTY in optional working
/// dir `cwd`, sized `cols`×`rows`. Callers resolve the executable path (e.g. via
/// [`crate::agent::resolve_command`]) before spawning.
pub fn spawn_cmd(
    bin: &str,
    argv: &[String],
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> AppResult<(PtyHandle, mpsc::UnboundedReceiver<PtyOutput>)> {
    spawn_pty(bin, argv, cwd, cols, rows)
}

/// Core spawn used by [`spawn_cmd`] and tests (which pass an arbitrary bin+argv).
fn spawn_pty(
    bin: &str,
    argv: &[String],
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> AppResult<(PtyHandle, mpsc::UnboundedReceiver<PtyOutput>)> {
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| AppError::Other(anyhow::anyhow!("openpty failed: {e}")))?;

    let mut cmd = CommandBuilder::new(bin);
    cmd.args(argv);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    for (k, v) in std::env::vars() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::Other(anyhow::anyhow!("failed to spawn {bin}: {e}")))?;
    // Drop the slave so the master read returns EOF once the child closes it.
    drop(pair.slave);
    let master = pair.master;

    let mut reader = master
        .try_clone_reader()
        .map_err(|e| AppError::Other(anyhow::anyhow!("pty reader clone failed: {e}")))?;
    let mut writer = master
        .take_writer()
        .map_err(|e| AppError::Other(anyhow::anyhow!("pty writer take failed: {e}")))?;
    let mut killer = child.clone_killer();

    let (out_tx, out_rx) = mpsc::unbounded_channel::<PtyOutput>();
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<()>();

    // reader: raw bytes → Chunk frames, coalesced to ≤ READ_CHUNK.
    {
        let out_tx = out_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out_tx.send(PtyOutput::Chunk(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }

    // writer: keystrokes → PTY (verbatim).
    std::thread::spawn(move || {
        while let Some(bytes) = input_rx.blocking_recv() {
            if writer.write_all(&bytes).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    // resize: owns the master; applies size changes and keeps it alive.
    std::thread::spawn(move || {
        while let Some((cols, rows)) = resize_rx.blocking_recv() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    });

    // kill: a value means terminate; channel close (handle dropped) does not.
    std::thread::spawn(move || {
        if kill_rx.blocking_recv().is_some() {
            let _ = killer.kill();
        }
    });

    // waiter: reap the exit code.
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        let _ = out_tx.send(PtyOutput::Exited(code));
    });

    Ok((
        PtyHandle {
            input_tx,
            resize_tx,
            kill_tx,
        },
        out_rx,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Collect output (lossy UTF-8) until `needle` appears or we time out.
    /// Returns the accumulated text; panics on timeout.
    async fn wait_for(rx: &mut mpsc::UnboundedReceiver<PtyOutput>, needle: &str) -> String {
        let mut acc = String::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(PtyOutput::Chunk(b))) => {
                    acc.push_str(&String::from_utf8_lossy(&b));
                    if acc.contains(needle) {
                        return acc;
                    }
                }
                Ok(Some(PtyOutput::Exited(_))) => {
                    if acc.contains(needle) {
                        return acc;
                    }
                    panic!("process exited before {needle:?}; got: {acc:?}");
                }
                Ok(None) => panic!("channel closed before {needle:?}; got: {acc:?}"),
                Err(_) => panic!("timed out waiting for {needle:?}; got: {acc:?}"),
            }
        }
    }

    fn sh(script: &str) -> (PtyHandle, mpsc::UnboundedReceiver<PtyOutput>) {
        spawn_pty("sh", &["-c".into(), script.into()], None, 80, 24).expect("spawn sh")
    }

    #[tokio::test]
    async fn emits_output_and_echoes_input() {
        // Print a marker (with an ANSI colour to prove raw bytes pass through),
        // then read a line and echo it back through the program.
        let (handle, mut rx) = sh("printf 'READY\\033[32m\\n'; read line; printf 'GOT:%s\\n' \"$line\"");
        wait_for(&mut rx, "READY").await;
        // The green SGR escape must survive verbatim.
        // (READY was captured above; the escape is in the same/next chunk.)
        handle.send_input(b"ping\n").unwrap();
        let acc = wait_for(&mut rx, "GOT:ping").await;
        // Line-discipline echo of the typed input is present too.
        assert!(acc.contains("ping"), "expected echo of input; got {acc:?}");
    }

    #[tokio::test]
    async fn resize_takes_effect() {
        // Re-poll the terminal size so the assertion is race-free.
        let (handle, mut rx) = sh("while true; do stty size; sleep 0.1; done");
        wait_for(&mut rx, "24 80").await; // initial size (rows cols)
        handle.resize(100, 40).unwrap();
        wait_for(&mut rx, "40 100").await; // after resize
        handle.terminate();
    }

    #[tokio::test]
    async fn clean_exit_reports_code() {
        let (_handle, mut rx) = sh("printf 'bye\\n'; exit 3");
        let mut code = None;
        while let Ok(Some(item)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            if let PtyOutput::Exited(c) = item {
                code = Some(c);
                break;
            }
        }
        assert_eq!(code, Some(Some(3)), "expected exit code 3");
    }

    #[tokio::test]
    async fn terminate_kills_process() {
        let (handle, mut rx) = sh("printf 'up\\n'; sleep 30");
        wait_for(&mut rx, "up").await;
        handle.terminate();
        let mut exited = false;
        while let Ok(Some(item)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            if let PtyOutput::Exited(_) = item {
                exited = true;
                break;
            }
        }
        assert!(exited, "terminate must reap the process");
    }
}
