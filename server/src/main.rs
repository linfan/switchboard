//! Switchboard hosting service entrypoint.

mod agent;
mod auth;
mod config;
mod editor;
mod error;
mod fs;
mod http;
mod pty_proc;
mod repeater;
#[cfg(test)]
mod repeater_test;
mod state;
mod store;
mod task;
mod terminal;
mod tls;
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
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env();
    tracing::info!(role = ?config.role, db = %config.db_path, name = %config.service_name, "starting hosting service");

    match config.role {
        Role::WorkerDirect => run_worker_direct(config).await,
        Role::WorkerRepeaterClient => run_worker_repeater_client(config).await,
        Role::Repeater => repeater::run(config).await,
    }
}

/// The worker that dials out: run PTYs locally, but serve every client through a
/// reverse tunnel to the repeater instead of binding a client-facing port.
async fn run_worker_repeater_client(config: Config) -> anyhow::Result<()> {
    tracing::info!(repeater = ?config.repeater_addr, "worker-repeater-client");

    let store = Store::connect(&config.db_path).await?;
    let tasks = TaskManager::new(store.clone());
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
    let tasks = TaskManager::new(store.clone());
    tasks.reconcile_orphans().await?;
    let state: state::SharedState = Arc::new(AppState {
        config: config.clone(),
        store,
        tasks,
        cert_fp,
        nonce_cache: Default::default(),
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
