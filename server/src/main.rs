//! Agent-manage hosting service entrypoint.

mod agent;
mod auth;
mod config;
mod error;
mod http;
mod pty_proc;
mod state;
mod store;
mod task;
mod terminal;
mod ws;
#[cfg(test)]
mod ws_test;

use std::sync::Arc;

use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::{config::Config, state::AppState, store::Store, task::TaskManager};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
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
    let listener = TcpListener::bind(&config.addr).await?;
    tracing::info!(addr = %config.addr, "listening");
    axum::serve(listener, app).await?;
    Ok(())
}
