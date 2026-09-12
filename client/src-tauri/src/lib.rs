//! Tauri shell. Reconnect/liveness logic lives in the frontend, but network I/O
//! is routed through the native layer (`net`) so it can reach hosting services
//! with self-signed TLS certs that the webview's own fetch/WebSocket refuse.

mod log_file;
mod net;
mod port_forward;

use std::path::PathBuf;

use tauri::Manager;
use tracing_subscriber::EnvFilter;

/// UTC instant this binary was compiled, stamped in by `build.rs`.
const BUILD_TIME: &str = env!("SWITCHBOARD_BUILD_TIME");
/// Short commit it was compiled from, or `"unknown"` outside a git checkout.
const GIT_COMMIT: &str = env!("SWITCHBOARD_GIT_COMMIT");

/// Menu id of the app menu's `Settings…` item, and the event it emits. The
/// frontend listens for the event and opens the settings dialog.
#[cfg(target_os = "macos")]
const MENU_ID_SETTINGS: &str = "settings";
#[cfg(target_os = "macos")]
const EVENT_OPEN_SETTINGS: &str = "open-settings";

/// Folder the settings store lives in. Tauri names it after the bundle
/// identifier by default, which reads badly next to folders named after the
/// products they belong to, so it carries the product name instead.
const DATA_DIR_NAME: &str = "Switchboard";
/// Settings store inside [`DATA_DIR_NAME`], written by `tauri-plugin-store`.
const STORE_FILE: &str = "switchboard.json";

/// `<platform data dir>/Switchboard` — [`DATA_DIR_NAME`] hung off the same base
/// Tauri would have used, so the location stays idiomatic per platform.
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let identifier_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let base = identifier_dir
        .parent()
        .ok_or_else(|| format!("{} has no parent", identifier_dir.display()))?;
    Ok(base.join(DATA_DIR_NAME))
}

/// Absolute path of the settings store. The frontend hands it to
/// `tauri-plugin-store`, whose `load` resolves a relative name against the
/// identifier-derived directory instead.
#[tauri::command]
fn store_path(app: tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(&app)?.join(STORE_FILE))
}

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
            .map_err(|e| {
                eprintln!(
                    "switchboard: failed to open log file {}: {e}",
                    cfg.path.display()
                )
            })
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
            tracing_subscriber::fmt()
                .with_env_filter(env_filter())
                .init();
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

/// Tauri's stock menu, minus the two submenus that earn nothing here, plus our
/// build provenance in the About panel.
///
/// Dropped from the menu bar: **File**, whose only item (Close Window) the
/// Window submenu already carries, and **Edit**, which holds no app command —
/// every editing action in the UI is either a webview default or a CodeMirror
/// keymap. Edit's items are not deleted, though: on macOS a key equivalent only
/// fires if some menu item declares it, so ⌘C/⌘V/⌘X/⌘Z/⌘A would go dead in the
/// editor and terminal panes. They live on as a submenu of the app menu, where
/// `performKeyEquivalent` still walks them but the menu bar stays clean.
///
/// The About panel answers *which* build this window is running — useful when a
/// dev build and an installed one are both around. macOS renders `version` as
/// "Version x.y.z", `short_version` in parentheses after it, and `credits` as
/// the block underneath; it ignores the `comments`/`authors`/`license`/`website`
/// fields, so the build time goes in `credits`.
///
/// `Settings…` sits under About on the platform's usual ⌘, key. There is no
/// predefined item for it (unlike About or Services), so it carries an id and
/// `on_menu_event` in `run` forwards it to the frontend, which owns the dialog.
///
/// Window and Help keep Tauri's well-known submenu ids — `init_app_menu` looks
/// them up by id to hand them to `NSApp` as the windows and help menus.
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };

    let pkg = app.package_info();
    let metadata = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        short_version: Some(GIT_COMMIT.to_string()),
        credits: Some(format!("Built {BUILD_TIME}")),
        ..Default::default()
    };
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                pkg.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(
                        app,
                        MENU_ID_SETTINGS,
                        "Settings…",
                        true,
                        Some("CmdOrCtrl+,"),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &edit_menu,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
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
    // macOS only, and deliberately: a menu bar is part of the platform there, so
    // the app needs one. Windows and Linux draw the menu inside the window, where
    // this app wants none — and leaving the menu unset is all it takes to get
    // that, since Tauri's stock-menu fallback for an unset menu is itself
    // macOS-only. Their windows come up bare; the webview handles the clipboard
    // shortcuts on both.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu).on_menu_event(|app, event| {
        if event.id() == MENU_ID_SETTINGS {
            use tauri::Emitter;
            if let Err(e) = app.emit(EVENT_OPEN_SETTINGS, ()) {
                tracing::error!(error = %e, "failed to open the settings dialog");
            }
        }
    });
    builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(net::new_state())
        .manage(net::new_transfer_state())
        .manage(port_forward::new_state())
        .invoke_handler(tauri::generate_handler![
            net::http_request,
            net::hash_file,
            net::ws_connect,
            net::ws_send,
            net::ws_close,
            net::download_file,
            net::upload_file,
            net::cancel_transfer,
            net::cache_media,
            net::drop_cached_media,
            port_forward::start_port_forward,
            port_forward::stop_port_forward,
            port_forward::list_port_forwards,
            frontend_log,
            store_path
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
