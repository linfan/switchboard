//! SQLite-backed durable store: tasks, sequenced messages, and per-client
//! delivery cursors. This is what makes gap-free replay survive restarts.

use std::path::Path;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use switchboard_shared::{now_millis, TaskInfo, TaskStatus};

use crate::error::AppResult;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    tool        TEXT NOT NULL,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    last_seq    INTEGER NOT NULL DEFAULT 0,
    pid         INTEGER
);

CREATE TABLE IF NOT EXISTS pty_chunks (
    task_id     TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    bytes       BLOB NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (task_id, seq)
);

CREATE TABLE IF NOT EXISTS delivery_cursors (
    client_id   TEXT NOT NULL,
    task_id     TEXT NOT NULL,
    last_seq    INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (client_id, task_id)
);
"#;

/// Durable store. Cheaply cloneable (the pool is reference-counted).
#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    /// Open (creating if needed) the SQLite database at `path` and apply schema.
    pub async fn connect(path: &str) -> AppResult<Self> {
        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).ok();
            }
        }
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))?
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(opts)
            .await?;
        sqlx::query(SCHEMA).execute(&pool).await?;
        // Migration for databases created before the `pid` column existed. The
        // ALTER errors ("duplicate column") on already-migrated DBs, which is
        // expected and harmless — ignore it.
        let _ = sqlx::query("ALTER TABLE tasks ADD COLUMN pid INTEGER")
            .execute(&pool)
            .await;
        Ok(Self { pool })
    }

    /// In-memory store for tests.
    #[cfg(test)]
    pub async fn memory() -> AppResult<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await?;
        sqlx::query(SCHEMA).execute(&pool).await?;
        Ok(Self { pool })
    }

    // ---- tasks ----------------------------------------------------------

    pub async fn create_task(&self, task: &TaskInfo) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO tasks (id, tool, title, status, created_at, last_seq)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&task.id)
        .bind(&task.tool)
        .bind(&task.title)
        .bind(serde_json::to_string(&task.status)?)
        .bind(task.created_at)
        .bind(task.last_seq as i64)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_tasks(&self) -> AppResult<Vec<TaskInfo>> {
        let rows: Vec<TaskRow> = sqlx::query_as(
            "SELECT id, tool, title, status, created_at, last_seq
             FROM tasks ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(TaskRow::into_info).collect()
    }

    pub async fn get_task(&self, id: &str) -> AppResult<Option<TaskInfo>> {
        let row: Option<TaskRow> = sqlx::query_as(
            "SELECT id, tool, title, status, created_at, last_seq FROM tasks WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(TaskRow::into_info).transpose()
    }

    pub async fn update_status(&self, id: &str, status: &TaskStatus) -> AppResult<()> {
        sqlx::query("UPDATE tasks SET status = ? WHERE id = ?")
            .bind(serde_json::to_string(status)?)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Record the OS pid of a task's live child, so a later server restart can
    /// check whether that process is still alive.
    pub async fn set_pid(&self, id: &str, pid: i64) -> AppResult<()> {
        sqlx::query("UPDATE tasks SET pid = ? WHERE id = ?")
            .bind(pid)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Every task's `(id, status, pid)` — used by startup orphan reconciliation
    /// to decide, per task, whether its recorded pid is still alive.
    pub async fn list_task_pids(&self) -> AppResult<Vec<(String, TaskStatus, Option<i64>)>> {
        let rows: Vec<(String, String, Option<i64>)> =
            sqlx::query_as("SELECT id, status, pid FROM tasks")
                .fetch_all(&self.pool)
                .await?;
        rows.into_iter()
            .map(|(id, status, pid)| Ok((id, serde_json::from_str(&status)?, pid)))
            .collect()
    }

    /// Permanently remove a task and all its durable state (chunks + delivery
    /// cursors) in one transaction, so no orphaned rows survive a delete.
    pub async fn delete_task(&self, id: &str) -> AppResult<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM pty_chunks WHERE task_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM delivery_cursors WHERE task_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM tasks WHERE id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    // ---- pty chunks -----------------------------------------------------

    /// Atomically assign the next monotonic seq for `task_id` and persist a
    /// chunk of raw terminal bytes. Returns the assigned seq. The seq is
    /// allocated under the same transaction as the insert, so concurrent writers
    /// can never collide. Persist-before-broadcast is what makes reconnect
    /// gap-free.
    pub async fn append_chunk(&self, task_id: &str, bytes: &[u8]) -> AppResult<u64> {
        let mut tx = self.pool.begin().await?;
        let (seq,): (i64,) = sqlx::query_as(
            "UPDATE tasks SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq",
        )
        .bind(task_id)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("INSERT INTO pty_chunks (task_id, seq, bytes, created_at) VALUES (?, ?, ?, ?)")
            .bind(task_id)
            .bind(seq)
            .bind(bytes)
            .bind(now_millis())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(seq as u64)
    }

    /// All chunks for `task_id` with `seq > after`, in order — the byte
    /// fast-forward replay window.
    pub async fn chunks_after(&self, task_id: &str, after: u64) -> AppResult<Vec<(u64, Vec<u8>)>> {
        let rows: Vec<(i64, Vec<u8>)> = sqlx::query_as(
            "SELECT seq, bytes FROM pty_chunks WHERE task_id = ? AND seq > ? ORDER BY seq ASC",
        )
        .bind(task_id)
        .bind(after as i64)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|(seq, b)| (seq as u64, b)).collect())
    }

    // ---- delivery cursors ----------------------------------------------

    /// Advance the durable delivery cursor for (client, task). Never moves
    /// backwards, so stale/out-of-order acks are harmless.
    pub async fn set_cursor(&self, client_id: &str, task_id: &str, last_seq: u64) -> AppResult<()> {
        sqlx::query(
            "INSERT INTO delivery_cursors (client_id, task_id, last_seq, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(client_id, task_id) DO UPDATE SET
                last_seq = MAX(last_seq, excluded.last_seq),
                updated_at = excluded.updated_at",
        )
        .bind(client_id)
        .bind(task_id)
        .bind(last_seq as i64)
        .bind(now_millis())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Read the durable delivery cursor. Part of the store's public surface and
    /// exercised by tests; the WS path treats the client-supplied cursor as
    /// authoritative, so this isn't on the hot path.
    #[allow(dead_code)]
    pub async fn get_cursor(&self, client_id: &str, task_id: &str) -> AppResult<u64> {
        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT last_seq FROM delivery_cursors WHERE client_id = ? AND task_id = ?",
        )
        .bind(client_id)
        .bind(task_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|(s,)| s as u64).unwrap_or(0))
    }
}

#[derive(sqlx::FromRow)]
struct TaskRow {
    id: String,
    tool: String,
    title: String,
    status: String,
    created_at: i64,
    last_seq: i64,
}

impl TaskRow {
    fn into_info(self) -> AppResult<TaskInfo> {
        Ok(TaskInfo {
            id: self.id,
            tool: self.tool,
            title: self.title,
            status: serde_json::from_str(&self.status)?,
            created_at: self.created_at,
            last_seq: self.last_seq as u64,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str) -> TaskInfo {
        TaskInfo {
            id: id.into(),
            tool: "claude".into(),
            title: "t".into(),
            status: TaskStatus::Running,
            created_at: now_millis(),
            last_seq: 0,
        }
    }

    #[tokio::test]
    async fn seq_is_monotonic_and_gap_free() {
        let s = Store::memory().await.unwrap();
        s.create_task(&task("t1")).await.unwrap();
        let a = s.append_chunk("t1", b"a").await.unwrap();
        let b = s.append_chunk("t1", b"b").await.unwrap();
        let c = s.append_chunk("t1", b"c").await.unwrap();
        assert_eq!((a, b, c), (1, 2, 3));
        let got = s.get_task("t1").await.unwrap().unwrap();
        assert_eq!(got.last_seq, 3);
    }

    #[tokio::test]
    async fn chunks_after_is_the_replay_window() {
        let s = Store::memory().await.unwrap();
        s.create_task(&task("t1")).await.unwrap();
        for t in [b"a".as_slice(), b"b", b"c", b"d"] {
            s.append_chunk("t1", t).await.unwrap();
        }
        let after1 = s.chunks_after("t1", 1).await.unwrap();
        assert_eq!(after1.len(), 3);
        assert_eq!(after1[0].0, 2);
        assert_eq!(after1[0].1, b"b");
        let after_all = s.chunks_after("t1", 4).await.unwrap();
        assert!(after_all.is_empty());
    }

    #[tokio::test]
    async fn cursor_never_moves_backwards() {
        let s = Store::memory().await.unwrap();
        s.create_task(&task("t1")).await.unwrap();
        assert_eq!(s.get_cursor("c1", "t1").await.unwrap(), 0);
        s.set_cursor("c1", "t1", 5).await.unwrap();
        assert_eq!(s.get_cursor("c1", "t1").await.unwrap(), 5);
        // A stale ack for a lower seq must not regress the cursor.
        s.set_cursor("c1", "t1", 3).await.unwrap();
        assert_eq!(s.get_cursor("c1", "t1").await.unwrap(), 5);
        s.set_cursor("c1", "t1", 9).await.unwrap();
        assert_eq!(s.get_cursor("c1", "t1").await.unwrap(), 9);
    }

    #[tokio::test]
    async fn task_crud_round_trips() {
        let s = Store::memory().await.unwrap();
        s.create_task(&task("t1")).await.unwrap();
        s.update_status("t1", &TaskStatus::Terminated)
            .await
            .unwrap();
        let got = s.get_task("t1").await.unwrap().unwrap();
        assert_eq!(got.status, TaskStatus::Terminated);
        assert_eq!(s.list_tasks().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn delete_task_removes_all_durable_state() {
        let s = Store::memory().await.unwrap();
        s.create_task(&task("t1")).await.unwrap();
        s.append_chunk("t1", b"a").await.unwrap();
        s.append_chunk("t1", b"b").await.unwrap();
        s.set_cursor("c1", "t1", 2).await.unwrap();

        s.delete_task("t1").await.unwrap();

        assert!(s.get_task("t1").await.unwrap().is_none());
        assert!(s.chunks_after("t1", 0).await.unwrap().is_empty());
        assert_eq!(s.get_cursor("c1", "t1").await.unwrap(), 0);
        assert!(s.list_tasks().await.unwrap().is_empty());
    }
}
