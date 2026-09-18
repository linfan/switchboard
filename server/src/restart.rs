//! Self-restart for the upgrade flow, so the (already replaced) binary takes
//! effect. On unix that is an in-place `execve`; on Windows the service manager
//! owns process lifetime, so we exit and let it start the new binary.
//!
//! Nothing has to be carried across the restart. Each task's PTY and agent live
//! in their own pty-host process (see [`crate::host`]), so the replacement server
//! simply re-attaches to them and resumes each byte stream where this one stopped
//! persisting. A restart costs a moment of buffered output, never a task.

use crate::error::AppResult;

/// Re-exec the current executable in place, keeping the same PID. On success the
/// process image is replaced and this never returns; it only returns `Err` if the
/// exec itself failed, in which case the old server keeps running.
#[cfg(unix)]
pub fn exec_replacement() -> AppResult<()> {
    use crate::error::AppError;
    use std::os::unix::process::CommandExt;

    let exe = crate::upgrade::exe_path()?;
    tracing::info!(exe = %exe.display(), "re-exec for self-upgrade");

    // exec() replaces the process image on success; it returns only on failure.
    let err = std::process::Command::new(exe)
        .args(std::env::args_os().skip(1))
        .exec();
    // std performs its process setup in *this* process before the exec — including
    // resetting SIGPIPE to SIG_DFL — and does not roll that back when execvp
    // fails. Without this, a failed upgrade would leave the still-running old
    // server killable by the next write to a broken socket or pipe.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    Err(AppError::Other(anyhow::anyhow!("execve failed: {err}")))
}

/// Windows has no `execve`, and spawning our own replacement is worse than
/// useless under a service manager: nssm is configured to restart the service on
/// any exit, so its fresh instance and our child would both try to bind the
/// client port — the loser exits, nssm restarts it, and the flap never settles.
/// Worse, the process that won would not be the one nssm manages. So exit
/// cleanly and let the supervisor start the new binary.
///
/// Running tasks survive this: their PTYs live in detached pty-host processes
/// that the replacement re-attaches to.
#[cfg(not(unix))]
pub fn exec_replacement() -> AppResult<()> {
    tracing::info!("exiting for self-upgrade; the service manager will start the new binary");
    std::process::exit(0);
}
