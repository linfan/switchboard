//! PTY process supervisor for a single interactive agent task. This runs inside
//! a pty-host process (see [`crate::host`]), never in the server itself — the
//! server owns no PTY, which is what lets it be replaced without killing tasks.
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

/// Depth of the output channel. Bounded on purpose: when the consumer stops
/// draining (a pty-host whose unacked buffer is full because no server is
/// listening), the reader thread blocks, the PTY's own buffer fills, and the
/// agent blocks on write. Backpressure all the way to the process is what makes
/// a server restart lossless instead of merely large.
pub const OUTPUT_DEPTH: usize = 32;

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
    /// OS process id of the spawned child, when the platform reports one. Used
    /// to check liveness after a server restart (the child may be orphaned but
    /// still running).
    pid: Option<u32>,
}

impl PtyHandle {
    /// OS process id of the child, if known.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

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

/// Locale forced on the child when the agent's own environment carries none.
///
/// Service supervisors hand us a bare environment: launchd injects no locale vars
/// the way Terminal.app does, and an nssm-started service has none either. A
/// shell in the C locale drops multibyte handling, so zsh's ZLE judges each UTF-8
/// byte on its own and `拉` comes back as `æ<008b><0089>`. `C.UTF-8` ships with
/// macOS and with glibc/musl Linux, and leaves C collation semantics alone.
const DEFAULT_LOCALE: &str = "C.UTF-8";

/// True when the environment already pins a character-encoding locale. We then
/// stay out of it: an explicit `LANG=C` is an operator choice, not a gap.
fn has_locale(env: &[(String, String)]) -> bool {
    env.iter()
        .any(|(k, v)| !v.is_empty() && matches!(k.as_str(), "LC_ALL" | "LC_CTYPE" | "LANG"))
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
) -> AppResult<(PtyHandle, mpsc::Receiver<PtyOutput>)> {
    spawn_pty(bin, argv, cwd, cols, rows)
}

/// Core spawn used by [`spawn_cmd`] and tests (which pass an arbitrary bin+argv).
fn spawn_pty(
    bin: &str,
    argv: &[String],
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> AppResult<(PtyHandle, mpsc::Receiver<PtyOutput>)> {
    let size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| AppError::Other(anyhow::anyhow!("openpty failed: {e}")))?;

    let env: Vec<(String, String)> = std::env::vars().collect();
    let needs_locale = !has_locale(&env);
    let mut cmd = CommandBuilder::new(bin);
    cmd.args(argv);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    if needs_locale {
        cmd.env("LANG", DEFAULT_LOCALE);
    }

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

    let (out_tx, out_rx) = mpsc::channel::<PtyOutput>(OUTPUT_DEPTH);
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<()>();

    // reader: raw bytes → Chunk frames, coalesced to ≤ READ_CHUNK. `blocking_send`
    // is the backpressure hinge described on `OUTPUT_DEPTH`.
    {
        let out_tx = out_tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out_tx
                            .blocking_send(PtyOutput::Chunk(buf[..n].to_vec()))
                            .is_err()
                        {
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

    // Capture the pid before the child is moved into the waiter thread.
    let pid = child.process_id();

    // waiter: reap the exit code.
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|s| s.exit_code() as i32);
        let _ = out_tx.blocking_send(PtyOutput::Exited(code));
    });

    Ok((
        PtyHandle {
            input_tx,
            resize_tx,
            kill_tx,
            pid,
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
    async fn wait_for(rx: &mut mpsc::Receiver<PtyOutput>, needle: &str) -> String {
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

    #[cfg(unix)]
    fn sh(script: &str) -> (PtyHandle, mpsc::Receiver<PtyOutput>) {
        spawn_pty("sh", &["-c".into(), script.into()], None, 80, 24).expect("spawn sh")
    }

    #[test]
    fn keeps_a_locale_the_operator_pinned() {
        assert!(has_locale(&[("LANG".into(), "C".into())]));
        assert!(has_locale(&[("LC_ALL".into(), "zh_CN.UTF-8".into())]));
        assert!(has_locale(&[("LC_CTYPE".into(), "UTF-8".into())]));
    }

    #[test]
    fn supplies_a_locale_when_the_environment_has_none() {
        // The bare environment a launchd daemon (or an nssm service) hands us.
        let daemon_env: Vec<(String, String)> = [
            ("HOME", "/Users/x"),
            ("PATH", "/usr/local/bin:/usr/bin:/bin"),
            ("SHELL", "/bin/zsh"),
            ("TERM", "xterm-256color"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert!(!has_locale(&daemon_env));
        assert!(!has_locale(&[]));
        // An empty var is not a choice.
        assert!(!has_locale(&[("LANG".into(), String::new())]));
    }

    /// The child must always end up with *some* locale. Run this test binary
    /// under `env -i` to exercise the [`DEFAULT_LOCALE`] fallback: a service
    /// manager gives the agent no locale vars, and without the fallback the
    /// value below comes back empty — i.e. the C locale, i.e. mangled CJK.
    #[cfg(unix)]
    #[tokio::test]
    async fn child_always_gets_a_locale() {
        let (_handle, mut rx) = sh("printf 'LOCALE=%s\\n' \"${LC_ALL-}${LC_CTYPE-}${LANG-}\"");
        let acc = wait_for(&mut rx, "LOCALE=").await;
        let value = acc
            .split_once("LOCALE=")
            .expect("LOCALE= marker")
            .1
            .split(['\r', '\n'])
            .next()
            .unwrap_or_default();
        assert!(!value.is_empty(), "child got no locale; output {acc:?}");
    }

    /// A bare interactive `cmd.exe` on a ConPTY must echo typed commands and run
    /// them — the Windows equivalent of the `sh` round-trip below.
    #[cfg(windows)]
    #[tokio::test]
    async fn cmd_shell_round_trip() {
        let (handle, mut rx) = spawn_pty("cmd.exe", &[], None, 80, 24).expect("spawn cmd.exe");
        handle.send_input(b"echo PING\r\n").unwrap();
        wait_for(&mut rx, "PING").await;
        handle.terminate();
    }

    /// PowerShell is the other shell a Windows host is expected to serve.
    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_round_trip() {
        let (handle, mut rx) =
            spawn_pty("powershell.exe", &["-NoLogo".into()], None, 80, 24).expect("spawn pwsh");
        handle.send_input(b"Write-Output PING\r\n").unwrap();
        wait_for(&mut rx, "PING").await;
        handle.terminate();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn emits_output_and_echoes_input() {
        // Print a marker (with an ANSI colour to prove raw bytes pass through),
        // then read a line and echo it back through the program.
        let (handle, mut rx) =
            sh("printf 'READY\\033[32m\\n'; read line; printf 'GOT:%s\\n' \"$line\"");
        wait_for(&mut rx, "READY").await;
        // The green SGR escape must survive verbatim.
        // (READY was captured above; the escape is in the same/next chunk.)
        handle.send_input(b"ping\n").unwrap();
        let acc = wait_for(&mut rx, "GOT:ping").await;
        // Line-discipline echo of the typed input is present too.
        assert!(acc.contains("ping"), "expected echo of input; got {acc:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resize_takes_effect() {
        // Re-poll the terminal size so the assertion is race-free.
        let (handle, mut rx) = sh("while true; do stty size; sleep 0.1; done");
        wait_for(&mut rx, "24 80").await; // initial size (rows cols)
        handle.resize(100, 40).unwrap();
        wait_for(&mut rx, "40 100").await; // after resize
        handle.terminate();
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
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
