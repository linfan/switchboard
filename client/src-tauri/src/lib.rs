//! Tauri shell. Reconnect/liveness logic lives in the frontend, but network I/O
//! is routed through the native layer (`net`) so it can reach hosting services
//! with self-signed TLS certs that the webview's own fetch/WebSocket refuse.

mod log_file;
mod net;

use std::path::PathBuf;

use tracing_subscriber::EnvFilter;

/// UTC instant this binary was compiled, stamped in by `build.rs`.
const BUILD_TIME: &str = env!("SWITCHBOARD_BUILD_TIME");
/// Short commit it was compiled from, or `"unknown"` outside a git checkout.
const GIT_COMMIT: &str = env!("SWITCHBOARD_GIT_COMMIT");

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
            tracing::info!(
                path = %path.display(),
                version = env!("CARGO_PKG_VERSION"),
                commit = GIT_COMMIT,
                built = BUILD_TIME,
                "switchboard client starting"
            );
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

/// Hand the system's standard About panel our build provenance, so
/// **Switchboard ▸ About Switchboard** answers *which* build this window is
/// running — useful when a dev build and an installed one are both around.
///
/// macOS renders `version` as "Version x.y.z", `short_version` in parentheses
/// after it, and `credits` as the block underneath; the panel ignores the
/// `comments`/`authors`/`license`/`website` fields, so the stamps go in
/// `credits`. `Menu::default` puts the app submenu first with About as its first
/// item, so only that slot is swapped — the Edit/View/Window submenus (and their
/// accelerators, which the webview needs for copy/paste) stay exactly as Tauri
/// builds them.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItemKind, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    let pkg = app.package_info();
    let metadata = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        short_version: Some(GIT_COMMIT.to_string()),
        credits: Some(format!("Built {BUILD_TIME}")),
        ..Default::default()
    };
    match menu.items()?.first() {
        Some(MenuItemKind::Submenu(app_submenu)) => {
            app_submenu.remove_at(0)?;
            app_submenu.insert(&PredefinedMenuItem::about(app, None, Some(metadata))?, 0)?;
        }
        // Defaults changed shape under us: keep the stock menu rather than
        // mangling it, and leave a breadcrumb for whoever bumps tauri.
        _ => tracing::warn!("unexpected default menu layout; About panel not stamped"),
    }
    Ok(menu)
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
    let builder = tauri::Builder::default();
    // Other platforms keep Tauri's stock menu (their About panels don't render
    // the build stamp anyway — see `app_menu`).
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);
    builder
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
