//! In-place self-restart for the upgrade flow: re-exec the (already replaced)
//! server binary so the new version takes effect without an external
//! supervisor, carrying live PTYs across the `execve` so running tasks survive
//! the restart instead of dropping to `Detached`.

use crate::error::{AppError, AppResult};

/// Env var handed to the replacement process, carrying the inherited-PTY map:
/// `task_id:fd:pid:cols:rows` entries joined by commas.
pub const INHERIT_ENV: &str = "SWITCHBOARD_INHERIT_PTYS";

/// One live PTY to pass to the replacement process across the re-exec.
pub struct InheritEntry {
    pub task_id: String,
    pub fd: i32,
    pub pid: u32,
}

/// Re-exec the current executable in place (same PID), inheriting `inherit`'s
/// live PTY master fds. On success the process image is replaced and this never
/// returns; it only returns `Err` if the exec itself failed. Any fd we can't
/// prepare is skipped (that task falls back to `Detached` reconciliation).
#[cfg(unix)]
pub fn exec_replacement(inherit: Vec<InheritEntry>) -> AppResult<()> {
    use std::os::unix::process::CommandExt;

    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot resolve current exe: {e}")))?;

    let mut tokens = Vec::new();
    for e in &inherit {
        // portable-pty set FD_CLOEXEC on the master; clear it so the fd survives
        // execve. If we can't, skip this task rather than exec with a doomed fd.
        let flags = unsafe { libc::fcntl(e.fd, libc::F_GETFD) };
        if flags < 0 {
            tracing::warn!(task = %e.task_id, fd = e.fd, "cannot read fd flags; not inheriting");
            continue;
        }
        if unsafe { libc::fcntl(e.fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) } < 0 {
            tracing::warn!(task = %e.task_id, fd = e.fd, "cannot clear CLOEXEC; not inheriting");
            continue;
        }
        let (cols, rows) = crate::pty_proc::get_winsize(e.fd).unwrap_or((80, 24));
        tokens.push(format!("{}:{}:{}:{}:{}", e.task_id, e.fd, e.pid, cols, rows));
    }

    tracing::info!(exe = %exe.display(), inherited = tokens.len(), "re-exec for self-upgrade");

    // exec() replaces the process image on success; it returns only on failure.
    let err = std::process::Command::new(&exe)
        .args(std::env::args_os().skip(1))
        .env(INHERIT_ENV, tokens.join(","))
        .exec();
    Err(AppError::Other(anyhow::anyhow!("execve failed: {err}")))
}

/// Non-unix has no `execve`; spawn a fresh process and exit (no PTY inheritance).
#[cfg(not(unix))]
pub fn exec_replacement(_inherit: Vec<InheritEntry>) -> AppResult<()> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot resolve current exe: {e}")))?;
    std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .spawn()
        .map_err(|e| AppError::Other(anyhow::anyhow!("respawn failed: {e}")))?;
    std::process::exit(0);
}
