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
#[allow(dead_code)] // wired into the REST handlers in a later part
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

/// Other platforms don't run PTY workers; accept any non-trivial blob.
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn check_format(_bytes: &[u8]) -> AppResult<()> {
    Ok(())
}

/// Atomically replace the currently-running executable's file with `bytes`,
/// returning the executable path. Writes a temp file in the *same directory*
/// (so the rename is atomic on one filesystem), fsyncs, marks it executable,
/// then renames over the current exe. Renaming over a running binary is legal on
/// Unix: the live process keeps the old inode, and the next exec picks up the new
/// file.
#[allow(dead_code)] // wired into the REST handlers in a later part
pub fn replace_current_exe(bytes: &[u8]) -> AppResult<PathBuf> {
    let exe = std::env::current_exe()
        .map_err(|e| AppError::Other(anyhow::anyhow!("cannot resolve current exe: {e}")))?;
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

    if let Err(e) = std::fs::rename(&tmp, &exe) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Other(anyhow::anyhow!(
            "failed to swap in new binary: {e}"
        )));
    }
    Ok(exe)
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
    fn replace_swaps_file_contents() {
        // Point `current_exe` semantics at a throwaway file by exercising the
        // same rename logic against a temp target directly.
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("switchboard-server");
        std::fs::write(&target, b"old-binary-contents").unwrap();

        // Mirror replace_current_exe's core (temp in same dir -> rename) so the
        // test doesn't clobber the real test runner executable.
        let tmp = dir.path().join(".switchboard-server.upgrade-test");
        std::fs::write(&tmp, b"new-binary-contents").unwrap();
        std::fs::rename(&tmp, &target).unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), b"new-binary-contents");
    }
}
