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
#[cfg(unix)]
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};
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
    /// OS process id of the spawned child, when the platform reports one. Used
    /// to check liveness after a server restart (the child may be orphaned but
    /// still running).
    pid: Option<u32>,
    /// Raw master-PTY file descriptor (unix). Captured so a self-upgrade re-exec
    /// can hand the *same* fd to the replacement process and keep the task live
    /// across the restart. `None` on non-unix or when unavailable.
    master_fd: Option<i32>,
}

impl PtyHandle {
    /// OS process id of the child, if known.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Raw master-PTY fd (unix), for inheriting this live PTY across an
    /// `execve`-based self-upgrade. `None` on non-unix / when unavailable.
    pub fn master_fd(&self) -> Option<i32> {
        self.master_fd
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

    // Capture the master's raw fd before the master is moved into the resize
    // thread, so a self-upgrade can inherit this live PTY across the re-exec.
    #[cfg(unix)]
    let master_fd = master.as_raw_fd();
    #[cfg(not(unix))]
    let master_fd: Option<i32> = None;

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

    // Capture the pid before the child is moved into the waiter thread.
    let pid = child.process_id();

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
            pid,
            master_fd,
        },
        out_rx,
    ))
}

/// Set a PTY's window size via `ioctl(TIOCSWINSZ)` on its master fd.
#[cfg(unix)]
pub fn set_winsize(fd: RawFd, cols: u16, rows: u16) {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: `fd` is a live master PTY; the ioctl only reads `ws`.
    unsafe {
        libc::ioctl(fd, libc::TIOCSWINSZ as _, &ws);
    }
}

/// Read a PTY's current window size via `ioctl(TIOCGWINSZ)`; `None` if the fd
/// isn't a tty or the call fails.
#[cfg(unix)]
pub fn get_winsize(fd: RawFd) -> Option<(u16, u16)> {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    // SAFETY: `fd` is a live master PTY; the ioctl fills `ws`.
    let rc = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ as _, &mut ws) };
    if rc == 0 && ws.ws_col > 0 && ws.ws_row > 0 {
        Some((ws.ws_col, ws.ws_row))
    } else {
        None
    }
}

/// Adopt an already-open master-PTY fd (inherited across an `execve` self-
/// upgrade) and its still-running child `pid`, reconstructing the same
/// reader/writer/resize/kill/waiter threads that [`spawn_pty`] wires up — but
/// driven from a bare fd instead of a `portable-pty` object.
///
/// The caller passes the *inherited* fd; we keep it as the canonical
/// `master_fd` (so a subsequent upgrade can inherit it again) and `dup` a
/// private copy for each I/O thread. The waiter reaps via `waitpid`, which
/// works because the replacement process kept the same PID across `execve` and
/// so remains the child's parent.
#[cfg(unix)]
pub fn adopt_pty(
    fd: RawFd,
    pid: u32,
    cols: u16,
    rows: u16,
) -> AppResult<(PtyHandle, mpsc::UnboundedReceiver<PtyOutput>)> {
    // dup a private, close-on-exec copy of `fd` for a thread. dup(2) clears
    // FD_CLOEXEC on the new fd, so set it back: only the canonical `master_fd`
    // should survive a future re-exec (it's un-CLOEXEC'd deliberately at that
    // point), never these worker dups.
    let dup_cloexec = |src: RawFd| -> AppResult<RawFd> {
        let d = unsafe { libc::dup(src) };
        if d < 0 {
            return Err(AppError::Other(anyhow::anyhow!(
                "dup pty fd failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        let flags = unsafe { libc::fcntl(d, libc::F_GETFD) };
        if flags >= 0 {
            unsafe {
                libc::fcntl(d, libc::F_SETFD, flags | libc::FD_CLOEXEC);
            }
        }
        Ok(d)
    };

    let reader_fd = dup_cloexec(fd)?;
    let writer_fd = dup_cloexec(fd)?;
    let resize_fd = dup_cloexec(fd)?;

    // Re-apply the last known size to the adopted terminal.
    set_winsize(resize_fd, cols, rows);

    let (out_tx, out_rx) = mpsc::unbounded_channel::<PtyOutput>();
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (resize_tx, mut resize_rx) = mpsc::unbounded_channel::<(u16, u16)>();
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<()>();

    // reader: master → Chunk frames.
    {
        let out_tx = out_tx.clone();
        std::thread::spawn(move || {
            let mut file = unsafe { std::fs::File::from_raw_fd(reader_fd) };
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match file.read(&mut buf) {
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

    // writer: keystrokes → master (verbatim).
    std::thread::spawn(move || {
        let mut file = unsafe { std::fs::File::from_raw_fd(writer_fd) };
        while let Some(bytes) = input_rx.blocking_recv() {
            if file.write_all(&bytes).is_err() || file.flush().is_err() {
                break;
            }
        }
    });

    // resize: apply size changes; owns `resize_fd` so it's closed on teardown.
    std::thread::spawn(move || {
        let owned = unsafe { OwnedFd::from_raw_fd(resize_fd) };
        while let Some((cols, rows)) = resize_rx.blocking_recv() {
            set_winsize(owned.as_raw_fd(), cols, rows);
        }
    });

    // kill: a value terminates the child by pid (no portable-pty killer here).
    std::thread::spawn(move || {
        if kill_rx.blocking_recv().is_some() {
            // SAFETY: signalling a pid never touches our address space.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    });

    // waiter: reap the inherited child and report its exit code.
    {
        let out_tx = out_tx.clone();
        std::thread::spawn(move || {
            let mut status: libc::c_int = 0;
            let code = loop {
                let r = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, 0) };
                if r == pid as libc::pid_t {
                    break if libc::WIFEXITED(status) {
                        Some(libc::WEXITSTATUS(status))
                    } else {
                        None
                    };
                }
                let err = std::io::Error::last_os_error();
                if r < 0 && err.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                // ECHILD or anything else: not reapable here (already gone).
                break None;
            };
            let _ = out_tx.send(PtyOutput::Exited(code));
        });
    }

    Ok((
        PtyHandle {
            input_tx,
            resize_tx,
            kill_tx,
            pid: Some(pid),
            master_fd: Some(fd),
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

    /// Simulate post-`execve` adoption without a real re-exec: open a PTY and
    /// spawn a child directly, then hand the *bare* master fd + pid to
    /// `adopt_pty` (leaking the original master/child so their Drop doesn't close
    /// the fd or reap the pid — exactly the state after an execve, where only the
    /// inherited fd survives). Input and output must still flow through the
    /// adopted handle.
    #[cfg(unix)]
    #[tokio::test]
    async fn adopt_pty_reattaches_live_terminal() {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("sh");
        cmd.args(["-c", "while IFS= read -r l; do printf 'GOT:%s\\n' \"$l\"; done"]);
        let child = pair.slave.spawn_command(cmd).expect("spawn sh");
        drop(pair.slave);
        let fd = pair.master.as_raw_fd().expect("master fd");
        let pid = child.process_id().expect("child pid");
        // Keep the fd open and leave the child un-reaped, as across an execve.
        std::mem::forget(pair.master);
        std::mem::forget(child);

        let (handle, mut rx) = adopt_pty(fd, pid, 80, 24).expect("adopt");
        handle.send_input(b"ping\n").unwrap();
        let acc = wait_for(&mut rx, "GOT:ping").await;
        assert!(acc.contains("GOT:ping"), "adopted pty must echo; got {acc:?}");
        handle.terminate();
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
