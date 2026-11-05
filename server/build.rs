//! Bake the source commit into the binary so every version surfaced by the
//! server (health, WS welcome, repeater status) identifies the exact checkout.

use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
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
