//! Agent CLI registry, argv builder, and stdout/stdin (JSONL) codec.
//!
//! Both `claude` and `qodercli` share the same streaming contract:
//! `<bin> -p --input-format stream-json --output-format stream-json --verbose`.
//! stdin receives one JSON user turn per line; stdout emits one JSON event per
//! line (`system` init, `assistant`, `user`, `result`, ...).

use std::path::Path;

use agent_manage_shared::{AgentEvent, AgentTool};
use serde_json::Value;

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

/// Command-line arguments to launch a streaming session for `spec`.
///
/// `permission_mode` maps to the CLI's `--permission-mode` (e.g. `default`,
/// `acceptEdits`, `bypassPermissions`). We intentionally do *not* pass
/// `--model`, letting the CLI use its configured default.
pub fn argv(_spec: &AgentSpec, permission_mode: &str) -> Vec<String> {
    vec![
        "-p".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--permission-mode".into(),
        permission_mode.into(),
    ]
}

/// Encode a user turn as a single stdin JSONL line (no trailing newline).
pub fn user_turn_json(text: &str) -> String {
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    })
    .to_string()
}

/// Parse one stdout line from an agent CLI into an [`AgentEvent`]. Lines that
/// are not valid JSON are wrapped as `stdout` events so nothing is ever dropped.
pub fn parse_line(line: &str) -> AgentEvent {
    match serde_json::from_str::<Value>(line) {
        Ok(value) => {
            let kind = value
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("raw")
                .to_string();
            let text = extract_text(&kind, &value);
            AgentEvent {
                kind,
                text,
                raw: value,
            }
        }
        Err(_) => AgentEvent {
            kind: "stdout".into(),
            text: Some(line.to_string()),
            raw: Value::String(line.to_string()),
        },
    }
}

/// Best-effort human-readable projection of an event for the UI.
fn extract_text(kind: &str, v: &Value) -> Option<String> {
    match kind {
        "assistant" | "user" => {
            let content = v.get("message")?.get("content")?;
            let joined = content
                .as_array()?
                .iter()
                .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                    Some("text") => block.get("text").and_then(Value::as_str).map(str::to_string),
                    Some("tool_use") => block
                        .get("name")
                        .and_then(Value::as_str)
                        .map(|n| format!("[tool: {n}]")),
                    Some("tool_result") => Some("[tool result]".to_string()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.is_empty()).then_some(joined)
        }
        "result" => v.get("result").and_then(Value::as_str).map(str::to_string),
        "system" => v.get("subtype").and_then(Value::as_str).map(str::to_string),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_assistant_text() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]}}"#;
        let ev = parse_line(line);
        assert_eq!(ev.kind, "assistant");
        assert_eq!(ev.text.as_deref(), Some("hello"));
    }

    #[test]
    fn parses_tool_use_projection() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{}}]}}"#;
        let ev = parse_line(line);
        assert_eq!(ev.text.as_deref(), Some("[tool: Bash]"));
    }

    #[test]
    fn parses_result_and_system() {
        assert_eq!(
            parse_line(r#"{"type":"result","subtype":"success","result":"done"}"#)
                .text
                .as_deref(),
            Some("done")
        );
        assert_eq!(
            parse_line(r#"{"type":"system","subtype":"init"}"#)
                .text
                .as_deref(),
            Some("init")
        );
    }

    #[test]
    fn non_json_becomes_stdout_event() {
        let ev = parse_line("plain log line");
        assert_eq!(ev.kind, "stdout");
        assert_eq!(ev.text.as_deref(), Some("plain log line"));
    }

    #[test]
    fn user_turn_is_valid_jsonl() {
        let s = user_turn_json("hi there");
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "hi there");
    }
}
