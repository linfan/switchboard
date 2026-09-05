//! Certificate pinning for the worker's outbound leg to the repeater.
//!
//! The worker pins the repeater's leaf cert (SHA-256 of the DER read from
//! `SWITCHBOARD_REPEATER_CA`) so an active MITM on the outbound leg is defeated.
//! [`pinned_client_config`] builds a rustls config whose verifier accepts exactly
//! that fingerprint, ignoring hostname (so a self-signed repeater cert with any
//! SAN works).

use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{
    ring, verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms,
};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use switchboard_shared::auth::{ct_eq, sha256};

/// SHA-256 of the leaf certificate DER in a PEM file — the pin and `cb`.
pub(super) fn leaf_der_fingerprint(pem_path: &str) -> Result<Vec<u8>> {
    use std::io::BufReader;
    let der = rustls_pemfile::certs(&mut BufReader::new(
        std::fs::File::open(pem_path).with_context(|| format!("opening {pem_path}"))?,
    ))
    .next()
    .ok_or_else(|| anyhow!("no certificate found in {pem_path}"))?
    .context("reading leaf certificate DER")?;
    Ok(sha256(&der).to_vec())
}

/// Build a rustls client config that pins the repeater's leaf cert by SHA-256.
pub(super) fn pinned_client_config(pin: Vec<u8>) -> ClientConfig {
    let _ = ring::default_provider().install_default();
    ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedVerifier::new(pin)))
        .with_no_client_auth()
}

/// A rustls verifier that accepts exactly the pinned leaf fingerprint, ignoring
/// hostname (so a self-signed repeater cert with any SAN works).
#[derive(Debug)]
struct PinnedVerifier {
    pin: Vec<u8>,
    supported: WebPkiSupportedAlgorithms,
}

impl PinnedVerifier {
    fn new(pin: Vec<u8>) -> Self {
        Self {
            pin,
            supported: ring::default_provider().signature_verification_algorithms,
        }
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = sha256(end_entity.as_ref());
        if ct_eq(&self.pin, &fp) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "repeater certificate fingerprint does not match the pinned value".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.supported)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.supported)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.supported.supported_schemes()
    }
}
