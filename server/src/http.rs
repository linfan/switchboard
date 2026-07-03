//! REST API: health, service info, and task CRUD.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    middleware,
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use agent_manage_shared::{ServiceInfo, TaskInfo};

use crate::{
    auth,
    error::AppResult,
    state::SharedState,
    task::CreateParams,
    ws,
};

/// Build the full application router (REST now; the WS route is added in P4).
pub fn router(state: SharedState) -> Router {
    let api = Router::new()
        .route("/info", get(info))
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
