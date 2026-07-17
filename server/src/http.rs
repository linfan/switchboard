//! REST API: health, service info, and task CRUD.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use switchboard_shared::{
    FileContent, FsListing, GitChange, GitCommit, GitDiff, GitFileDiff, GitInfo, ServiceInfo,
    TaskInfo,
};

use crate::{auth, editor, error::AppResult, fs, state::SharedState, task::CreateParams, ws};

/// Build the full application router (REST now; the WS route is added in P4).
pub fn router(state: SharedState) -> Router {
    let api = Router::new()
        .route("/info", get(info))
        .route("/fs", get(list_dir))
        .route("/file", get(read_file).put(write_file))
        .route("/git/info", get(git_info))
        .route("/git/log", get(git_log))
        .route("/git/changes", get(git_changes))
        .route("/git/diff", get(git_diff))
        .route("/git/filediff", get(git_file_diff))
        .route("/tasks", get(list_tasks).post(create_task))
        .route("/tasks/{id}", axum::routing::delete(terminate_task))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_bearer,
        ));

    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::ws_handler))
        .nest("/api", api)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Unauthenticated liveness endpoint.
async fn health(State(state): State<SharedState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "name": state.config.service_name,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

async fn info(State(state): State<SharedState>) -> Json<ServiceInfo> {
    Json(state.service_info())
}

#[derive(Deserialize)]
struct FsQuery {
    path: Option<String>,
}

/// List a directory on the hosting machine (for the working-dir folder picker).
async fn list_dir(Query(q): Query<FsQuery>) -> AppResult<Json<FsListing>> {
    Ok(Json(fs::list_dir(q.path.as_deref())?))
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

/// Read a file's contents for the workspace editor.
async fn read_file(Query(q): Query<PathQuery>) -> AppResult<Json<FileContent>> {
    Ok(Json(editor::read_file(&q.path).await?))
}

#[derive(Deserialize)]
struct WriteFileBody {
    path: String,
    content: String,
}

/// Save a file's contents (the editor's Save).
async fn write_file(Json(body): Json<WriteFileBody>) -> AppResult<StatusCode> {
    editor::write_file(&body.path, &body.content).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct CwdQuery {
    cwd: String,
}

/// Report git availability + repo state for a workspace folder.
async fn git_info(Query(q): Query<CwdQuery>) -> AppResult<Json<GitInfo>> {
    Ok(Json(editor::git_info(&q.cwd).await?))
}

/// List commits on the current branch.
async fn git_log(Query(q): Query<CwdQuery>) -> AppResult<Json<Vec<GitCommit>>> {
    Ok(Json(editor::git_log(&q.cwd).await?))
}

#[derive(Deserialize)]
struct ChangesQuery {
    cwd: String,
    /// Commit hash, or `"WORKING"` for uncommitted changes.
    commit: String,
}

/// List files changed in a commit or the working tree.
async fn git_changes(Query(q): Query<ChangesQuery>) -> AppResult<Json<Vec<GitChange>>> {
    Ok(Json(editor::git_changes(&q.cwd, &q.commit).await?))
}

#[derive(Deserialize)]
struct DiffQuery {
    cwd: String,
    commit: String,
    path: String,
}

/// Unified diff for one file in a commit or the working tree.
async fn git_diff(Query(q): Query<DiffQuery>) -> AppResult<Json<GitDiff>> {
    Ok(Json(editor::git_diff(&q.cwd, &q.commit, &q.path).await?))
}

/// Old + new contents of one file, for the editor's diff view.
async fn git_file_diff(Query(q): Query<DiffQuery>) -> AppResult<Json<GitFileDiff>> {
    Ok(Json(
        editor::git_file_diff(&q.cwd, &q.commit, &q.path).await?,
    ))
}

async fn list_tasks(State(state): State<SharedState>) -> AppResult<Json<Vec<TaskInfo>>> {
    Ok(Json(state.tasks.list().await?))
}

#[derive(Deserialize)]
struct CreateTaskBody {
    tool: String,
    title: Option<String>,
    cwd: Option<String>,
    /// Initial PTY size; defaults to 80×24 if the REST caller omits them.
    cols: Option<u16>,
    rows: Option<u16>,
}

async fn create_task(
    State(state): State<SharedState>,
    Json(body): Json<CreateTaskBody>,
) -> AppResult<(StatusCode, Json<TaskInfo>)> {
    let info = state
        .tasks
        .create(CreateParams {
            tool: body.tool,
            title: body.title,
            cwd: body.cwd,
            cols: body.cols.unwrap_or(80),
            rows: body.rows.unwrap_or(24),
        })
        .await?;
    Ok((StatusCode::CREATED, Json(info)))
}

async fn terminate_task(
    State(state): State<SharedState>,
    Path(id): Path<String>,
) -> AppResult<StatusCode> {
    state.tasks.terminate(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}
