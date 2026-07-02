# Agent-Manage — Planning Document

Cross-host, multi-agent management tool: a desktop **client** (Tauri 2 + React +
Zustand) that connects to one or more **hosting services** (Rust) which each run
and supervise multiple CLI-based agent tasks (Claude Code, Qoder CLI, …).

This document is the single source of truth for scope, architecture, and
progress. It is updated at the end of every phase.

---

## 1. Goals & Requirements (from spec)

1. **Client** (Tauri 2 + React + Zustand)
   - Connect to one or more hosting services (dynamically add at runtime).
   - Create / terminate / monitor tasks; each task = one independent conversation.
   - Sidebar conversation list + main conversation panel.
   - On registration, open a persistent long-lived connection (WebSocket).
   - Auto-reconnect at configurable intervals + manual reconnect trigger.
   - Detect network interruption **and** system resume-from-sleep.
   - No message loss across reconnects (dedup + gap-free replay).
2. **Hosting service** (Rust)
   - Instantiate & manage concrete agent tasks; each isolated context.
   - Delegate execution to CLI agents via continuous stdin/stdout streams.
   - Persistently track which messages were delivered to the client; on
     reconnect immediately replay undelivered messages.
3. **Deliverables**
   - Comprehensive `Makefile` (build/test/run/deploy).
   - Detailed `README.md` (architecture, setup, usage, rationale).
   - Idiomatic repo layout (`/client`, `/server`, `/shared`).
   - Atomic conventional-commit history.

### Locked design decisions
| Concern      | Decision                          | Rationale |
|--------------|-----------------------------------|-----------|
| Transport    | **WebSocket** (axum)              | Full-duplex, single conn, clean streaming + resume |
| Persistence  | **SQLite** (sqlx)                 | Durable message log + delivery cursor across restarts |
| Auth         | **Shared bearer token** per service | Simple, protects endpoints for self-hosted use |
| Sequencing   | **Vertical slice first, then deepen every requirement** | Early demo, low integration risk |

---

## 2. Architecture

```
┌──────────────────────────── Client (Tauri 2) ────────────────────────────┐
│  React UI (sidebar + conversation panel + dialogs)                        │
│  Zustand stores: services / tasks / messages / connection                 │
│  ConnectionManager (per service): WS, heartbeat watchdog, auto/manual     │
│    reconnect, online/offline + sleep detection, seq-based dedup + ack     │
└───────────────▲───────────────────────────────────────────────▲──────────┘
                │ WSS (bearer token)                              │
        ┌───────┴────────┐                              ┌─────────┴────────┐
        │ Hosting svc A  │                              │  Hosting svc B   │
        │ (Rust / axum)  │                              │  (Rust / axum)   │
        │  ┌───────────┐ │                              │      …           │
        │  │TaskManager│ │                              └──────────────────┘
        │  │ ┌───────┐ │ │
        │  │ │Task 1 │ │ │  each Task = child process:
        │  │ │Task 2 │ │ │  `claude -p --input-format stream-json
        │  │ └───────┘ │ │             --output-format stream-json --verbose`
        │  └───────────┘ │  stdin(JSONL)  ── user turns
        │  SQLite store  │  stdout(JSONL) ── agent events → seq'd, persisted
        └────────────────┘
```

### Message durability & replay model
- Every event produced for a task gets a **monotonic per-task `seq`** and is
  written to SQLite (`messages`) *before* being pushed on the wire.
- The client acks the highest `seq` it has durably applied per task.
- Server persists a **delivery cursor** per (client_id, task_id) in SQLite.
- On (re)connect the client sends `hello { cursors: {task_id: last_seq} }`;
  server replays every `message` with `seq > last_seq`, in order, then resumes
  live streaming. Because seq is monotonic and the client dedups by seq, this is
  gap-free and idempotent even if some acks were lost.
- `client_id` is generated once on the client and persisted, so cursors survive
  app restarts and server restarts.

### Reconnection & liveness (client)
- Configurable base interval + exponential backoff + jitter; manual "reconnect
  now" resets backoff.
- App-level heartbeat: `ping` every N s, expect `pong`; missed → force reconnect.
- **Sleep/resume detection**: a monotonic timer watchdog — if wall-clock gap
  between ticks ≫ expected, the machine slept; proactively validate/reconnect.
- Browser `online`/`offline` + `visibilitychange` events also trigger checks.

---

## 3. Repository layout

```
agent-manage/
├── PLAN.md            # this file
├── README.md
├── Makefile
├── Cargo.toml         # Rust workspace: shared + server
├── .gitignore
├── shared/            # protocol crate (serde) + ts-rs → client TS bindings
│   ├── Cargo.toml
│   └── src/lib.rs
├── server/
│   ├── Cargo.toml
│   ├── migrations/    # sqlx SQLite migrations
│   └── src/{main,config,auth,state,http,ws,store,task,agent,protocol_ext}.rs
└── client/
    ├── package.json
    ├── vite.config.ts
    ├── index.html
    ├── src/            # React + Zustand + connection manager
    └── src-tauri/      # Tauri 2 shell
```

---

## 4. Agent CLI integration (validated)

Both `claude` and `qodercli` expose an identical streaming contract:

```
<cli> -p --input-format stream-json --output-format stream-json --verbose
```

- **stdin**: JSONL, one user turn per line:
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`
- **stdout**: JSONL event stream — `system`(init), `assistant`, `tool_use`,
  `tool_result`, `result`, etc. We treat each stdout line as an opaque
  structured `agent_event` (parsed as JSON, stored raw + typed).
- `--include-partial-messages` optionally streams token deltas.
- Adapter abstraction: `AgentAdapter` trait → `argv()` + parse hooks; registry
  keyed by tool id (`claude`, `qodercli`). New CLIs = new adapter.

---

## 5. Wire protocol (`shared`)

Client→Server: `Hello{client_id,cursors}`, `CreateTask`, `TerminateTask`,
`UserInput{task_id,text}`, `Ack{task_id,seq}`, `Ping`.
Server→Client: `Welcome{service_info}`, `TaskCreated`, `TaskState`,
`Message{task_id,seq,event}`, `ReplayDone{task_id}`, `Pong`, `Error`.
All tagged-union JSON via serde `#[serde(tag="type")]`; TS types generated by
`ts-rs` into `client/src/protocol/`.

---

## 6. Phase plan & progress

Legend: ⬜ todo · 🟨 in progress · ✅ done

- ✅ **P0 — Planning + scaffold**: PLAN.md, layout, workspace, Makefile/README
  skeleton, .gitignore. *Test:* `cargo metadata` resolves; tree correct.
- ✅ **P1 — Shared protocol**: serde tagged unions (`ClientMsg`/`ServerMsg`) +
  `AgentEvent`/`TaskInfo`/`ServiceInfo`; ts-rs exports to `client/src/protocol/`
  (base dir via `TS_RS_EXPORT_DIR`, seq/millis annotated `number`). *Test:* 11
  passing crate tests (serde round-trips + binding export). ✅
- ✅ **P2 — Server core**: axum router, bearer-auth middleware + `token_valid`,
  `/health` + `/api/info` + task CRUD, SQLite `Store` (tasks/messages/cursors,
  atomic seq via `RETURNING`), `TaskManager`, tool discovery. *Test:* 4 store
  unit tests (seq monotonic, replay window, cursor no-regress, CRUD) + live curl
  smoke (401/info/create/400/list). ✅
- ✅ **P3 — Agent adapter**: `agent.rs` argv builder + JSONL codec
  (`parse_line`/`user_turn_json`/text projection); `agent_proc.rs` supervisor
  (4 tasks: stdout/stderr readers, stdin writer, waiter/killer). Fixed a
  handle-drop-vs-terminate bug (channel close must not kill). *Test:* 5 codec
  unit tests + fake-agent stream/exit test + **live claude round-trip**
  (system→assistant("pong")→result→exit0). ✅
- ✅ **P4 — Server WS**: `ws.rs` sync loop (Hello handshake, Welcome, per-task
  replay of `seq > cursor`, live broadcast fan-out, Ping/Pong, Ack→cursor,
  create/input/terminate), durable delivery cursors, broadcast Lagged→resync via
  store replay from `last_sent`. *Test:* 5 integration tests over a real
  tokio-tungstenite client + in-process axum server — full replay, cursor-scoped
  replay, live streaming, gap-free reconnect (drop→inject→reconnect replays only
  missed seqs), ping/pong. 15 server tests green. ✅
- ✅ **P5 — Client scaffold**: Vite+React+TS+Zustand app with a persisted store
  (services + reconnect cursors) and a pure `applyServerMsg` reducer (dedup by
  seq, cursor advance); two-pane layout (service/conversation sidebar + streaming
  panel); Tauri 2 shell (`src-tauri`, capabilities, icons). *Test:* `npm run
  build` (tsc + vite) green; dev server boots (HTTP 200). ✅
- ⬜ **P6 — Client connection mgr**: reconnect/backoff, heartbeat, sleep/online
  detection, dedup/ack. *Test:* vitest unit tests w/ mock socket + fake timers.
- ⬜ **P7 — Client UI**: add-service, create-task, sidebar, conversation panel,
  terminate/monitor, reconnect controls. *Test:* manual UI pass + component tests.
- ⬜ **P8 — E2E + docs**: full flow incl. reconnect replay; finalize README +
  Makefile. *Test:* scripted E2E; `make test` green.

Each phase ends with an atomic conventional commit and a PLAN.md update.

---

## 7. Testing strategy
- **Rust unit**: store (seq monotonicity, cursor advance, replay window), auth,
  protocol serde round-trips.
- **Rust integration**: spawn server on ephemeral port, drive WS client, assert
  replay/dedup and heartbeat behavior; agent adapter against real CLI (gated by
  env so CI without creds still passes).
- **TS unit (vitest)**: connection manager reconnect/backoff/sleep with fake
  timers + mock WebSocket; store reducers/dedup.
- **Manual**: UI flows, kill network / sleep laptop, observe reconnection.

## 8. Risks
- CLI auth/cost in tests → gate live agent tests behind `AGENT_LIVE=1`.
- Sleep detection is heuristic → combine watchdog + heartbeat + online events.
- Backpressure on fast agents → bounded channels, drop-to-disk via SQLite log.
