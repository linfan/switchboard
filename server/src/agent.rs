//! Agent CLI registry, PATH lookup, and native interactive argv builder.
//!
//! In PTY mode each tool runs as an ordinary terminal program (no `-p`, no
//! stream-json); the pseudo-terminal is the integration surface.

use std::path::Path;

use switchboard_shared::AgentTool;

use crate::error::{AppError, AppResult};

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
        return if p.is_file() {
            Some(bin.to_string())
        } else {
            None
        };
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

/// A launchable command resolved from the free-text `tool` field of a task.
/// Either a known [`AgentSpec`] or an arbitrary command found on PATH.
#[derive(Debug)]
pub struct ResolvedCommand {
    /// Wire id stored in `TaskInfo.tool` — a known spec id, or the full command
    /// string the user typed for an arbitrary command.
    pub tool_id: String,
    /// Human-friendly label used for the default task title.
    pub display_name: String,
    /// Absolute path to the executable (resolved via [`which`]).
    pub bin: String,
    /// Arguments passed after the executable.
    pub argv: Vec<String>,
}

/// Resolve the free-text `tool` field into a runnable command.
///
/// A known tool id launches its adapter in native interactive mode. Anything
/// else is treated as an arbitrary command: whitespace-split into a program
/// (looked up on PATH) plus argv. Errors if the program is not installed.
pub fn resolve_command(input: &str) -> AppResult<ResolvedCommand> {
    if let Some(spec) = spec(input) {
        let bin = which(spec.bin).ok_or_else(|| {
            AppError::BadRequest(format!("tool '{}' is not installed on this host", spec.id))
        })?;
        return Ok(ResolvedCommand {
            tool_id: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            bin,
            argv: interactive_argv(spec),
        });
    }

    let cmd = input.trim();
    if cmd.is_empty() {
        return Err(AppError::BadRequest("no command given".into()));
    }
    let mut parts = cmd.split_whitespace();
    let prog = parts.next().expect("non-empty after trim");
    let argv: Vec<String> = parts.map(str::to_string).collect();
    let bin = which(prog)
        .ok_or_else(|| AppError::BadRequest(format!("command '{prog}' not found on this host")))?;
    Ok(ResolvedCommand {
        tool_id: cmd.to_string(),
        display_name: prog.to_string(),
        bin,
        argv,
    })
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

    #[test]
    fn resolve_arbitrary_command_on_path() {
        let cmd = resolve_command("sh").expect("sh should resolve");
        assert!(cmd.bin.ends_with("/sh"), "bin was {}", cmd.bin);
        assert_eq!(cmd.tool_id, "sh");
        assert_eq!(cmd.display_name, "sh");
        assert!(cmd.argv.is_empty());
    }

    #[test]
    fn resolve_command_splits_args() {
        let cmd = resolve_command("sh -c echo hi").expect("sh should resolve");
        assert_eq!(cmd.argv, vec!["-c", "echo", "hi"]);
        assert_eq!(cmd.tool_id, "sh -c echo hi");
        assert_eq!(cmd.display_name, "sh");
    }

    #[test]
    fn resolve_missing_command_errors() {
        let err = resolve_command("definitely-not-a-real-binary-zzz").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn resolve_empty_command_errors() {
        assert!(matches!(
            resolve_command("   ").unwrap_err(),
            AppError::BadRequest(_)
        ));
    }
}
