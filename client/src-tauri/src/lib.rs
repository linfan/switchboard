//! Tauri shell. Reconnect/liveness logic lives in the frontend, but network I/O
//! is routed through the native layer (`net`) so it can reach hosting services
//! with self-signed TLS certs that the webview's own fetch/WebSocket refuse.

mod log_file;
mod net;

use std::path::PathBuf;

use tracing_subscriber::EnvFilter;

/// `~/.switchboard/logs/switchboard-client.log`, or `None` if no home directory
/// is discoverable (`HOME` on Unix, `USERPROFILE` on Windows).
fn log_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(
        PathBuf::from(home)
            .join(".switchboard")
            .join("logs")
            .join("switchboard-client.log"),
    )
}

/// Route logs to a size-based rolling file under `~/.switchboard/logs`
/// (50 MiB per file, 3 archives). Falls back to stdout if the file can't be
/// opened so a logging failure never takes down the app.
fn init_logging() {
    let env_filter =
        || EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let writer = log_path().and_then(|path| {
        let cfg = log_file::LogFileConfig {
            path,
            max_size: 50 * 1024 * 1024,
            max_files: 3,
        };
        log_file::RollingWriter::new(&cfg)
            .map_err(|e| eprintln!("switchboard: failed to open log file {}: {e}", cfg.path.display()))
            .ok()
            .map(|w| (w, cfg.path))
    });
    match writer {
        Some((writer, path)) => {
            tracing_subscriber::fmt()
                .with_env_filter(env_filter())
                .with_ansi(false)
                .with_writer(writer)
                .init();
            tracing::info!(path = %path.display(), version = env!("CARGO_PKG_VERSION"), "switchboard client starting");
        }
        None => {
            tracing_subscriber::fmt().with_env_filter(env_filter()).init();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(net::new_state())
        .invoke_handler(tauri::generate_handler![
            net::http_request,
            net::hash_file,
            net::ws_connect,
            net::ws_send,
            net::ws_close,
            net::download_file,
            net::upload_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
