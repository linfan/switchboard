//! One-shot launcher that severs the parent chain between the server and a
//! pty-host on Windows.
//!
//! Windows supervisors terminate the whole process *tree* when a service
//! application exits (nssm does this by default on every exit; `taskkill /T`
//! and most service wrappers behave the same). The upgrade path deliberately
//! exits the server so the supervisor restarts the new binary, so a host that
//! stayed the server's direct child would be killed along with it — every task
//! would come back `Exited` after an upgrade.
//!
//! The fix is topological: the server spawns a **shim** (`pty-host-shim`), the
//! shim spawns the real host detached and then exits. The host's parent is a
//! process that is already gone by the time the server exits, so no tree walk
//! starting at the server can reach it. The host reports its own pid in the
//! HELLO, which is how the server learns it without having spawned it.

use std::os::windows::process::CommandExt;
use std::process::Stdio;

use super::runner::{HostSpec, SPEC_ENV};
use super::HOST_ARG;
use crate::error::{AppError, AppResult};

/// Argument that makes this executable run as the pty-host launcher shim.
pub const SHIM_ARG: &str = "pty-host-shim";

/// No console at all — the host logs to a file.
const DETACHED: u32 = 0x0000_0008;
/// Console signals (Ctrl-C in the server's window) stop at our boundary.
const NEW_GROUP: u32 = 0x0000_0200;
/// Escape the service job object that would otherwise kill the host when the
/// server is stopped — the whole point is outliving the server.
const BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

/// Run as the shim: spawn the pty-host detached, then exit. Returns the
/// process exit code. Synchronous and deliberately minimal — it runs before
/// any server setup and owns nothing but the one child it launches.
pub fn run() -> i32 {
    let raw = match std::env::var(SPEC_ENV) {
        Ok(v) => v,
        Err(_) => {
            eprintln!("pty-host-shim: {SPEC_ENV} is not set; spawned by the server only");
            return 1;
        }
    };
    // Validate (and pick up the log path) without removing the variable: the
    // host child still needs it, and it is passed to the child explicitly.
    let spec: HostSpec = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("pty-host-shim: malformed {SPEC_ENV}: {e}");
            return 1;
        }
    };
    match spawn_host(&raw) {
        Ok(()) => 0,
        Err(e) => {
            let msg = format!("pty-host-shim: cannot spawn pty-host: {e}");
            eprintln!("{msg}");
            log_line(&spec.log_path, &msg);
            1
        }
    }
}

/// Server side: spawn the shim and return immediately. The host's pid is not
/// known here — it arrives with the HELLO once the host is up.
pub fn spawn_via_shim(spec: &HostSpec) -> AppResult<()> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot locate our own binary: {e}")))?;
    let payload = serde_json::to_string(spec)
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot encode host spec: {e}")))?;

    let mut cmd = tokio::process::Command::new(&exe);
    cmd.arg(SHIM_ARG)
        .env(SPEC_ENV, payload)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().map_err(|e| {
        AppError::Other(anyhow::anyhow!(
            "cannot spawn pty-host shim {}: {e}",
            exe.display()
        ))
    })?;
    // Dropped on purpose: the shim lives only long enough to launch the host.
    drop(child);
    Ok(())
}

/// Spawn `switchboard-server pty-host` with the raw spec, detached and outside
/// any job object that would tie its lifetime to ours.
fn spawn_host(raw_spec: &str) -> AppResult<()> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot locate our own binary: {e}")))?;

    let spawn_with = |flags: u32| {
        let mut cmd = std::process::Command::new(&exe);
        cmd.arg(HOST_ARG)
            .env(SPEC_ENV, raw_spec)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(flags);
        cmd.spawn()
    };

    // A job object that forbids breakaway rejects the flag outright; without it
    // the host dies with the service, which is still better than no host.
    match spawn_with(DETACHED | NEW_GROUP | BREAKAWAY_FROM_JOB) {
        Ok(_) => Ok(()),
        Err(e) => {
            eprintln!("pty-host-shim: spawn with job breakaway failed ({e}); retrying without it");
            spawn_with(DETACHED | NEW_GROUP)
                .map(|_| ())
                .map_err(|e| AppError::Other(anyhow::anyhow!("spawn failed: {e}")))
        }
    }
}

/// Best-effort breadcrumb where the host's own diagnostics go: a shim failure
/// would otherwise be invisible, since the server only sees a dial timeout.
fn log_line(log_path: &str, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(log_path)
    {
        let _ = writeln!(f, "{msg}");
    }
}
