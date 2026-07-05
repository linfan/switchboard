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
    /// `--permission-mode` for launched CLIs. Unused in PTY mode (prompts are
    /// answered live in the terminal); retained for a future opt-in preset.
    #[allow(dead_code)]
    pub agent_permission_mode: String,
    /// TLS settings; `None` means serve plain HTTP.
    pub tls: Option<TlsConfig>,
}

/// TLS/HTTPS configuration. Enabled with `SWITCHBOARD_TLS=1`.
#[derive(Clone, Debug)]
pub struct TlsConfig {
    /// PEM certificate chain path. Auto-generated (self-signed) if absent.
    pub cert_path: String,
    /// PEM private key path. Auto-generated alongside the cert if absent.
    pub key_path: String,
    /// Extra Subject Alternative Names (IPs or DNS) to embed when generating a
    /// self-signed cert — e.g. the host's public IP. `localhost` and the local
    /// interface addresses are always included.
    pub extra_sans: Vec<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let addr = env("SWITCHBOARD_ADDR", "127.0.0.1:8787");
        let token = env("SWITCHBOARD_TOKEN", "dev-token");
        let db_path = env("SWITCHBOARD_DB", "server/data/switchboard.db");
        let service_name = std::env::var("SWITCHBOARD_NAME")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok())
            .unwrap_or_else(|| "agent-host".to_string());
        let agent_permission_mode = env("SWITCHBOARD_PERMISSION_MODE", "default");
        // HTTPS is the default protocol (even on localhost); opt out with
        // `SWITCHBOARD_TLS=0` for a plain-HTTP server.
        let tls = if flag("SWITCHBOARD_TLS", true) {
            let extra_sans = std::env::var("SWITCHBOARD_TLS_SAN")
                .ok()
                .map(|s| {
                    s.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Some(TlsConfig {
                cert_path: env("SWITCHBOARD_TLS_CERT", "server/data/switchboard-cert.pem"),
                key_path: env("SWITCHBOARD_TLS_KEY", "server/data/switchboard-key.pem"),
                extra_sans,
            })
        } else {
            None
        };
        Self {
            addr,
            token,
            db_path,
            service_name,
            agent_permission_mode,
            tls,
        }
    }
}

/// Interpret an env var as a boolean flag, falling back to `default` when the
/// var is unset or empty. Recognizes `1`/`true`/`yes`/`on` (case-insensitive) as
/// true; anything else is false.
fn flag(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => {
            matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")
        }
        _ => default,
    }
}

fn env(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}
