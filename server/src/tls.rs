//! TLS support: load the configured cert/key, generating a self-signed pair if
//! one is missing.
//!
//! Clients on macOS reach this server through a WKWebView, whose `fetch`/
//! `WebSocket` are governed by App Transport Security. ATS refuses cleartext
//! HTTP to a non-`localhost` host, so a remote client can only talk to us over
//! HTTPS — and it will only accept the cert if it is (a) issued for the address
//! being dialed (hence IP SANs) and (b) trusted on the client. The generated
//! cert is ECDSA P-256 / SHA-256 with a <398-day lifetime so it satisfies ATS's
//! own requirements once trusted; the operator still has to trust it once per
//! client machine (`security add-trusted-cert …`).

use std::fs::File;
use std::io::BufReader;
use std::net::{IpAddr, UdpSocket};
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use rcgen::{
    CertificateParams, DistinguishedName, DnType, Ia5String, KeyPair, SanType,
    PKCS_ECDSA_P256_SHA256,
};
use rustls::ServerConfig;
use time::{Duration, OffsetDateTime};

use crate::config::TlsConfig;

/// Ensure a usable cert/key pair exists at the configured paths, generating a
/// self-signed one if either file is missing. Returns the list of SANs the cert
/// covers so the caller can log them (helps the operator pick the right URL).
pub fn ensure_cert(tls: &TlsConfig) -> Result<Vec<String>> {
    if Path::new(&tls.cert_path).exists() && Path::new(&tls.key_path).exists() {
        return Ok(vec!["<existing cert>".to_string()]);
    }

    let (sans, labels) = collect_sans(&tls.extra_sans);

    let mut params = CertificateParams::new(Vec::<String>::new())
        .context("building certificate params")?;
    params.subject_alt_names = sans;
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "Switchboard");
    dn.push(DnType::OrganizationName, "Switchboard");
    params.distinguished_name = dn;

    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::hours(1); // tolerate a little clock skew
    // Stay under the 398-day cap macOS/Safari enforce for TLS server certs.
    params.not_after = now + Duration::days(397);

    let key_pair =
        KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).context("generating key pair")?;
    let cert = params
        .self_signed(&key_pair)
        .context("self-signing certificate")?;

    if let Some(parent) = Path::new(&tls.cert_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    std::fs::write(&tls.cert_path, cert.pem()).context("writing certificate")?;
    std::fs::write(&tls.key_path, key_pair.serialize_pem()).context("writing private key")?;
    Ok(labels)
}

/// Load the cert/key into a rustls `ServerConfig` pinned to HTTP/1.1. WebSocket
/// upgrades run over HTTP/1.1; if the listener negotiated HTTP/2 (rustls's
/// default ALPN offers it) the `/ws` upgrade fails with 405, so we advertise
/// only `http/1.1`. Assumes a crypto provider is already installed.
pub fn server_config(tls: &TlsConfig) -> Result<ServerConfig> {
    let certs = rustls_pemfile::certs(&mut BufReader::new(
        File::open(&tls.cert_path).with_context(|| format!("opening {}", tls.cert_path))?,
    ))
    .collect::<Result<Vec<_>, _>>()
    .context("reading certificate PEM")?;
    let key = rustls_pemfile::private_key(&mut BufReader::new(
        File::open(&tls.key_path).with_context(|| format!("opening {}", tls.key_path))?,
    ))
    .context("reading private key PEM")?
    .ok_or_else(|| anyhow!("no private key found in {}", tls.key_path))?;

    let mut config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .context("building rustls server config")?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(config)
}

/// Build the SAN list for a generated cert: loopback + `localhost`, the primary
/// outbound interface IP, and any operator-supplied extras. Returns the parsed
/// `SanType`s alongside human-readable labels for logging. Duplicates are
/// dropped so passing an IP that also happens to be the primary one is harmless.
fn collect_sans(extra: &[String]) -> (Vec<SanType>, Vec<String>) {
    let mut hosts: Vec<String> = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    if let Some(ip) = primary_ip() {
        hosts.push(ip.to_string());
    }
    hosts.extend(extra.iter().cloned());
    hosts.dedup();

    let mut sans = Vec::new();
    let mut labels = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for host in hosts {
        if !seen.insert(host.clone()) {
            continue;
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            sans.push(SanType::IpAddress(ip));
            labels.push(host);
        } else if let Ok(dns) = Ia5String::try_from(host.clone()) {
            sans.push(SanType::DnsName(dns));
            labels.push(host);
        } else {
            tracing::warn!(host, "skipping invalid TLS SAN entry");
        }
    }
    (sans, labels)
}

/// Best-effort discovery of the primary outbound IP. Opening a UDP socket and
/// "connecting" it to a remote address selects a route without sending any
/// packets, so this works offline as long as a route exists.
fn primary_ip() -> Option<IpAddr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}
