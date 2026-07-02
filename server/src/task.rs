//! Task lifecycle management. Phase P2 handles persistence + validation;
//! phases P3/P4 add process supervision and live broadcast.

use agent_manage_shared::{now_millis, TaskInfo, TaskStatus};
use uuid::Uuid;

use crate::{agent, error::AppError, error::AppResult, store::Store};

/// Parameters for creating a task.
pub struct CreateParams {
    pub tool: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub initial_prompt: Option<String>,
}

#[derive(Clone)]
pub struct TaskManager {
    store: Store,
}

impl TaskManager {
    pub fn new(store: Store) -> Self {
        Self { store }
    }

    pub async fn list(&self) -> AppResult<Vec<TaskInfo>> {
        self.store.list_tasks().await
    }

    pub async fn get(&self, id: &str) -> AppResult<Option<TaskInfo>> {
        self.store.get_task(id).await
    }

    /// Validate the requested tool, persist a new task record, and return it.
    /// Process spawning is wired in phase P3.
    pub async fn create(&self, params: CreateParams) -> AppResult<TaskInfo> {
        let spec = agent::spec(&params.tool)
            .ok_or_else(|| AppError::BadRequest(format!("unknown tool: {}", params.tool)))?;
        if agent::which(spec.bin).is_none() {
            return Err(AppError::BadRequest(format!(
                "tool '{}' is not installed on this host",
                spec.id
            )));
        }
        let id = Uuid::new_v4().to_string();
        let title = params.title.unwrap_or_else(|| {
            format!("{} · {}", spec.display_name, &id[..8])
        });
        let info = TaskInfo {
            id,
            tool: spec.id.to_string(),
            title,
            status: TaskStatus::Starting,
            created_at: now_millis(),
            last_seq: 0,
        };
        self.store.create_task(&info).await?;
        Ok(info)
    }

    /// Mark a task terminated. Process kill is wired in phase P3.
    pub async fn terminate(&self, id: &str) -> AppResult<()> {
        if self.store.get_task(id).await?.is_none() {
            return Err(AppError::NotFound(format!("task {id}")));
        }
        self.store.update_status(id, &TaskStatus::Terminated).await?;
        Ok(())
    }
}
