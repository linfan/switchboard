//! Smoke test for the native networking bridge's core: prove that a REST call
//! and a WebSocket handshake against a *self-signed* hosting service succeed
//! when certificate validation is disabled (exactly how `net.rs` is configured).
//!
//! Usage: bridge_check <https-base-url> <token>
//!   cargo run --example bridge_check -- https://127.0.0.1:8790 test-token

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{
    connect_async_tls_with_config, tungstenite::protocol::Message, Connector,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let base = args.next().expect("usage: bridge_check <url> <token>");
    let token = args.next().expect("usage: bridge_check <url> <token>");

    // --- REST over self-signed TLS ---
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .build()?;
    let resp = client
        .get(format!("{base}/api/info"))
        .bearer_auth(&token)
        .send()
        .await?;
    println!("REST /api/info -> {}", resp.status());
    println!("body: {}", resp.text().await?);

    // --- WSS handshake + hello/welcome over self-signed TLS ---
    let ws_url = format!(
        "{}/ws?token={}",
        base.replacen("https", "wss", 1),
        urlencode(&token)
    );
    let connector = Connector::NativeTls(
        native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()?,
    );
    let (mut ws, _) = connect_async_tls_with_config(&ws_url, None, false, Some(connector)).await?;
    println!("WSS handshake -> ok");
    ws.send(Message::Text(
        r#"{"type":"hello","client_id":"bridge-check","cursors":{}}"#.into(),
    ))
    .await?;
    if let Some(msg) = ws.next().await {
        let msg = msg?;
        let text = msg.to_text().unwrap_or("<binary>");
        println!("first server msg: {}", &text[..text.len().min(120)]);
    }
    Ok(())
}

fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}
