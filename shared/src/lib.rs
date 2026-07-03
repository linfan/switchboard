//! Shared wire protocol between the agent-manage client and hosting service.
//!
//! All messages are JSON, tagged unions (`{"type": "...", ...}`). Rust is the
//! source of truth; TypeScript bindings are generated via `ts-rs` into
//! `client/src/protocol/` (run `cargo test -p agent-manage-shared`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod frame;

/// Identifier for an agent CLI tool a hosting service can run (e.g. `claude`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct AgentTool {
    /// Stable id used when creating a task, e.g. `"claude"` or `"qodercli"`.
    pub id: String,
    /// Human-friendly name for display, e.g. `"Claude Code"`.
    pub display_name: String,
    /// Whether the underlying CLI was found on this host's PATH.
    pub available: bool,
}

/// Metadata a hosting service advertises to clients.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct ServiceInfo {
    /// Operator-chosen name for this hosting service.
    pub name: String,
    /// Server crate version.
    pub version: String,
    /// Agent tools this host can launch.
    pub tools: Vec<AgentTool>,
}

/// Lifecycle state of a task (one agent conversation).
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
#[ts(export, export_to = "client/src/protocol/")]
pub enum TaskStatus {
    /// Child process is being spawned.
    Starting,
    /// Agent is running and accepting input.
    Running,
    /// Agent process exited on its own with this code.
    Exited { code: Option<i32> },
    /// Terminated by an explicit client request.
    Terminated,
    /// Failed to start or crashed.
    Failed { error: String },
}

/// Summary of a task, sent in `Welcome` and `TaskCreated`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct TaskInfo {
    pub id: String,
    /// Tool id used to launch this task.
    pub tool: String,
    /// Display title (defaults to tool + short id).
    pub title: String,
    pub status: TaskStatus,
    /// Unix millis when the task was created.
    #[ts(type = "number")]
    pub created_at: i64,
    /// Highest PTY chunk seq currently persisted for this task.
    #[ts(type = "number")]
    pub last_seq: u64,
}

// --------------------------------------------------------------------------
// Client -> Server
// --------------------------------------------------------------------------

/// Messages the client sends to a hosting service over the WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "client/src/protocol/")]
pub enum ClientMsg {
    /// First frame after connecting. Carries a stable client id and, per task,
    /// the highest seq the client has durably applied — the server replays
    /// everything after each cursor.
    Hello {
        client_id: String,
        #[ts(type = "Record<string, number>")]
        cursors: HashMap<String, u64>,
    },
    /// Create a new task (conversation) running the given tool on a PTY sized
    /// `cols` × `rows` (the client's initial terminal size).
    CreateTask {
        tool: String,
        title: Option<String>,
        /// Working directory for the agent process (server-validated).
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    },
    /// Resize a task's PTY (and the server's authoritative screen) to match the
    /// client's terminal viewport.
    Resize {
        task_id: String,
        cols: u16,
        rows: u16,
    },
    /// Terminate a task's process.
    TerminateTask { task_id: String },
    /// Acknowledge durable receipt of messages up to `seq` for a task.
    Ack {
        task_id: String,
        #[ts(type = "number")]
        seq: u64,
    },
    /// Liveness probe; server replies `Pong` echoing `ts`.
    Ping {
        #[ts(type = "number")]
        ts: i64,
    },
}

// --------------------------------------------------------------------------
// Server -> Client
// --------------------------------------------------------------------------

/// Messages the hosting service sends to the client over the WebSocket.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "client/src/protocol/")]
pub enum ServerMsg {
    /// Sent in response to `Hello`: service metadata + current task list.
    Welcome {
        service: ServiceInfo,
        tasks: Vec<TaskInfo>,
    },
    /// A new task was created (by this or another client).
    TaskCreated { task: TaskInfo },
    /// A task changed lifecycle state.
    TaskState { task_id: String, status: TaskStatus },
    /// All backlog for a task has been replayed; live streaming resumes.
    ///
    /// Terminal OUTPUT/SNAPSHOT bytes travel as binary WS frames (see
    /// `frame.rs`), not as members of this enum.
    ReplayDone {
        task_id: String,
        #[ts(type = "number")]
        last_seq: u64,
    },
    /// Liveness reply echoing the client's `Ping.ts`.
    Pong {
        #[ts(type = "number")]
        ts: i64,
    },
    /// A recoverable error, optionally scoped to a task.
    Error {
        task_id: Option<String>,
        code: Option<String>,
        message: String,
    },
}

/// Unix time in milliseconds.
pub fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_msg_round_trips() {
        let mut cursors = HashMap::new();
        cursors.insert("t1".to_string(), 42u64);
        let msg = ClientMsg::Hello {
            client_id: "c1".into(),
            cursors,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"hello\""));
        let back: ClientMsg = serde_json::from_str(&json).unwrap();
        matches!(back, ClientMsg::Hello { .. });
    }

    #[test]
    fn server_replay_done_tag_is_snake_case() {
        let msg = ServerMsg::ReplayDone {
            task_id: "t1".into(),
            last_seq: 7,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"replay_done\""));
        assert!(json.contains("\"last_seq\":7"));
        let back: ServerMsg = serde_json::from_str(&json).unwrap();
        if let ServerMsg::ReplayDone { last_seq, .. } = back {
            assert_eq!(last_seq, 7);
        } else {
            panic!("wrong variant");
        }
    }

    #[test]
    fn resize_round_trips() {
        let msg = ClientMsg::Resize {
            task_id: "t1".into(),
            cols: 120,
            rows: 40,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"resize\""));
        let back: ClientMsg = serde_json::from_str(&json).unwrap();
        matches!(back, ClientMsg::Resize { .. });
    }

    #[test]
    fn task_status_serialization() {
        let s = TaskStatus::Exited { code: Some(0) };
        let json = serde_json::to_string(&s).unwrap();
        assert_eq!(json, r#"{"state":"exited","code":0}"#);
    }

    /// Regenerates the TypeScript bindings. Destination base is controlled by
    /// `TS_RS_EXPORT_DIR` (set to the workspace root by the Makefile) so files
    /// land in `client/src/protocol/`. Kept as a test so a plain
    /// `cargo test -p agent-manage-shared` regenerates them.
    #[test]
    fn export_bindings() {
        ServerMsg::export_all().unwrap();
        ClientMsg::export_all().unwrap();
    }
}
