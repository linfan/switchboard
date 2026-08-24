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
    let looks_like_path = bin.contains('/') || (cfg!(windows) && bin.contains('\\'));
    if looks_like_path {
        return probe(Path::new(bin));
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| probe(&dir.join(bin)))
}

/// Test one candidate path, returning the executable that will actually be
/// spawned. On Windows a name carries no implicit extension, so each `PATHEXT`
/// suffix is tried after the literal path — that is how `cmd`, `powershell`, and
/// npm-installed CLIs (`claude` → `claude.cmd`) resolve.
fn probe(candidate: &Path) -> Option<String> {
    if candidate.is_file() {
        return Some(candidate.to_string_lossy().into_owned());
    }
    #[cfg(windows)]
    {
        for ext in pathext() {
            let mut with_ext = candidate.as_os_str().to_owned();
            with_ext.push(&ext);
            let with_ext = std::path::PathBuf::from(with_ext);
            if with_ext.is_file() {
                return Some(with_ext.to_string_lossy().into_owned());
            }
        }
    }
    None
}

/// Executable extensions to append to a bare name, from `PATHEXT`.
#[cfg(windows)]
fn pathext() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .map(str::trim)
        .filter(|e| e.len() > 1)
        .map(str::to_string)
        .collect()
}

/// `CreateProcess` cannot execute a batch script, so a resolved `.cmd`/`.bat`
/// (how npm-installed CLIs land on Windows) has to run through the command
/// interpreter instead of being spawned directly.
#[cfg(windows)]
fn spawnable(bin: String, argv: Vec<String>) -> (String, Vec<String>) {
    let is_batch = Path::new(&bin)
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if !is_batch {
        return (bin, argv);
    }
    let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
    let mut wrapped = vec!["/c".to_string(), bin];
    wrapped.extend(argv);
    (comspec, wrapped)
}

#[cfg(not(windows))]
fn spawnable(bin: String, argv: Vec<String>) -> (String, Vec<String>) {
    (bin, argv)
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
        let (bin, argv) = spawnable(bin, interactive_argv(spec));
        return Ok(ResolvedCommand {
            tool_id: spec.id.to_string(),
            display_name: spec.display_name.to_string(),
            bin,
            argv,
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
    let (bin, argv) = spawnable(bin, argv);
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

    #[cfg(unix)]
    #[test]
    fn resolve_arbitrary_command_on_path() {
        let cmd = resolve_command("sh").expect("sh should resolve");
        assert!(cmd.bin.ends_with("/sh"), "bin was {}", cmd.bin);
        assert_eq!(cmd.tool_id, "sh");
        assert_eq!(cmd.display_name, "sh");
        assert!(cmd.argv.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_command_splits_args() {
        let cmd = resolve_command("sh -c echo hi").expect("sh should resolve");
        assert_eq!(cmd.argv, vec!["-c", "echo", "hi"]);
        assert_eq!(cmd.tool_id, "sh -c echo hi");
        assert_eq!(cmd.display_name, "sh");
    }

    /// The Windows shells must resolve from a bare, extension-less name — what a
    /// user types when they ask for a terminal on a Windows host.
    #[cfg(windows)]
    #[test]
    fn resolve_windows_shells_via_pathext() {
        for shell in ["cmd", "powershell"] {
            let cmd = resolve_command(shell).unwrap_or_else(|e| panic!("{shell}: {e}"));
            assert!(
                cmd.bin
                    .to_ascii_lowercase()
                    .ends_with(&format!("{shell}.exe")),
                "bin was {}",
                cmd.bin
            );
            assert_eq!(cmd.display_name, shell);
        }
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
