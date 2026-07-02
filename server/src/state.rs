//! Shared application state handed to every request/connection.

use std::sync::Arc;

use agent_manage_shared::ServiceInfo;

use crate::{agent, config::Config, store::Store, task::TaskManager};

pub struct AppState {
    pub config: Config,
    pub store: Store,
    pub tasks: TaskManager,
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
