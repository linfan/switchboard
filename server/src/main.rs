//! Switchboard hosting service entrypoint.

mod agent;
mod auth;
mod config;
mod editor;
mod error;
mod fs;
mod http;
mod pty_proc;
mod state;
mod store;
mod task;
mod terminal;
mod tls;
mod ws;
#[cfg(test)]
mod ws_test;

use std::net::SocketAddr;
use std::sync::Arc;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::{config::Config, state::AppState, store::Store, task::TaskManager};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env();
    tracing::info!(addr = %config.addr, db = %config.db_path, name = %config.service_name, "starting hosting service");

    let store = Store::connect(&config.db_path).await?;
    let tasks = TaskManager::new(store.clone());
    tasks.reconcile_orphans().await?;
    let state: state::SharedState = Arc::new(AppState {
        config: config.clone(),
        store,
        tasks,
    });

    let app = http::router(state.clone());

    match &config.tls {
        Some(tls_cfg) => {
            // rustls 0.23 needs a process-wide crypto provider chosen explicitly.
            rustls::crypto::ring::default_provider()
                .install_default()
                .ok();
            let sans = tls::ensure_cert(tls_cfg)?;
            let rustls_config = axum_server::tls_rustls::RustlsConfig::from_config(
                std::sync::Arc::new(tls::server_config(tls_cfg)?),
            );
            let addr: SocketAddr = config.addr.parse()?;
            tracing::info!(addr = %config.addr, cert = %tls_cfg.cert_path, sans = ?sans, "listening (https)");
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
