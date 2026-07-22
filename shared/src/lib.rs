//! Shared wire protocol between the switchboard client and hosting service.
//!
//! All messages are JSON, tagged unions (`{"type": "...", ...}`). Rust is the
//! source of truth; TypeScript bindings are generated via `ts-rs` into
//! `client/src/protocol/` (run `cargo test -p switchboard-shared`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod auth;
pub mod frame;
pub mod tunnel;

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

/// One entry in a server-side directory listing (REST `/api/fs`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct FsEntry {
    /// File/directory name (no path separators).
    pub name: String,
    /// Absolute path on the hosting machine.
    pub path: String,
    /// Whether this entry is a directory.
    pub is_dir: bool,
}

/// A directory listing of the hosting machine's filesystem (REST `/api/fs`),
/// used by the client's working-directory folder picker.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct FsListing {
    /// Absolute, canonicalized path that was listed.
    pub path: String,
    /// Parent directory, or `None` at the filesystem root.
    pub parent: Option<String>,
    /// Immediate children (directories first, then files).
    pub entries: Vec<FsEntry>,
}

/// Existence + type of a path on the hosting machine (REST `GET /api/fs/stat`).
/// Used before creating a workspace: a missing folder prompts the client to
/// offer creating it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct FsStat {
    /// Whether anything exists at the path.
    pub exists: bool,
    /// Whether the existing entry is a directory (false when it doesn't exist
    /// or is a file).
    pub is_dir: bool,
}

/// Contents of a file on the hosting machine (REST `GET /api/file`), for the
/// workspace file editor.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct FileContent {
    /// Absolute, canonicalized path that was read.
    pub path: String,
    /// UTF-8 (lossy) file contents. Empty when `truncated` flags a binary/oversize file.
    pub content: String,
    /// True when the file was too large or looked binary and was not returned in full.
    pub truncated: bool,
}

/// Git availability + repo state for a workspace folder (REST `GET /api/git/info`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct GitInfo {
    /// Whether a `git` binary is on the host's PATH at all.
    pub available: bool,
    /// Whether the workspace folder is inside a git work tree.
    pub is_repo: bool,
    /// Current branch name (or detached-HEAD short hash), if a repo.
    pub branch: Option<String>,
}

/// One commit on the current branch (REST `GET /api/git/log`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct GitCommit {
    /// Full commit hash.
    pub hash: String,
    /// Abbreviated hash for display.
    pub short: String,
    /// First line of the commit message.
    pub subject: String,
    /// Remainder of the commit message (everything after the subject), possibly empty.
    pub body: String,
    /// Author name.
    pub author: String,
    /// Author date, human-readable relative form (e.g. `2 days ago`).
    pub date: String,
}

/// One changed file within a commit or the working tree (REST `GET /api/git/changes`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct GitChange {
    /// Path relative to the repo root.
    pub path: String,
    /// Porcelain status code, e.g. `M`, `A`, `D`, `??`.
    pub status: String,
}

/// A unified diff for one file (REST `GET /api/git/diff`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct GitDiff {
    /// Path the diff is for (relative to the repo root).
    pub path: String,
    /// Unified-diff text (empty if there is no difference).
    pub diff: String,
}

/// Old + new contents of one file, for an editor diff view (REST `GET /api/git/filediff`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "client/src/protocol/")]
pub struct GitFileDiff {
    /// Path the diff is for (relative to the repo root).
    pub path: String,
    /// The "before" side. Empty for a file that was added (or is untracked).
    pub old_text: String,
    /// The "after" side. Empty for a file that was deleted.
    pub new_text: String,
    /// True when either side looks binary (contains a NUL); the client shows a
    /// notice instead of attempting a diff.
    pub binary: bool,
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
    /// Delete a task entirely: terminate its process if running, then remove the
    /// task and all its persisted terminal data from the host.
    DeleteTask { task_id: String },
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
    /// A task was deleted (by this or another client); clients drop it and its
    /// terminal/cursor state.
    TaskDeleted { task_id: String },
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
    /// `cargo test -p switchboard-shared` regenerates them.
    #[test]
    fn export_bindings() {
        ServerMsg::export_all().unwrap();
        ClientMsg::export_all().unwrap();
        FsListing::export_all().unwrap();
        FsStat::export_all().unwrap();
        FileContent::export_all().unwrap();
        GitInfo::export_all().unwrap();
        GitCommit::export_all().unwrap();
        GitChange::export_all().unwrap();
        GitDiff::export_all().unwrap();
    }
}
