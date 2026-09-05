//! Server self-upgrade primitives: validate a candidate binary and atomically
//! replace the running executable's file. The actual in-place restart that
//! picks up the new file lives in [`crate::restart`]; fetching a binary from a
//! URL lives alongside [`validate_binary`] here.

use std::io::Write;
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// A sane lower bound: any real server binary dwarfs this. Rejects empty or
/// truncated uploads that would otherwise brick the restart.
const MIN_BINARY_SIZE: usize = 1024;

/// Validate that `bytes` is an executable for *this* host's OS and architecture.
/// The client machine's OS/arch may differ from the host's, so pushing the wrong
/// build is the primary footgun — reject it loudly before we replace anything.
pub fn validate_binary(bytes: &[u8]) -> AppResult<()> {
    if bytes.len() < MIN_BINARY_SIZE {
        return Err(AppError::BadRequest(format!(
            "binary too small ({} bytes) — likely empty or truncated",
            bytes.len()
        )));
    }
    check_format(bytes)
}

/// macOS: accept a Mach-O (thin or universal). For the common thin 64-bit
/// little-endian case, enforce the CPU type matches this host's arch (arm64 vs
/// x86_64 is the real mismatch risk); universal ("fat") binaries bundle multiple
/// arches so are accepted as-is.
#[cfg(target_os = "macos")]
fn check_format(bytes: &[u8]) -> AppResult<()> {
    let head = &bytes[0..4];
    // 64-bit Mach-O, little-endian on disk (modern arm64 / x86_64 macs).
    if head == [0xCF, 0xFA, 0xED, 0xFE] {
        let cputype = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        const CPU_TYPE_X86_64: u32 = 0x0100_0007;
        const CPU_TYPE_ARM64: u32 = 0x0100_000C;
        let want = match std::env::consts::ARCH {
            "x86_64" => Some(CPU_TYPE_X86_64),
            "aarch64" => Some(CPU_TYPE_ARM64),
            _ => None,
        };
        if let Some(want) = want {
            if cputype != want {
                return Err(AppError::BadRequest(format!(
                    "Mach-O CPU type 0x{cputype:08x} does not match this host ({})",
                    std::env::consts::ARCH
                )));
            }
        }
        return Ok(());
    }
    // Other recognized Mach-O / universal magics: accept without strict arch
    // (big-endian/32-bit are legacy; a fat binary bundles our arch).
    const RECOGNIZED: [[u8; 4]; 5] = [
        [0xFE, 0xED, 0xFA, 0xCF], // 64-bit big-endian
        [0xCE, 0xFA, 0xED, 0xFE], // 32-bit little-endian
        [0xFE, 0xED, 0xFA, 0xCE], // 32-bit big-endian
        [0xCA, 0xFE, 0xBA, 0xBE], // fat (universal)
        [0xBE, 0xBA, 0xFE, 0xCA], // fat, byte-swapped
    ];
    if RECOGNIZED.iter().any(|m| head == m) {
        return Ok(());
    }
    Err(AppError::BadRequest(
        "not a Mach-O executable (wrong OS for this host?)".into(),
    ))
}

/// Linux: require an ELF whose `e_machine` matches this host's arch.
#[cfg(target_os = "linux")]
fn check_format(bytes: &[u8]) -> AppResult<()> {
    if &bytes[0..4] != b"\x7fELF" {
        return Err(AppError::BadRequest(
            "not an ELF executable (wrong OS for this host?)".into(),
        ));
    }
    // EI_DATA (byte 5): 1 = little-endian, 2 = big-endian. e_machine at offset 18.
    let little = bytes[5] == 1;
    let e_machine = if little {
        u16::from_le_bytes([bytes[18], bytes[19]])
    } else {
        u16::from_be_bytes([bytes[18], bytes[19]])
    };
    const EM_386: u16 = 3;
    const EM_X86_64: u16 = 62;
    const EM_AARCH64: u16 = 183;
    let want = match std::env::consts::ARCH {
        "x86_64" => Some(EM_X86_64),
        "aarch64" => Some(EM_AARCH64),
        "x86" => Some(EM_386),
        _ => None,
    };
    if let Some(want) = want {
        if e_machine != want {
            return Err(AppError::BadRequest(format!(
                "ELF e_machine {e_machine} does not match this host ({})",
                std::env::consts::ARCH
            )));
        }
    }
    Ok(())
}

/// Windows: require a PE image whose COFF `Machine` matches this host's arch.
/// Pushing a Linux or macOS build here used to sail through and only fail at the
/// restart, leaving the service down with a binary it cannot execute.
#[cfg(target_os = "windows")]
fn check_format(bytes: &[u8]) -> AppResult<()> {
    if &bytes[0..2] != b"MZ" {
        return Err(AppError::BadRequest(
            "not a PE executable (wrong OS for this host?)".into(),
        ));
    }
    // The DOS stub ends with e_lfanew at 0x3C: the offset of the PE signature,
    // followed by the COFF header whose first field is Machine.
    let e_lfanew =
        u32::from_le_bytes([bytes[0x3C], bytes[0x3D], bytes[0x3E], bytes[0x3F]]) as usize;
    let machine_at = e_lfanew + 6;
    if machine_at + 2 > bytes.len() || &bytes[e_lfanew..e_lfanew + 4] != b"PE\0\0" {
        return Err(AppError::BadRequest(
            "malformed PE header (truncated or not an executable)".into(),
        ));
    }
    let machine = u16::from_le_bytes([bytes[e_lfanew + 4], bytes[e_lfanew + 5]]);
    const IMAGE_FILE_MACHINE_I386: u16 = 0x014C;
    const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
    const IMAGE_FILE_MACHINE_ARM64: u16 = 0xAA64;
    let want = match std::env::consts::ARCH {
        "x86_64" => Some(IMAGE_FILE_MACHINE_AMD64),
        "aarch64" => Some(IMAGE_FILE_MACHINE_ARM64),
        "x86" => Some(IMAGE_FILE_MACHINE_I386),
        _ => None,
    };
    if let Some(want) = want {
        if machine != want {
            return Err(AppError::BadRequest(format!(
                "PE machine 0x{machine:04x} does not match this host ({})",
                std::env::consts::ARCH
            )));
        }
    }
    Ok(())
}

/// Other platforms don't run PTY workers; accept any non-trivial blob.
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn check_format(_bytes: &[u8]) -> AppResult<()> {
    Ok(())
}

/// Upper bound on a downloaded/uploaded binary, guarding memory. A static musl
/// build is tens of MiB; 200 MiB is comfortably above that.
pub const MAX_BINARY_SIZE: u64 = 200 * 1024 * 1024;

/// Download a candidate binary over HTTP(S) into memory, optionally verifying it
/// against an expected SHA-256 (hex). Bounded by [`MAX_BINARY_SIZE`]. The caller
/// still runs [`validate_binary`] before applying it.
pub async fn fetch_binary(url: &str, sha256_hex: Option<&str>) -> AppResult<Vec<u8>> {
    // rustls needs a process-wide crypto provider; worker roles that never serve
    // TLS haven't installed one. This is idempotent — ignore "already set".
    let _ = rustls::crypto::ring::default_provider().install_default();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::Other(anyhow::anyhow!("http client init failed: {e}")))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::BadRequest(format!("download failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "download failed: HTTP {}",
            resp.status()
        )));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_BINARY_SIZE {
            return Err(AppError::BadRequest(format!(
                "binary too large: {len} bytes (max {MAX_BINARY_SIZE})"
            )));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::BadRequest(format!("download read failed: {e}")))?;
    if bytes.len() as u64 > MAX_BINARY_SIZE {
        return Err(AppError::BadRequest(format!(
            "binary too large: {} bytes (max {MAX_BINARY_SIZE})",
            bytes.len()
        )));
    }
    let bytes = bytes.to_vec();
    if let Some(want) = sha256_hex {
        verify_sha256(&bytes, want)?;
    }
    Ok(bytes)
}

/// Verify `bytes` hashes to the expected SHA-256 (hex). Constant-time compare.
pub fn verify_sha256(bytes: &[u8], want_hex: &str) -> AppResult<()> {
    use switchboard_shared::auth::{ct_eq, from_hex, sha256};
    let want = from_hex(want_hex.trim())
        .ok_or_else(|| AppError::BadRequest("invalid sha256 hex".into()))?;
    let got = sha256(bytes);
    if want.len() != got.len() || !ct_eq(&got, &want) {
        return Err(AppError::BadRequest("sha256 checksum mismatch".into()));
    }
    Ok(())
}

/// Replace the currently-running executable's file with `bytes`, returning the
/// executable path.
pub fn replace_current_exe(bytes: &[u8]) -> AppResult<PathBuf> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot resolve current exe: {e}")))?;
    replace_at(&exe, bytes)?;
    Ok(exe)
}

/// Stage `bytes` beside `exe` and swap it in. Both files live in the same
/// directory so the rename is a single-filesystem metadata operation.
fn replace_at(exe: &std::path::Path, bytes: &[u8]) -> AppResult<()> {
    let dir = exe
        .parent()
        .ok_or_else(|| AppError::Other(anyhow::anyhow!("exe has no parent directory")))?;
    let file_name = exe
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "switchboard-server".into());
    let tmp = dir.join(format!(".{file_name}.upgrade-{}", uuid::Uuid::new_v4()));

    let write_result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    })();
    if let Err(e) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Other(anyhow::anyhow!(
            "failed to stage new binary: {e}"
        )));
    }

    if let Err(e) = swap_in(&tmp, exe, dir, &file_name) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Unix: rename straight over the live binary. The running process keeps the old
/// inode and the next exec picks up the new file.
#[cfg(unix)]
fn swap_in(
    tmp: &std::path::Path,
    exe: &std::path::Path,
    _dir: &std::path::Path,
    _file_name: &str,
) -> AppResult<()> {
    std::fs::rename(tmp, exe)
        .map_err(|e| AppError::Other(anyhow::anyhow!("failed to swap in new binary: {e}")))
}

/// Windows: a running image cannot be written or replaced, but the loader opens
/// it with `FILE_SHARE_DELETE`, which permits *renaming* it. So move the live
/// binary aside, then move the new one into its place — the exe path holds the
/// new build while this process keeps executing the old bytes from the renamed
/// file. Deleting that file has to wait until the process exits, so it is left
/// behind and reaped by a later upgrade.
#[cfg(windows)]
fn swap_in(
    tmp: &std::path::Path,
    exe: &std::path::Path,
    dir: &std::path::Path,
    file_name: &str,
) -> AppResult<()> {
    reap_stale(dir, file_name);

    let old = dir.join(format!(".{file_name}.old-{}", uuid::Uuid::new_v4()));
    std::fs::rename(exe, &old).map_err(|e| {
        AppError::Other(anyhow::anyhow!(
            "cannot move the running binary aside (is another instance holding it?): {e}"
        ))
    })?;
    if let Err(e) = std::fs::rename(tmp, exe) {
        // Put the old binary back, or the service has no executable at all.
        if let Err(restore) = std::fs::rename(&old, exe) {
            return Err(AppError::Other(anyhow::anyhow!(
                "failed to swap in new binary ({e}) AND failed to restore the old one ({restore}); \
                 the previous binary is at {}",
                old.display()
            )));
        }
        return Err(AppError::Other(anyhow::anyhow!(
            "failed to swap in new binary: {e}"
        )));
    }
    // Expected to fail while we are still executing these bytes.
    if std::fs::remove_file(&old).is_err() {
        tracing::debug!(
            path = %old.display(),
            "previous binary is still mapped; it will be reaped by the next upgrade"
        );
    }
    Ok(())
}

/// Delete `.old-*` binaries left by earlier upgrades. Their processes are gone by
/// now — this one replaced them — so the files are finally deletable.
#[cfg(windows)]
fn reap_stale(dir: &std::path::Path, file_name: &str) {
    let prefix = format!(".{file_name}.old-");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_and_tiny() {
        assert!(validate_binary(&[]).is_err());
        assert!(validate_binary(&[0u8; 16]).is_err());
    }

    #[test]
    fn rejects_wrong_format() {
        // A large blob of text is not an executable for any supported host.
        let junk = vec![b'x'; MIN_BINARY_SIZE * 2];
        assert!(validate_binary(&junk).is_err());
    }

    #[test]
    fn accepts_this_hosts_own_binary() {
        // The running test binary is, by definition, valid for this host.
        let exe = std::env::current_exe().unwrap();
        let bytes = std::fs::read(exe).unwrap();
        validate_binary(&bytes).expect("host's own binary must validate");
    }

    #[test]
    fn verify_sha256_matches_and_rejects() {
        let data = b"hello switchboard";
        let good = switchboard_shared::auth::hex(&switchboard_shared::auth::sha256(data));
        verify_sha256(data, &good).expect("correct digest must verify");
        // Case-insensitive hex is accepted.
        verify_sha256(data, &good.to_uppercase()).expect("uppercase hex must verify");
        // A mismatching digest (correct length) is rejected.
        let wrong: String = good
            .chars()
            .map(|c| if c == '0' { '1' } else { '0' })
            .collect();
        assert!(verify_sha256(data, &wrong).is_err());
        // The right digest against the wrong bytes is rejected.
        assert!(verify_sha256(b"different", &good).is_err());
        // Malformed hex is rejected.
        assert!(verify_sha256(data, "not-hex").is_err());
    }

    #[tokio::test]
    async fn fetch_binary_downloads_verifies_and_rejects() {
        use axum::{routing::get, Router};

        let payload = vec![0xABu8; 4096];
        let served = payload.clone();
        let app = Router::new().route(
            "/bin",
            get(move || {
                let p = served.clone();
                async move { p }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let url = format!("http://{addr}/bin");

        // No checksum: returns the exact bytes.
        assert_eq!(fetch_binary(&url, None).await.unwrap(), payload);

        // Correct checksum verifies.
        let good = switchboard_shared::auth::hex(&switchboard_shared::auth::sha256(&payload));
        assert_eq!(fetch_binary(&url, Some(&good)).await.unwrap(), payload);

        // A mismatching checksum is rejected.
        let bad: String = good
            .chars()
            .map(|c| if c == '0' { '1' } else { '0' })
            .collect();
        assert!(fetch_binary(&url, Some(&bad)).await.is_err());

        // A non-2xx response is rejected.
        assert!(fetch_binary(&format!("http://{addr}/missing"), None)
            .await
            .is_err());
    }

    /// The real swap path, against a throwaway target so the test runner's own
    /// executable is left alone. Leaving no staging or `.old-*` files behind
    /// matters: on Windows those accumulate in the install directory.
    #[test]
    fn replace_swaps_file_contents_and_leaves_no_debris() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("switchboard-server");
        std::fs::write(&target, b"old-binary-contents").unwrap();

        replace_at(&target, b"new-binary-contents").expect("swap must succeed");
        assert_eq!(std::fs::read(&target).unwrap(), b"new-binary-contents");

        // A second upgrade in a row must work too, and reap anything the first
        // one could not delete.
        replace_at(&target, b"newer-binary-contents").expect("second swap must succeed");
        assert_eq!(std::fs::read(&target).unwrap(), b"newer-binary-contents");

        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "switchboard-server")
            .collect();
        assert!(leftovers.is_empty(), "unexpected leftovers: {leftovers:?}");
    }
}
