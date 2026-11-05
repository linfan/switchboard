//! Version strings: the crate version plus the source commit baked in at build
//! time, as semver build metadata (`0.6.1+252a81b`).

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("SWITCHBOARD_GIT_COMMIT");

/// The version shown to clients: crate version plus commit, e.g. `0.6.1+252a81b`.
pub fn full() -> String {
    format!("{VERSION}+{COMMIT}")
}
