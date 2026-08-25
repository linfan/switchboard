//! In-place self-restart for the upgrade flow: re-exec the (already replaced)
//! server binary so the new version takes effect without an external supervisor.
//!
//! Nothing has to be carried across the restart. Each task's PTY and agent live
//! in their own pty-host process (see [`crate::host`]), so the replacement server
//! simply re-attaches to them and resumes each byte stream where this one stopped
//! persisting. A restart costs a moment of buffered output, never a task.

use crate::error::{AppError, AppResult};

/// Re-exec the current executable in place, keeping the same PID. On success the
/// process image is replaced and this never returns; it only returns `Err` if the
/// exec itself failed, in which case the old server keeps running.
#[cfg(unix)]
pub fn exec_replacement() -> AppResult<()> {
    use std::os::unix::process::CommandExt;

    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot resolve current exe: {e}")))?;
    tracing::info!(exe = %exe.display(), "re-exec for self-upgrade");

    // exec() replaces the process image on success; it returns only on failure.
    let err = std::process::Command::new(&exe)
        .args(std::env::args_os().skip(1))
        .exec();
    Err(AppError::Other(anyhow::anyhow!("execve failed: {err}")))
}

/// Non-unix has no `execve`; spawn a fresh process and exit.
#[cfg(not(unix))]
pub fn exec_replacement() -> AppResult<()> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot resolve current exe: {e}")))?;
    std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .spawn()
        .map_err(|e| AppError::Other(anyhow::anyhow!("respawn failed: {e}")))?;
    std::process::exit(0);
}
