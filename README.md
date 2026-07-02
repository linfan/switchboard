# Agent-Manage

Cross-host, multi-agent management tool. A desktop **client** connects to one or
more **hosting services**; each hosting service runs and supervises multiple
CLI-based agent tasks (Claude Code, Qoder CLI, or any compatible CLI agent).
Each task is an independent conversation with its own isolated context.

## Highlights
- **One client, many hosts, many tasks.** Add hosting services at runtime; run
  many concurrent agent conversations per host.
- **Real-time streaming** over a persistent WebSocket.
- **No message loss.** Every agent event is sequenced and persisted server-side;
  reconnects replay undelivered events gap-free, with client-side dedup by seq.
- **Resilient client.** Exponential-backoff auto-reconnect + manual trigger;
  detects network drops *and* system resume-from-sleep; heartbeat watchdog.

## Repository layout
| Path       | What |
|------------|------|
| `shared/`  | Rust protocol crate (serde) → generates TypeScript bindings via `ts-rs` |
| `server/`  | Rust hosting service (axum, SQLite, agent process supervisor) |
| `client/`  | Tauri 2 + React + Zustand desktop client |
| `e2e/`     | End-to-end harness: real server binary + WS clients + fake agent |
| `Makefile` | Unified build/test/run/deploy |
| `PLAN.md`  | Architecture + phased plan + progress |

## Architecture

```
┌──────────────────────────────┐         ┌────────────────────────────────────┐
│  Desktop client (Tauri/React)│         │  Hosting service (Rust / axum)       │
│                              │  WS/WSS  │                                      │
│  ConnectionPool              │◀────────▶│  /ws  ── sync loop ──┐               │
│   └ ConnectionManager (×N)   │  + REST  │                      ▼               │
│       • Hello + cursors      │          │   TaskManager ── broadcast bus       │
│       • heartbeat watchdog   │          │      │                               │
│       • backoff reconnect    │          │      ├─ AgentProc (spawn CLI) ─┐     │
│       • sleep/online detect  │          │      │    stdin/stdout JSONL   │     │
│  Zustand store               │          │      ▼                        ▼     │
│   • services (persisted)     │          │   SQLite Store          claude / …   │
│   • conversations (by seq)   │          │    • tasks              qodercli      │
│   • cursors (persisted)      │          │    • messages (seq)                  │
└──────────────────────────────┘         │    • delivery_cursors                │
                                          └────────────────────────────────────┘
```

- The **client** is a pure web app inside a thin Tauri shell; it talks WebSocket
  directly to each hosting service. All reconnect/liveness logic is in the
  frontend so it works identically in a browser or the desktop build.
- The **hosting service** owns durability. It assigns every message a monotonic
  per-task sequence number, persists it to SQLite *before* broadcasting, and
  tracks per-client delivery cursors so a reconnecting client is replayed only
  what it missed.

### Durability & gap-free replay (the core guarantee)

1. Each task has a monotonic `last_seq`. Appending a message allocates the next
   seq and inserts the row in **one transaction** (`UPDATE … RETURNING` + insert),
   so concurrent writers can never collide or leave gaps.
2. A message is **persisted before it is broadcast**. If the server crashes
   between persist and broadcast, the message is still replayable.
3. Every client keeps a **durable cursor** per task (`highest applied seq`),
   persisted locally (and mirrored server-side via `Ack`). On (re)connect the
   client sends `Hello { cursors }`; the server replays exactly the rows with
   `seq > cursor`, in order, then a `ReplayDone`.
4. The client **dedups by seq** in the store reducer — a replayed message at or
   below the cursor is ignored — so at-least-once delivery becomes
   exactly-once application. No loss, no duplicates, no gaps.
5. If the in-memory broadcast bus lags a slow consumer, the writer **resyncs
   from the store** instead of dropping messages.

### Reconnection & liveness (client)

- **Auto-reconnect** with exponential backoff + jitter, capped; **manual**
  `Reconnect now` per service.
- **Heartbeat**: periodic `Ping`; if no `Pong` within the deadline the link is
  declared dead and torn down → triggers reconnect. Also yields an RTT.
- **Network detection**: browser `online`/`offline` events suppress pointless
  retries while down and reconnect immediately on restore.
- **Sleep/resume detection**: a clock-drift watchdog — if wall-clock elapsed
  between ticks far exceeds the tick cadence, the process was suspended, so the
  (now-stale) socket is force-reconnected.

### Wire protocol

Types are defined once in Rust (`shared/`) and exported to TypeScript via `ts-rs`
(`client/src/protocol/`), so client and server can never drift.

- `ClientMsg`: `hello` · `create_task` · `user_input` · `terminate_task` ·
  `ack` · `ping`
- `ServerMsg`: `welcome` · `task_created` · `task_state` · `message` ·
  `replay_done` · `pong` · `error`

### Agent integration

Both `claude` and `qodercli` share one streaming contract:
`<bin> -p --input-format stream-json --output-format stream-json --verbose
--permission-mode <mode>`. The supervisor writes one JSON user turn per line to
stdin and parses one JSON event per line from stdout; non-JSON lines are wrapped
as `stdout` events so nothing is ever dropped. Adding a new CLI agent is one
registry entry in `server/src/agent.rs`.

## Prerequisites
- Rust (stable) + Cargo
- Node.js 20+ and npm
- A CLI agent to host: [`claude`](https://claude.com/claude-code) and/or `qodercli`
- Tauri prerequisites for your OS (see https://tauri.app) — only needed to run
  the desktop shell; the web client builds without them.

## Quick start
```bash
make setup                  # install Rust + client + e2e deps
make run-server             # start a hosting service on 127.0.0.1:8787
# in another terminal:
make run-client             # launch the desktop client (Tauri dev)
```
In the client: **+svc** → name it, URL `http://127.0.0.1:8787`, token
`dev-token` → **+task** → pick the service + agent tool → chat. Use the ↻ button
to reconnect a service, and **Terminate** to stop a task.

Prefer the browser during development? `cd client && npm run dev` serves the same
UI at http://localhost:5173.

## Configuration

Server (environment variables):

| Var | Default | Meaning |
|-----|---------|---------|
| `AGENT_MANAGE_ADDR` | `127.0.0.1:8787` | Listen address |
| `AGENT_MANAGE_TOKEN` | `dev-token` | Shared bearer token |
| `AGENT_MANAGE_DB` | `server/data/agent-manage.db` | SQLite path |
| `AGENT_MANAGE_NAME` | host name | Service display name |
| `AGENT_MANAGE_PERMISSION_MODE` | `default` | Passed to the agent's `--permission-mode` |

Auth: REST uses `Authorization: Bearer <token>`; the WebSocket uses
`?token=<token>` (webviews can't set custom WS headers). Use `wss://` behind a
TLS-terminating reverse proxy for remote hosts.

## Testing
```bash
make test          # fast: shared + server + client unit/integration tests
make test-e2e      # full stack: real server + WS clients + fake agent
make test-all      # test + test-e2e
make test-live     # live agent-CLI round-trip (needs claude/qodercli auth)
```
- **Server** integration tests drive a real axum server over `tokio-tungstenite`,
  asserting welcome/replay, cursor-scoped replay, live streaming, gap-free
  reconnect, and ping/pong.
- **Client** vitest tests exercise the connection manager with a mock socket and
  fake timers (handshake/ack, backoff, manual reconnect, heartbeat death/recovery,
  offline suppression, sleep-triggered reconnect) and the store dedup/cursor logic.
- **End-to-end** (`e2e/`) spawns the real server binary supervising a fake agent
  on `PATH`, connects real WebSocket clients, and proves the crown-jewel
  guarantee: after a disconnect a reconnecting client is replayed *exactly* the
  messages it missed — gap-free, no loss, no duplicates.

## Build & package
```bash
make build             # build server (release) + client (with fresh TS bindings)
make deploy-server     # stage the server binary in ./dist
make package-client    # Tauri desktop bundles
```

## Design rationale
- **WebSocket over polling/SSE**: bidirectional (user turns up, agent events
  down) on one persistent connection with natural backpressure.
- **SQLite over in-memory**: durability across restarts is what makes gap-free
  replay real; a single-file DB keeps hosts self-contained and easy to deploy.
- **Client-owned reconnection**: the client is the only party that knows its own
  network/power state, so liveness detection and cursors live there; the server
  stays a simple, replayable log.
- **Rust-first protocol via ts-rs**: one source of truth eliminates client/server
  schema drift by construction.

## License
MIT
