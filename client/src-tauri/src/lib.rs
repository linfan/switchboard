//! Tauri shell. The client is a pure web app talking WebSocket directly to
//! hosting services, so the native layer is intentionally thin: it just hosts
//! the webview. Network/reconnect logic lives in the frontend.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
