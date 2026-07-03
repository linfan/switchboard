//! Agent CLI registry, PATH lookup, and native interactive argv builder.
//!
//! In PTY mode each tool runs as an ordinary terminal program (no `-p`, no
//! stream-json); the pseudo-terminal is the integration surface.

use std::path::Path;

use agent_manage_shared::AgentTool;

/// A CLI agent this host knows how to launch.
pub struct AgentSpec {
    /// Stable id used on the wire (`tool` field when creating a task).
    pub id: &'static str,
    /// Human-friendly display name.
    pub display_name: &'static str,
    /// Executable name to look up on PATH.
    pub bin: &'static str,
}

/// Built-in adapters. Extending support for a new CLI = one more entry here
/// plus an argv builder in P3.
pub const KNOWN: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        display_name: "Claude Code",
        bin: "claude",
    },
    AgentSpec {
        id: "qodercli",
        display_name: "Qoder CLI",
        bin: "qodercli",
    },
];

/// Look up a spec by wire id.
pub fn spec(id: &str) -> Option<&'static AgentSpec> {
    KNOWN.iter().find(|s| s.id == id)
}

/// Report tools with availability computed from PATH.
pub fn available_tools() -> Vec<AgentTool> {
    KNOWN
        .iter()
        .map(|s| AgentTool {
            id: s.id.to_string(),
            display_name: s.display_name.to_string(),
            available: which(s.bin).is_some(),
        })
        .collect()
}

/// Minimal PATH lookup (avoids pulling in a `which` crate).
pub fn which(bin: &str) -> Option<String> {
    if bin.contains('/') {
        let p = Path::new(bin);
        return if p.is_file() { Some(bin.to_string()) } else { None };
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Command-line arguments to launch `spec` in its **native interactive** mode
/// (no `-p`, no stream-json). This is the PTY data plane: the CLI runs as a
/// normal terminal program and answers prompts (trust dialogs, permission y/N)
/// live. Both known CLIs take no extra flags to start interactively.
pub fn interactive_argv(_spec: &AgentSpec) -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_tools_have_specs() {
        assert!(spec("claude").is_some());
        assert!(spec("qodercli").is_some());
        assert!(spec("nope").is_none());
    }

    #[test]
    fn interactive_argv_is_bare() {
        assert!(interactive_argv(spec("claude").unwrap()).is_empty());
    }
}
