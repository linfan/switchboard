//! Runtime configuration, sourced from environment variables.

use crate::log_file::LogFileConfig;

/// Explicit deployment mode selector (`SWITCHBOARD_MODE`). A `Repeater` forwards
/// client traffic to a paired worker; a `Worker` runs tasks itself (either
/// directly bound, or dialing out to a repeater — distinguished by [`Role`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Worker,
    Repeater,
}

/// The concrete role this process plays, derived from `Mode` plus which env vars
/// are present. `main.rs` branches on this single value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Today's default: bind `SWITCHBOARD_ADDR`, serve the API + WS, run PTYs.
    WorkerDirect,
    /// Bind a client-facing and a worker-facing address; forward opaquely to the
    /// one paired worker. Runs no tasks itself.
    Repeater,
    /// Run PTYs locally but, instead of binding, dial the repeater and serve all
    /// client traffic through the reverse tunnel.
    WorkerRepeaterClient,
}

/// Hosting-service configuration.
#[derive(Clone, Debug)]
pub struct Config {
    /// The role this process plays (derived in [`Config::from_env`]).
    pub role: Role,
    /// Client-facing TCP address to bind, e.g. `127.0.0.1:8787`. Bound by the
    /// worker-direct and repeater roles; unused by the worker-repeater-client.
    pub addr: String,
    /// Shared secret proving client identity (`SWITCHBOARD_TOKEN`). Never
    /// transmitted — proven via the SWB-v1 handshake/signing. `None` for the
    /// worker-repeater-client, which does no client-facing auth (the repeater
    /// terminates it) and holds only `repeater_token`.
    pub token: Option<String>,
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
    /// Worker-facing address (`SWITCHBOARD_REPEATER_ADDR`). For a repeater this is
    /// the HTTPS address workers dial in on; for a worker-repeater-client it is
    /// the repeater address to dial out to.
    pub repeater_addr: Option<String>,
    /// Shared secret for the worker↔repeater tunnel (`SWITCHBOARD_REPEATER_TOKEN`).
    pub repeater_token: Option<String>,
    /// Path to a PEM whose leaf cert the worker pins for the repeater tunnel
    /// (`SWITCHBOARD_REPEATER_CA`). Worker-repeater-client side only.
    pub repeater_ca: Option<String>,
    /// Size-based rolling log file (`SWITCHBOARD_LOG`). `None` logs to stdout.
    pub log_file: Option<LogFileConfig>,
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
        // Read the role-selecting vars raw (presence matters) before defaulting.
        let addr_env = env_opt("SWITCHBOARD_ADDR");
        let token_env = env_opt("SWITCHBOARD_TOKEN");
        let repeater_addr = env_opt("SWITCHBOARD_REPEATER_ADDR");
        let repeater_token = env_opt("SWITCHBOARD_REPEATER_TOKEN");
        let repeater_ca = env_opt("SWITCHBOARD_REPEATER_CA");

        let mode = match env("SWITCHBOARD_MODE", "worker")
            .to_ascii_lowercase()
            .as_str()
        {
            "repeater" => Mode::Repeater,
            _ => Mode::Worker,
        };
        // A worker with no client-facing bind/token but a repeater target dials
        // out through the tunnel; otherwise it binds and serves directly.
        let role = match mode {
            Mode::Repeater => Role::Repeater,
            Mode::Worker
                if addr_env.is_none()
                    && token_env.is_none()
                    && repeater_addr.is_some()
                    && repeater_token.is_some() =>
            {
                Role::WorkerRepeaterClient
            }
            Mode::Worker => Role::WorkerDirect,
        };

        let addr = addr_env.unwrap_or_else(|| "127.0.0.1:8787".to_string());
        // The worker-repeater-client authenticates only the tunnel, so it carries
        // no client-facing token; the other roles default one for convenience.
        let token = match role {
            Role::WorkerRepeaterClient => None,
            _ => Some(token_env.unwrap_or_else(|| "dev-token".to_string())),
        };
        let db_path = env("SWITCHBOARD_DB", "server/data/switchboard.db");
        let service_name = std::env::var("SWITCHBOARD_NAME")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("HOSTNAME").ok())
            .or_else(|| std::env::var("COMPUTERNAME").ok())
            .unwrap_or_else(|| "agent-host".to_string());
        let agent_permission_mode = env("SWITCHBOARD_PERMISSION_MODE", "default");
        // Optional size-based rolling log file. A malformed spec is a
        // configuration mistake worth surfacing, but shouldn't stop startup — warn
        // to stderr (logging isn't wired up yet here) and fall back to stdout.
        let log_file =
            env_opt("SWITCHBOARD_LOG").and_then(|spec| match LogFileConfig::parse(&spec) {
                Ok(cfg) => Some(cfg),
                Err(e) => {
                    eprintln!("SWITCHBOARD_LOG ignored ({e}); logging to stdout");
                    None
                }
            });
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
            role,
            addr,
            token,
            db_path,
            service_name,
            agent_permission_mode,
            tls,
            repeater_addr,
            repeater_token,
            repeater_ca,
            log_file,
        }
    }
}

/// Read an env var, returning `Some` only when it is set and non-empty.
fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

/// Interpret an env var as a boolean flag, falling back to `default` when the
/// var is unset or empty. Recognizes `1`/`true`/`yes`/`on` (case-insensitive) as
/// true; anything else is false.
fn flag(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
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
