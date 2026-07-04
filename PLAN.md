# Switchboard — Planning Document

Cross-host, multi-agent management tool: a desktop **client** (Tauri 2 + React +
Zustand) that connects to one or more **hosting services** (Rust) which each run
and supervise multiple CLI-based agent tasks (Claude Code, Qoder CLI, …).

This document is the single source of truth for scope, architecture, and
progress. It is updated at the end of every phase.

> **v2 pivot (P9): PTY mode.** After P8 the integration surface moved from the
> stream-json contract to a real **pseudo-terminal** per task: every agent runs
> as an ordinary interactive CLI on a server-side PTY, the client renders it with
> xterm.js, and transport became **hybrid** (JSON control plane + a binary
> terminal data plane). Durability shifted from per-message rows to sequenced
> **PTY output chunks** plus a server-side vt100 emulator for snapshots. The full
> v2 design lives in **`PTY-SPEC.md`**; sections 2/4/5 below describe the
> superseded v1 stream-json model and are kept for history. See §6 P9 for the
> current state.

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
switchboard/
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
- ✅ **P6 — Client connection mgr**: `net/connection.ts` per-service manager —
  Hello handshake with fresh cursors on every (re)connect, Ping/Pong heartbeat
  watchdog, exponential-backoff auto-reconnect + manual `reconnectNow`, network
  online/offline handling, and resume-from-sleep detection via a clock-drift
  watchdog; acks each message. `net/pool.ts` wires managers to the store +
  browser events. Dedup/cursor-advance in the store reducer. *Test:* 16 vitest
  tests (mock socket + fake timers): handshake/ack, backoff growth, manual
  reconnect, heartbeat death/recovery, offline-suppression, sleep force-reconnect,
  and store dedup/cursor-scoping. ✅
- ✅ **P7 — Client UI**: add-service dialog, new-task dialog (pick service +
  agent tool from the service's reported tools, cwd, first message), sidebar with
  per-service status dot / reconnect / remove and a live conversation list, and a
  conversation panel with streaming, an Enter-to-send composer, and terminate.
  Pool wired into the app lifecycle. *Test:* `npm run build` (tsc + vite) green;
  16 vitest tests green; dev boot 200. Interactive click-through deferred to the
  P8 end-to-end (no GUI browser in this env). ✅
- ✅ **P8 — E2E + docs**: `e2e/` harness spawns the real server binary
  supervising a deterministic fake agent on `PATH`, drives real WebSocket
  clients through create→stream→drop→reconnect→terminate, and asserts the
  reconnect replays *exactly* the missed seqs (gap-free, no loss, no dupes).
  Makefile gains `setup-e2e`/`test-e2e`/`test-all`; README expanded with
  architecture, durability/replay model, reconnection/liveness, protocol, agent
  integration, config, testing, and rationale. *Test:* `make test` green
  (shared 11 + server 15 + client 16) and `make test-e2e` green. ✅

### v2 — PTY mode (see `PTY-SPEC.md`)

- ✅ **P9.1 — Spec + frame codec**: `PTY-SPEC.md`; binary `Frame` codec
  (`OUTPUT`/`SNAPSHOT`/`INPUT`) in `shared/src/frame.rs` with a byte-for-byte TS
  mirror in `client/src/net/frame.ts`. *Test:* Rust + vitest round-trip tests. ✅
- ✅ **P9.2 — PTY supervisor**: `server/src/pty_proc.rs` bridges the synchronous
  `portable-pty` master to tokio via dedicated std threads (reader/writer/waiter,
  resize, kill; channel-close must not kill); `server/src/terminal.rs` wraps a
  `vt100` parser (`process`/`resize`/`snapshot`/`contents`). *Test:* PTY spawn +
  echo/resize/exit-code tests and emulator unit tests. ✅
- ✅ **P9.3 — Server data plane**: dropped stream-json; `store.rs` gains
  `pty_chunks` (atomic seq via `RETURNING`) + `chunks_after`; `TaskManager`
  spawns PTYs, feeds an emulator, and broadcasts an `Outbound` bus (control +
  Pty); `ws.rs` handshake replays via **byte fast-forward** or a **snapshot** when
  the backlog exceeds `SNAPSHOT_THRESHOLD`, decodes `INPUT` frames to the PTY, and
  handles `Resize`. *Test:* rewritten `ws_test.rs` — full/cursor-scoped replay,
  live streaming, gap-free reconnect, snapshot-on-large-backlog, multi-viewer,
  ping/pong (server 19 + shared 19 green). ✅
- ✅ **P9.4 — Client terminal**: xterm.js terminals in a registry outside React
  (`net/terminals.ts`) so scrollback survives task switches; `TerminalView`
  re-parents the persistent element; `connection.ts` gains binary transport
  (`binaryType`, text/binary branch, `sendBytes`); `pool.ts` decodes frames →
  writes terminal + advances cursor, and routes keystrokes/resizes back; store
  drops the message log, keeping task metadata + durable cursors. *Test:* `tsc`
  + `vite build` green; 29 vitest tests (incl. binary transport + cursor). ✅
- ✅ **P9.5 — E2E + Playwright + docs**: `e2e/` fake agent is now an interactive
  PTY program; `e2e.mjs` speaks the binary plane and proves gap-free byte
  fast-forward on reconnect. Playwright suite (`client/tests-e2e/`) boots the real
  server + Vite and drives a live xterm terminal (render/type/reconnect). Makefile
  gains `test-web`; README + PLAN updated for PTY mode. *Test:* `make test-e2e`
  green and `npm run test:e2e` (2 Playwright tests) green. ✅

### v2 — fixes & polish

- ✅ **P10 — Task deletion + durable persistence**: `delete_task` (protocol +
  server process-kill + transactional DB cleanup of chunks/cursors + broadcast
  `task_deleted`; client drops the conversation and disposes its terminal);
  inline two-click "Sure?" confirm (`ConfirmButton`) for service removal and
  task delete; and a durable persist backend (`store/storage.ts`) using
  `tauri-plugin-store` (fsync per write, localStorage fallback in-browser) so
  removed services no longer reappear after an abrupt webview shutdown.
  *Test:* server 21 + client 32 + shared 19 green; Tauri crate `cargo check`. ✅

- ✅ **P11 — Fix "deleted service reappears on reload"**: the durable backend in
  P10 did not resolve the report. Root cause was a synchronous recursion, not a
  storage flush: removing a service notified the store subscriber, which called
  `mgr.stop()`; its `onStatus("offline")` wrote back to the store and re-entered
  the same subscriber while the manager was still mapped, so it stopped again —
  recursing until the stack overflowed and aborting the `removeService` reducer
  *before* the persist middleware wrote. Fix: delete the manager from the pool
  map before stopping it (`net/pool.ts`), breaking the re-entrant loop.
  *Test:* Playwright regression (`persistence.spec.ts`: delete survives reload)
  + persist round-trip unit test (`store/persist.test.ts`); client 33 + e2e 3
  green, `tsc` + build clean. ✅
- ✅ **P12 — Free-text agent command + server folder picker**: the New Task
  dialog no longer limits the agent tool to a hard-coded dropdown. The tool
  field is now a combobox (`<input list=…>` + `<datalist>`) whose suggestions are
  the 5 most-recently-used commands for that service (persisted per-service in
  the store), followed by any installed known tools. Any command on the host's
  PATH is accepted — `bash` included; a command with args is split on whitespace
  (first token resolved via `which`, rest passed as argv, no shell quoting).
  Server: `agent::resolve_command` maps the free-text string to a spawnable
  `{bin, argv}` (or a `BadRequest` naming the missing command), `pty_proc`
  spawns arbitrary `bin+argv`, and a new bearer-authed `GET /api/fs?path=`
  (`fs::list_dir`, DTOs `FsListing`/`FsEntry` in `shared`) lists the host's real
  directory tree from `/`. Client: a **Browse…** button opens a `FolderPicker`
  modal that navigates the *server's* filesystem over REST (`net/rest.ts`) and
  writes the chosen path into Working dir. Create failures surface inline via the
  previously-ignored `ServerMsg::Error{code:"create_failed"}`; the dialog stays
  open on failure and closes only once the new conversation appears.
  *Test:* server `resolve_command`/`list_dir` unit tests (server 28 green),
  shared bindings regen (21 green), store `addRecentTool`/`create_failed` unit
  tests (vitest 37 green), Playwright e2e (`new-task.spec.ts`: folder-picker
  happy path + inline not-found error; suite 5 green), `tsc` + build clean. ✅
- ✅ **P13 — Fix "terminal screen blank/garbled after client reopen"**: reopening
  the client recovered the service and task list, but each task's terminal came
  back empty or garbled. Root cause: the client persisted per-task replay cursors
  to localStorage while the xterm buffer itself lives only in memory and dies on
  reload. On a fresh start the stale cursor (at/near the task's latest seq) told
  the server the client was caught up, so `replay()` byte-fast-forwarded nothing
  (→ blank) or a mid-stream slice of ANSI escapes onto an empty screen
  (→ garbled). Fix: stop persisting `cursors` (dropped from the store's
  `partialize`); they are now in-memory only, matching the terminal's own
  lifetime. A reopen starts at cursor 0, so the server reconstructs each screen
  via snapshot (established tasks) or full byte replay (small ones). Cursors
  still advance in-memory, so in-session reconnects stay redundant-free.
  *Test:* Playwright reload-recovery e2e (`terminal.spec.ts`: type output →
  full page reload → screen restored) — verified RED before the fix (blank
  `.xterm-rows`) and GREEN after; the suite's `beforeEach` now seeds localStorage
  only when absent so reloads observe real persisted state. Store unit test
  asserts cursors are excluded from the persisted snapshot (vitest 38 green),
  e2e suite 6 green, `tsc` + build clean. ✅

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
