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
    install_panic_hook();
}

/// Route Rust panics through `tracing` so they land in the log file too, then
/// defer to the previous hook (which prints to stderr / aborts as before).
fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        tracing::error!(location = %location, message = %msg, "client panicked");
        prev(info);
    }));
}

/// Record a message emitted by the frontend (uncaught errors, rejected promises,
/// `console.error`) into the same rolling log file as native events.
#[tauri::command]
fn frontend_log(level: String, message: String) {
    match level.as_str() {
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        "info" => tracing::info!(target: "frontend", "{message}"),
        _ => tracing::error!(target: "frontend", "{message}"),
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
            net::upload_file,
            net::cache_media,
            net::drop_cached_media,
            frontend_log
        ])
        // Media previews are cached on disk and released when their tab closes;
        // sweeping at both ends bounds the cache if a crash skipped the release.
        .setup(|app| {
            net::sweep_preview_dir(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                net::sweep_preview_dir(app);
            }
        });
}
