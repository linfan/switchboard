//! Shared application state handed to every request/connection.

use std::sync::Arc;

use switchboard_shared::ServiceInfo;

use crate::{agent, auth::ReplayCache, config::Config, store::Store, task::TaskManager};

pub struct AppState {
    pub config: Config,
    pub store: Store,
    pub tasks: TaskManager,
    /// SHA-256 of our leaf cert DER — the `cb` channel-binding tag for `SWB-v1`
    /// auth. Empty when serving plain HTTP (tests / `SWITCHBOARD_TLS=0`), which
    /// disables channel binding but keeps the token off the wire.
    pub cert_fp: Vec<u8>,
    /// Single-use REST nonce cache for replay protection.
    pub nonce_cache: ReplayCache,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn service_info(&self) -> ServiceInfo {
        ServiceInfo {
            name: self.config.service_name.clone(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            tools: agent::available_tools(),
        }
    }
}
