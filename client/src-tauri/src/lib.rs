//! Tauri shell. Reconnect/liveness logic lives in the frontend, but network I/O
//! is routed through the native layer (`net`) so it can reach hosting services
//! with self-signed TLS certs that the webview's own fetch/WebSocket refuse.

mod net;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(net::new_state())
        .invoke_handler(tauri::generate_handler![
            net::http_request,
            net::ws_connect,
            net::ws_send,
            net::ws_close,
            net::download_file,
            net::upload_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
