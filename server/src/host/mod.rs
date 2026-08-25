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

pub mod link;
pub mod proto;
pub mod runner;

pub use link::HostLink;
pub use runner::{run, HostSpec};

/// Argument that makes this executable run as a pty-host instead of a server.
pub const HOST_ARG: &str = "pty-host";
