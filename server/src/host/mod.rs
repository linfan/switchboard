//! Out-of-process PTY hosting.
//!
//! A **pty-host** is a detached child of the server that owns one task's
//! pseudo-terminal and the agent process running on it. The server talks to it
//! over [`crate::ipc`] using [`proto`].
//!
//! This exists so the server can be replaced without killing live tasks. The
//! server holds no OS resource belonging to a task — no PTY master, no agent
//! child — so restarting it (for a self-upgrade, a crash, or a service bounce)
//! costs at most a moment of buffered output. The host outlives the server that
//! spawned it and is re-attached by whichever server comes up next.
//!
//! Split of responsibilities:
//!
//! * [`run`] — host side. Owns the PTY, buffers output until the server
//!   acknowledges it durably, and applies input/resize/terminate.
//! * [`HostLink`] — server side. Spawns or re-attaches a host and exposes the
//!   same surface as an in-process PTY handle, so the task pump is unchanged.
//! * [`shim`] (Windows only) — one-shot launcher that puts a host outside the
//!   server's process tree, where the service manager's tree kill cannot
//!   reach it. Unix detaches with `setsid` instead: `execve` never kills
//!   children, so no shim is needed there.

pub mod link;
pub mod proto;
pub mod runner;
/// Windows-only launcher that puts a pty-host outside the server's process
/// tree, so supervisors that kill trees on service exit cannot reach it.
#[cfg(windows)]
pub mod shim;

pub use link::HostLink;
pub use runner::{run, HostSpec};

/// Argument that makes this executable run as a pty-host instead of a server.
pub const HOST_ARG: &str = "pty-host";

/// Argument that makes this executable run as the one-shot pty-host launcher
/// shim (Windows only). Re-exported so `main` can dispatch on it without
/// knowing the module layout.
#[cfg(windows)]
pub use shim::SHIM_ARG;
