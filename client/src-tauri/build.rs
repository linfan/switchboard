use std::process::Command;

use time::OffsetDateTime;

fn main() {
    stamp_build_info();
    tauri_build::build()
}

/// Bake the build instant and source commit into the binary as `env!`-readable
/// values; the macOS About panel surfaces both (see `lib.rs`).
///
/// `tauri_build` narrows the build script's rerun triggers to the Tauri config
/// and frontend dist, so the crate's own sources are re-declared here — without
/// them a source-only edit would recompile the crate while leaving the previous
/// stamp in place. Set `SWITCHBOARD_BUILD_TIME` in the environment to pin the
/// stamp instead (reproducible builds, or reusing a release's timestamp).
fn stamp_build_info() {
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-env-changed=SWITCHBOARD_BUILD_TIME");

    let build_time = std::env::var("SWITCHBOARD_BUILD_TIME").unwrap_or_else(|_| {
        let now = OffsetDateTime::now_utc();
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second(),
        )
    });
    println!("cargo:rustc-env=SWITCHBOARD_BUILD_TIME={build_time}");
    println!("cargo:rustc-env=SWITCHBOARD_GIT_COMMIT={}", git_commit());
}

/// Short commit of the checkout being built, or `"unknown"` when git isn't
/// available or the sources aren't a repository (e.g. a released tarball).
fn git_commit() -> String {
    Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}
