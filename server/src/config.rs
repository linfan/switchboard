//! Runtime configuration, sourced from environment variables.

/// Hosting-service configuration.
#[derive(Clone, Debug)]
pub struct Config {
    /// TCP address to bind, e.g. `127.0.0.1:8787`.
    pub addr: String,
    /// Shared bearer token clients must present.
    pub token: String,
    /// SQLite database path.
    pub db_path: String,
    /// Operator-facing service name advertised to clients.
    pub service_name: String,
    /// `--permission-mode` passed to launched agent CLIs. Headless hosts that
    /// want fully autonomous tasks typically use `acceptEdits` or
    /// `bypassPermissions`; the default is the CLI's interactive `default`.
    pub agent_permission_mode: String,
}

impl Config {
    pub fn from_env() -> Self {
        let addr = env("AGENT_MANAGE_ADDR", "127.0.0.1:8787");
        let token = env("AGENT_MANAGE_TOKEN", "dev-token");
        let db_path = env("AGENT_MANAGE_DB", "server/data/agent-manage.db");
        let service_name = std::env::var("AGENT_MANAGE_NAME")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok())
            .unwrap_or_else(|| "agent-host".to_string());
        let agent_permission_mode = env("AGENT_MANAGE_PERMISSION_MODE", "default");
        Self {
            addr,
            token,
            db_path,
            service_name,
            agent_permission_mode,
        }
    }
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}
