//! REST API: health, service info, and task CRUD.

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{header, StatusCode},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use switchboard_shared::{
    FileContent, FsListing, FsStat, GitChange, GitCommit, GitDiff, GitFileDiff, GitInfo,
    GitWorktree, ServiceInfo, TaskInfo,
};

use crate::{auth, editor, error::AppResult, fs, state::SharedState, task::CreateParams, ws};

/// Build the full application router. `require_auth` gates the per-request
/// SWB-v1 signature check: `true` for a directly-connected worker or a
/// repeater's client-facing ingress; `false` for the repeater→worker tunnel,
/// where the repeater has already authenticated the client and the tunnel itself
/// is authenticated by `SWITCHBOARD_REPEATER_TOKEN`.
pub fn router(state: SharedState, require_auth: bool) -> Router {
    let mut api = Router::new()
        .route("/info", get(info))
        .route("/fs", get(list_dir))
        .route("/fs/stat", get(stat_path))
        .route("/fs/mkdir", post(make_dir))
        .route("/fs/create", post(create_entry))
        .route("/fs/rename", post(rename_entry))
        .route("/fs/delete", post(delete_entry))
        .route(
            "/fs/upload",
            // Raw file bytes in the body; lift the ~2 MiB default to 100 MiB.
            post(upload_file).layer(DefaultBodyLimit::max(100 * 1024 * 1024)),
        )
        .route("/fs/download", get(download_file))
        .route("/file", get(read_file).put(write_file))
        .route("/git/info", get(git_info))
        .route("/git/branches", get(git_branches))
        .route("/git/log", get(git_log))
        .route("/git/changes", get(git_changes))
        .route("/git/diff", get(git_diff))
        .route("/git/filediff", get(git_file_diff))
        .route(
            "/git/worktree",
            post(git_worktree).delete(git_worktree_remove),
        )
        .route("/tasks", get(list_tasks).post(create_task))
        .route("/tasks/{id}", axum::routing::delete(terminate_task))
        .route(
            "/admin/upgrade/upload",
            // Raw binary bytes in the body; lift the ~2 MiB default to 100 MiB.
            post(upgrade_upload).layer(DefaultBodyLimit::max(100 * 1024 * 1024)),
        )
        .route("/admin/upgrade/url", post(upgrade_from_url));
    if require_auth {
        api = api.route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_signed,
        ));
    }

    Router::new()
        .route("/health", get(health))
        .route("/ws", get(ws::ws_handler))
        .route("/forward", get(crate::port_forward::handler))
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

/// Report whether a path exists on the host and whether it's a directory
/// (before creating a workspace, so a missing folder can be offered for creation).
async fn stat_path(Query(q): Query<PathQuery>) -> AppResult<Json<FsStat>> {
    Ok(Json(fs::stat(&q.path)?))
}

#[derive(Deserialize)]
struct MkdirBody {
    path: String,
}

/// Create a directory (and any missing parents) on the host.
async fn make_dir(Json(body): Json<MkdirBody>) -> AppResult<StatusCode> {
    fs::mkdir(&body.path)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct CreateBody {
    dir: String,
    name: String,
    is_dir: bool,
}

/// Create an empty file or a folder inside a directory (file-tree context menu).
async fn create_entry(Json(body): Json<CreateBody>) -> AppResult<StatusCode> {
    fs::create(&body.dir, &body.name, body.is_dir)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct RenameBody {
    path: String,
    new_name: String,
}

/// Rename a file/directory to a sibling name (file-tree context menu).
async fn rename_entry(Json(body): Json<RenameBody>) -> AppResult<StatusCode> {
    fs::rename(&body.path, &body.new_name)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct DeleteBody {
    path: String,
}

/// Delete a file, or a directory and its contents (file-tree context menu).
async fn delete_entry(Json(body): Json<DeleteBody>) -> AppResult<StatusCode> {
    fs::delete(&body.path)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UploadQuery {
    dir: String,
    name: String,
}

/// Write an uploaded file's raw bytes into `dir` as `name`.
async fn upload_file(Query(q): Query<UploadQuery>, body: Bytes) -> AppResult<StatusCode> {
    fs::upload(&q.dir, &q.name, &body)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Stream a file's raw bytes for download (client saves it locally).
async fn download_file(Query(q): Query<PathQuery>) -> AppResult<Response> {
    let (name, bytes) = fs::read_bytes(&q.path)?;
    // A quoted filename with quotes/backslashes escaped keeps the header valid.
    let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{escaped}\""),
            ),
        ],
        bytes,
    )
        .into_response())
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

/// Save a file's contents (the editor's Save). Responds with the file's new
/// mtime so the editor can rebase its disk-change detection.
async fn write_file(Json(body): Json<WriteFileBody>) -> AppResult<Json<Value>> {
    let mtime = editor::write_file(&body.path, &body.content).await?;
    Ok(Json(json!({ "mtime": mtime })))
}

#[derive(Deserialize)]
struct CwdQuery {
    cwd: String,
}

/// Report git availability + repo state for a workspace folder.
async fn git_info(Query(q): Query<CwdQuery>) -> AppResult<Json<GitInfo>> {
    Ok(Json(editor::git_info(&q.cwd).await?))
}

/// List local branch names for a workspace folder's repo.
async fn git_branches(Query(q): Query<CwdQuery>) -> AppResult<Json<Vec<String>>> {
    Ok(Json(editor::git_branches(&q.cwd).await?))
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

#[derive(Deserialize)]
struct WorktreeBody {
    /// Repo folder to create the worktree from.
    cwd: String,
    /// Workspace name — the parent folder under `.switchboard/worktree`.
    workspace_name: String,
    /// Worktree name — the leaf folder under the workspace directory.
    worktree_name: String,
    /// Branch to check out (when `new_branch` is false) or create (when true).
    branch: String,
    /// Create `branch` as a new branch at HEAD rather than checking it out.
    new_branch: bool,
}

/// Create a git worktree at `$HOME/.switchboard/worktree/<workspace>/<name>`.
async fn git_worktree(Json(body): Json<WorktreeBody>) -> AppResult<Json<GitWorktree>> {
    Ok(Json(
        editor::git_worktree_add(
            &body.cwd,
            &body.workspace_name,
            &body.worktree_name,
            body.branch.trim(),
            body.new_branch,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
struct WorktreeRemoveQuery {
    /// Worktree folder to remove (the workspace's cwd on the host).
    cwd: String,
}

/// Remove a git worktree (and its directory) created under `.switchboard/worktree`.
async fn git_worktree_remove(Query(q): Query<WorktreeRemoveQuery>) -> AppResult<Json<Value>> {
    editor::git_worktree_remove(&q.cwd).await?;
    Ok(Json(json!({ "ok": true })))
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

#[derive(Deserialize)]
struct UpgradeUploadQuery {
    /// Optional expected SHA-256 (hex) of the uploaded binary.
    sha256: Option<String>,
}

/// Replace the running server binary with the uploaded raw bytes, then restart
/// in place. Running tasks live in their own pty-host processes, so they keep
/// streaming across the restart; the client's auto-reconnect covers the WS blip.
async fn upgrade_upload(
    State(state): State<SharedState>,
    Query(q): Query<UpgradeUploadQuery>,
    body: Bytes,
) -> AppResult<Json<Value>> {
    // Upload carries no server-side integrity source, so verify the caller's
    // optional checksum before we validate the format.
    if let Some(want) = q.sha256.as_deref() {
        crate::upgrade::verify_sha256(&body, want)?;
    }
    apply_upgrade(&state, &body)
}

#[derive(Deserialize)]
struct UpgradeUrlBody {
    url: String,
    /// Optional expected SHA-256 (hex); verified during the download.
    sha256: Option<String>,
}

/// Download a new server binary from `url` on the host, replace the running
/// binary, then restart in place.
async fn upgrade_from_url(
    State(state): State<SharedState>,
    Json(body): Json<UpgradeUrlBody>,
) -> AppResult<Json<Value>> {
    // fetch_binary verifies the checksum itself, so it's already checked here.
    let bytes = crate::upgrade::fetch_binary(&body.url, body.sha256.as_deref()).await?;
    apply_upgrade(&state, &bytes)
}

/// Validate `bytes`, atomically swap it in over the running executable, then
/// schedule the in-place re-exec. Returns as soon as the file is swapped; the
/// re-exec fires shortly after so the HTTP response reaches the client first.
fn apply_upgrade(state: &SharedState, bytes: &[u8]) -> AppResult<Json<Value>> {
    tracing::info!(
        size = bytes.len(),
        "self-upgrade requested; validating new binary"
    );
    crate::upgrade::validate_binary(bytes)?;
    let exe = crate::upgrade::replace_current_exe(bytes)?;
    tracing::info!(
        exe = %exe.display(),
        size = bytes.len(),
        "self-upgrade: replaced server binary on disk; scheduling re-exec"
    );
    schedule_restart(state.clone());
    Ok(Json(json!({ "ok": true })))
}

/// Spawn the delayed in-place restart: wait briefly so the HTTP response flushes,
/// then `execve` the new binary. On success the process image is replaced and
/// this never returns; a failure is logged and the (old) server keeps running.
fn schedule_restart(state: SharedState) {
    tokio::spawn(async move {
        // Let the upgrade response flush to the client first. On a repeater-client
        // that response travels back *through* the tunnel, so this must happen
        // before we close it.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        // Gracefully unpair from the repeater (if we're a repeater-client) so its
        // single worker slot is freed before the re-exec'd process re-dials —
        // otherwise the newcomer races the half-open socket we'd leave behind. A
        // no-op for the direct role (nothing waits on this).
        state.tunnel_shutdown.notify_waiters();
        // Give the WS Close a moment to flush before we replace the process image.
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        tracing::info!("self-upgrade: re-exec now");
        if let Err(e) = crate::restart::exec_replacement() {
            tracing::error!(error = %e, "self-upgrade re-exec failed; still on old binary");
        }
    });
}
