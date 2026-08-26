//! Switchboard hosting service entrypoint.

mod agent;
mod auth;
mod config;
mod console;
mod editor;
mod error;
mod fs;
mod host;
mod http;
mod ipc;
mod log_file;
mod pty_proc;
mod repeater;
#[cfg(test)]
mod repeater_test;
mod restart;
mod state;
mod store;
mod task;
mod terminal;
mod tls;
mod upgrade;
mod worker_link;
mod ws;
#[cfg(test)]
mod ws_test;

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::{
    config::{Config, Role},
    state::AppState,
    store::Store,
    task::TaskManager,
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `switchboard-server pty-host` is not a mode a human invokes: the server
    // re-executes itself this way to put a task's PTY in its own process. Handle
    // it before any server setup, since a host opens no port and no database.
    if std::env::args().nth(1).as_deref() == Some(host::HOST_ARG) {
        return run_pty_host().await;
    }
    // The shim launches a pty-host outside our process tree and exits; on
    // Windows this is what keeps tasks alive across a service restart.
    #[cfg(windows)]
    if std::env::args().nth(1).as_deref() == Some(host::SHIM_ARG) {
        std::process::exit(host::shim::run());
    }

    let config = Config::from_env();

    // Route logs to a size-based rolling file when `SWITCHBOARD_LOG` is set;
    // otherwise keep the stdout subscriber, colorized only where the escapes
    // actually render (see `console::ansi_stdout`).
    let env_filter =
        || EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    match &config.log_file {
        Some(log_cfg) => {
            let writer = log_file::RollingWriter::new(log_cfg).map_err(|e| {
                anyhow::anyhow!("failed to open log file {}: {e}", log_cfg.path)
            })?;
            tracing_subscriber::fmt()
                .with_env_filter(env_filter())
                .with_ansi(false)
                .with_writer(writer)
                .init();
            tracing::info!(
                path = %log_cfg.path,
                max_size = log_cfg.max_size,
                max_files = log_cfg.max_files,
                "logging to rolling file"
            );
        }
        None => {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter())
                .with_ansi(console::ansi_stdout())
                .init();
        }
    }

    // The repeater is a stateless relay — it never opens the store, so don't log a
    // `db` path that would falsely imply it does.
    if config.role == Role::Repeater {
        tracing::info!(role = ?config.role, name = %config.service_name, "starting hosting service");
    } else {
        tracing::info!(role = ?config.role, db = %config.db_path, name = %config.service_name, "starting hosting service");
    }

    match config.role {
        Role::WorkerDirect => run_worker_direct(config).await,
        Role::WorkerRepeaterClient => run_worker_repeater_client(config).await,
        Role::Repeater => repeater::run(config).await,
    }
}

/// Run as a pty-host: own one task's PTY and serve whichever server attaches.
///
/// A host is spawned detached with no console, so its diagnostics can only go to
/// the file named in the spec. It shares no state with the server beyond the IPC
/// endpoint — in particular it never opens the database.
async fn run_pty_host() -> anyhow::Result<()> {
    let spec = host::HostSpec::from_env()?;

    let log_cfg = log_file::LogFileConfig {
        path: spec.log_path.clone(),
        max_size: 8 * 1024 * 1024,
        max_files: 2,
    };
    match log_file::RollingWriter::new(&log_cfg) {
        Ok(writer) => tracing_subscriber::fmt()
            .with_env_filter(
                EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
            )
            .with_ansi(false)
            .with_writer(writer)
            .init(),
        // Losing the log is not worth losing the task over; the host is
        // functional without it.
        Err(e) => eprintln!("pty-host: cannot open log {}: {e}", spec.log_path),
    }

    host::run(spec).await?;
    Ok(())
}

/// The worker that dials out: run PTYs locally, but serve every client through a
/// reverse tunnel to the repeater instead of binding a client-facing port.
async fn run_worker_repeater_client(config: Config) -> anyhow::Result<()> {
    tracing::info!(repeater = ?config.repeater_addr, "worker-repeater-client");

    let store = Store::connect(&config.db_path).await?;
    let tasks = TaskManager::new(store.clone(), &config.db_path);
    // Re-attach before reconciling: a task whose host answers stays live, and
    // only the ones nobody answers for settle to a terminal state.
    tasks.reattach_hosts().await;
    tasks.reconcile_orphans().await?;
    let state: state::SharedState = Arc::new(AppState {
        config,
        store,
        tasks,
        // No local TLS listener here; the channel binding for client auth is the
        // repeater's cert, handled at the repeater. The tunnel leg pins the
        // repeater cert itself inside `worker_link`.
        cert_fp: Vec::new(),
        nonce_cache: Default::default(),
        tunnel_shutdown: Default::default(),
    });

    worker_link::run(state).await
}

/// The classic single-process worker: bind the client-facing address, serve the
/// authenticated API + WS, and run PTYs locally.
async fn run_worker_direct(config: Config) -> anyhow::Result<()> {
    tracing::info!(addr = %config.addr, "worker-direct");

    // Ensure the cert exists up front (when TLS is on) so we can derive the
    // channel-binding fingerprint before building state.
    let cert_fp = match &config.tls {
        Some(tls_cfg) => {
            // rustls 0.23 needs a process-wide crypto provider chosen explicitly.
            rustls::crypto::ring::default_provider()
                .install_default()
                .ok();
            let sans = tls::ensure_cert(tls_cfg)?;
            tracing::info!(sans = ?sans, "tls certificate ready");
            let fp = tls::leaf_cert_fingerprint(tls_cfg)?;
            tracing::info!(fingerprint = %switchboard_shared::auth::hex(&fp), "tls leaf cert SHA-256 (pin this on the client)");
            fp
        }
        None => Vec::new(),
    };

    let store = Store::connect(&config.db_path).await?;
    let tasks = TaskManager::new(store.clone(), &config.db_path);
    // Re-attach before reconciling: a task whose host answers stays live, and
    // only the ones nobody answers for settle to a terminal state.
    tasks.reattach_hosts().await;
    tasks.reconcile_orphans().await?;
    let state: state::SharedState = Arc::new(AppState {
        config: config.clone(),
        store,
        tasks,
        cert_fp,
        nonce_cache: Default::default(),
        tunnel_shutdown: Default::default(),
    });

    let app = http::router(state.clone(), true);

    match &config.tls {
        Some(tls_cfg) => {
            let rustls_config = axum_server::tls_rustls::RustlsConfig::from_config(
                std::sync::Arc::new(tls::server_config(tls_cfg)?),
            );
            let addr: SocketAddr = config.addr.parse()?;
            tracing::info!(addr = %config.addr, cert = %tls_cfg.cert_path, "listening (https)");
            axum_server::bind_rustls(addr, rustls_config)
                .serve(app.into_make_service())
                .await?;
        }
        None => {
            let listener = TcpListener::bind(&config.addr).await?;
            tracing::info!(addr = %config.addr, "listening (http)");
            axum::serve(listener, app).await?;
        }
    }
    Ok(())
}
