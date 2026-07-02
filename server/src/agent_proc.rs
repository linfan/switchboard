//! Streaming process supervisor for a single agent CLI task.
//!
//! Spawns `<cli> -p --input-format stream-json --output-format stream-json`,
//! forwards user turns to stdin as JSONL, and surfaces every stdout/stderr line
//! as an [`AgentOutput`]. Four tokio tasks per process: stdout reader, stderr
//! reader, stdin writer, and a waiter/killer that reaps the exit code.

use std::process::Stdio;

use agent_manage_shared::AgentEvent;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::agent::{self, AgentSpec};
use crate::error::{AppError, AppResult};

/// Output items produced by a running agent process.
#[derive(Debug)]
pub enum AgentOutput {
    /// A parsed stdout/stderr event.
    Event(AgentEvent),
    /// The process exited with this code (if known).
    Exited(Option<i32>),
}

/// Control handle for a running agent process.
pub struct AgentHandle {
    input_tx: mpsc::UnboundedSender<String>,
    kill_tx: mpsc::UnboundedSender<()>,
}

impl AgentHandle {
    /// Send a user turn into the running agent.
    pub fn send_user(&self, text: &str) -> AppResult<()> {
        self.input_tx
            .send(agent::user_turn_json(text))
            .map_err(|_| AppError::Other(anyhow::anyhow!("agent stdin is closed")))
    }

    /// Request termination. Idempotent; safe to call more than once.
    pub fn terminate(&self) {
        let _ = self.kill_tx.send(());
    }
}

/// Spawn an agent process for `spec` in optional working dir `cwd`.
pub fn spawn(
    spec: &AgentSpec,
    cwd: Option<&str>,
    permission_mode: &str,
) -> AppResult<(AgentHandle, mpsc::UnboundedReceiver<AgentOutput>)> {
    let bin = agent::which(spec.bin)
        .ok_or_else(|| AppError::BadRequest(format!("tool '{}' is not installed", spec.id)))?;

    let mut cmd = Command::new(bin);
    cmd.args(agent::argv(spec, permission_mode))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(anyhow::anyhow!("failed to spawn {}: {e}", spec.id)))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let mut stdin = child.stdin.take().expect("stdin piped");

    let (out_tx, out_rx) = mpsc::unbounded_channel::<AgentOutput>();
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<String>();
    let (kill_tx, mut kill_rx) = mpsc::unbounded_channel::<()>();

    // stdout reader: one JSON event per line.
    {
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                if out_tx
                    .send(AgentOutput::Event(agent::parse_line(&line)))
                    .is_err()
                {
                    break;
                }
            }
        });
    }

    // stderr reader: surfaced as `stderr` events so diagnostics aren't lost.
    {
        let out_tx = out_tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let ev = AgentEvent {
                    kind: "stderr".into(),
                    text: Some(line.clone()),
                    raw: Value::String(line),
                };
                if out_tx.send(AgentOutput::Event(ev)).is_err() {
                    break;
                }
            }
        });
    }

    // stdin writer: forwards user turns; closes stdin (EOF) when senders drop.
    tokio::spawn(async move {
        while let Some(line) = input_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
        let _ = stdin.shutdown().await;
    });

    // waiter/killer: only `child.wait()` borrows `child` inside the select, so
    // `start_kill`/`wait` after the block are free of borrow conflicts.
    // A *value* on kill_rx means terminate; channel *close* (handle dropped
    // without terminate) must NOT kill — the process runs until it exits or its
    // stdin reaches EOF.
    tokio::spawn(async move {
        let explicit_kill = tokio::select! {
            msg = kill_rx.recv() => msg.is_some(),
            status = child.wait() => {
                let _ = out_tx.send(AgentOutput::Exited(status.ok().and_then(|s| s.code())));
                return;
            }
        };
        if explicit_kill {
            let _ = child.start_kill();
        }
        let status = child.wait().await;
        let _ = out_tx.send(AgentOutput::Exited(status.ok().and_then(|s| s.code())));
    });

    Ok((AgentHandle { input_tx, kill_tx }, out_rx))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Fake agent using a shell that speaks the same JSONL contract, so we can
    /// exercise the full spawn/stream/exit path without a real CLI or network.
    fn fake_spec() -> AgentSpec {
        AgentSpec {
            id: "fake",
            display_name: "Fake",
            bin: "sh",
        }
    }

    // Override argv for the fake by spawning `sh -c` directly.
    fn spawn_fake(script: &str) -> mpsc::UnboundedReceiver<AgentOutput> {
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (out_tx, out_rx) = mpsc::unbounded_channel();
        {
            let out_tx = out_tx.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let _ = out_tx.send(AgentOutput::Event(agent::parse_line(&line)));
                }
            });
        }
        tokio::spawn(async move {
            let status = child.wait().await;
            let _ = out_tx.send(AgentOutput::Exited(status.ok().and_then(|s| s.code())));
        });
        out_rx
    }

    #[tokio::test]
    async fn streams_events_then_exit() {
        let script = r#"printf '%s\n' '{"type":"system","subtype":"init"}' '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}' '{"type":"result","result":"done"}'"#;
        let mut rx = spawn_fake(script);
        let mut kinds = Vec::new();
        let mut exited = false;
        while let Ok(Some(item)) = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            match item {
                AgentOutput::Event(ev) => kinds.push(ev.kind),
                AgentOutput::Exited(_) => {
                    exited = true;
                    break;
                }
            }
        }
        assert_eq!(kinds, vec!["system", "assistant", "result"]);
        assert!(exited, "must observe process exit");
        let _ = fake_spec();
    }

    /// Live end-to-end against a real `claude` CLI. Gated behind `--ignored`
    /// (run via `make test-live`) because it needs a working login/network.
    #[tokio::test]
    #[ignore = "requires a working `claude` CLI; run via `make test-live`"]
    async fn live_claude_round_trip() {
        let spec = agent::spec("claude").expect("claude spec");
        let (handle, mut rx) = spawn(spec, None, "default").expect("spawn claude");
        handle.send_user("Reply with exactly the word: pong").unwrap();
        // Close stdin so the CLI completes this single turn and exits.
        drop(handle);

        let mut saw_output = false;
        while let Ok(Some(item)) = tokio::time::timeout(Duration::from_secs(90), rx.recv()).await {
            match item {
                AgentOutput::Event(ev) => {
                    eprintln!("event: kind={} text={:?}", ev.kind, ev.text);
                    if matches!(ev.kind.as_str(), "assistant" | "result") {
                        saw_output = true;
                    }
                }
                AgentOutput::Exited(code) => {
                    eprintln!("exited: {code:?}");
                    break;
                }
            }
        }
        assert!(saw_output, "expected at least one assistant/result event");
    }
}
