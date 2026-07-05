# Switchboard

Cross-host, multi-agent management tool. A desktop **client** connects to one or
more **hosting services**; each hosting service runs and supervises multiple
CLI-based agent tasks (Claude Code, Qoder CLI, or any compatible CLI agent).
Each task is an independent conversation with its own isolated context.

## Highlights
- **One client, many hosts, many tasks.** Add hosting services at runtime; run
  many concurrent agent conversations per host.
- **Real interactive terminals.** Each task is a CLI agent running on a
  server-side PTY; the client renders it with xterm.js and answers prompts
  (trust dialogs, permission y/N) live.
- **Hybrid transport** over one persistent WebSocket: a JSON control plane
  (typed `ClientMsg`/`ServerMsg`) alongside a binary terminal data plane.
- **No output loss.** Terminal bytes are sequenced and persisted server-side; a
  reconnecting client is fast-forwarded exactly the bytes it missed, or handed a
  screen snapshot when the backlog is large.
- **Resilient client.** Exponential-backoff auto-reconnect + manual trigger;
  detects network drops *and* system resume-from-sleep; heartbeat watchdog.

## Repository layout
| Path       | What |
|------------|------|
| `shared/`  | Rust protocol crate: serde control-plane types (→ TS via `ts-rs`) + the binary frame codec |
| `server/`  | Rust hosting service (axum, SQLite, PTY supervisor + vt100 emulator) |
| `client/`  | Tauri 2 + React + Zustand desktop client with xterm.js terminals |
| `e2e/`     | End-to-end harness: real server binary + WS clients + fake PTY agent |
| `Makefile` | Unified build/test/run/deploy |
| `PLAN.md` / `PTY-SPEC.md` | Architecture, phased plan, progress, and the v2 PTY design |

## Architecture

```
┌──────────────────────────────┐         ┌────────────────────────────────────┐
│  Desktop client (Tauri/React)│         │  Hosting service (Rust / axum)       │
│                              │  WS/WSS  │                                      │
│  ConnectionPool              │◀────────▶│  /ws ── control + data planes ─┐     │
│   └ ConnectionManager (×N)   │  + REST  │                      ▼         │     │
│       • Hello + cursors      │          │   TaskManager ── broadcast bus │     │
│       • heartbeat watchdog   │  JSON ctl│      │                         │     │
│       • backoff reconnect    │  + binary│      ├─ PtyProc (spawn CLI) ───┤     │
│       • sleep/online detect  │  frames  │      │    PTY master r/w       │     │
│  xterm.js terminals (×N)     │          │      ├─ vt100 emulator         ▼     │
│  Zustand store               │          │      ▼                  claude / …   │
│   • services (persisted)     │          │   SQLite Store          qodercli     │
│   • cursors (persisted)      │          │    • tasks · pty_chunks (seq)        │
└──────────────────────────────┘         └────────────────────────────────────┘
```

- The **client** is a pure web app inside a thin Tauri shell; it talks WebSocket
  directly to each hosting service. All reconnect/liveness logic is in the
  frontend so it works identically in a browser or the desktop build. Each task
  is an xterm.js `Terminal` kept in a registry outside React, so switching the
  selected conversation never loses scrollback.
- The **hosting service** owns durability. Every PTY output chunk gets a
  monotonic per-task sequence number, is persisted to SQLite *before*
  broadcasting, and is also fed to a server-side vt100 emulator that can redraw
  the current screen on demand.

### Durability & gap-free replay (the core guarantee)

1. Each task has a monotonic `last_seq`. Appending a PTY chunk allocates the next
   seq and inserts the row in **one transaction** (`UPDATE … RETURNING` + insert),
   so concurrent writers can never collide or leave gaps.
2. A chunk is **persisted before it is broadcast**, and only then fed to the
   emulator. If the server crashes between persist and broadcast, it is still
   replayable.
3. Every client keeps a **durable cursor** per task (`highest applied chunk
   seq`), persisted locally. On (re)connect it sends `Hello { cursors }`; per
   task the server either **byte fast-forwards** the chunks with `seq > cursor`
   in order, or — when the backlog exceeds a threshold — sends a single **screen
   snapshot** (the emulator's `contents_formatted()`) at the tail seq. Either way
   it finishes with a `ReplayDone`.
4. Live delivery **dedups by seq**, so a client that just replayed never double-
   applies an in-flight chunk. No loss, no duplicates, no gaps.
5. The `INPUT` data-plane frame carries raw keystrokes straight to the PTY;
   `Resize` (control plane) keeps the PTY's window size in sync with xterm.

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

The **control plane** is JSON: types are defined once in Rust (`shared/`) and
exported to TypeScript via `ts-rs` (`client/src/protocol/`), so client and server
can never drift.

- `ClientMsg`: `hello` · `create_task` (with `cols`/`rows`) · `resize` ·
  `terminate_task` · `delete_task` · `ack` · `ping`
- `ServerMsg`: `welcome` · `task_created` · `task_state` · `task_deleted` ·
  `replay_done` · `pong` · `error`

`terminate_task` stops a task's process but keeps its history (so it can still be
replayed); `delete_task` terminates it *and* removes the task plus all its
persisted terminal chunks and delivery cursors from the host, then broadcasts
`task_deleted` so every client drops it.

The **data plane** is binary (`shared/src/frame.rs`, mirrored in
`client/src/net/frame.ts`, round-trip tested on both sides). Frames are
big-endian with a 16-byte raw-UUID task id:

| Frame | Layout | Direction |
|-------|--------|-----------|
| `OUTPUT` | `[0x01][task_id:16][seq:u64][data]` | server → client |
| `SNAPSHOT` | `[0x02][task_id:16][seq:u64][data]` | server → client |
| `INPUT` | `[0x10][task_id:16][data]` | client → server |

### Agent integration

In PTY mode each tool runs as an ordinary interactive terminal program (no `-p`,
no stream-json) on a server-side pseudo-terminal; the PTY *is* the integration
surface, so the agent answers its own trust/permission prompts live. The
supervisor (`server/src/pty_proc.rs`) bridges the synchronous `portable-pty`
master to tokio, and a vt100 emulator (`server/src/terminal.rs`) tracks the
screen for snapshots. Adding a new CLI agent is one registry entry in
`server/src/agent.rs`.

## Prerequisites
- Rust (stable) + Cargo
- Node.js 20+ and npm
- A CLI agent to host: [`claude`](https://claude.com/claude-code) and/or `qodercli`
- Tauri prerequisites for your OS (see https://tauri.app) — only needed to run
  the desktop shell; the web client builds without them.

## Quick start

The server speaks **HTTPS by default — even on localhost** — generating a
self-signed certificate on first run. The desktop client routes its networking
through its native (Rust) layer, which **accepts self-signed certs**, so there
is no certificate to install or trust: just point the client at the host.

```bash
make setup                  # install Rust + client + e2e deps
make run-server             # start a hosting service (https) on 127.0.0.1:8787
# in another terminal:
make run-client             # launch the desktop client (Tauri dev)
```

In the client: **+svc** → name it, leave the protocol on **https**, host
`127.0.0.1` (the port defaults to `8787`), token `dev-token` → **+task** → pick
the service + agent tool → **Create**. Click the task to open its live terminal
and type straight into the agent. Use the ↻ button to reconnect a service, and
**Terminate** to stop a task.

### Connecting to a remote host

Bind all interfaces and choose a strong token:

```bash
SWITCHBOARD_ADDR=0.0.0.0:8787 \
SWITCHBOARD_TOKEN='choose-a-strong-token' \
  cargo run -p switchboard-server --release
```

In the client, add the service with the host's IP/hostname and that token — no
cert step needed. Ensure the host firewall / cloud security group allows inbound
TCP on the port.

> **Security note:** accepting self-signed certs keeps traffic encrypted but not
> authenticated, so it does not protect against an active man-in-the-middle. For
> untrusted networks, front the server with a reverse proxy holding a real CA
> certificate (set `SWITCHBOARD_TLS=0` and terminate TLS there).

Prefer the browser during development? `cd client && npm run dev` serves the same
UI at http://localhost:5173. The browser build uses the webview's own
fetch/WebSocket (not the native bridge), so it can't accept a self-signed cert —
run the server with `SWITCHBOARD_TLS=0` and select the **http** protocol in the
dialog, or trust the generated `server/data/switchboard-cert.pem` in your OS
keychain.

## Configuration

Server (environment variables):

| Var | Default | Meaning |
|-----|---------|---------|
| `SWITCHBOARD_ADDR` | `127.0.0.1:8787` | Listen address |
| `SWITCHBOARD_TOKEN` | `dev-token` | Shared bearer token |
| `SWITCHBOARD_DB` | `server/data/switchboard.db` | SQLite path |
| `SWITCHBOARD_NAME` | host name | Service display name |
| `SWITCHBOARD_PERMISSION_MODE` | `default` | Passed to the agent's `--permission-mode` |
| `SWITCHBOARD_TLS` | `1` (on) | HTTPS/WSS; set `0` to serve plain HTTP |
| `SWITCHBOARD_TLS_CERT` | `server/data/switchboard-cert.pem` | PEM cert path (auto-generated if missing) |
| `SWITCHBOARD_TLS_KEY` | `server/data/switchboard-key.pem` | PEM key path (auto-generated if missing) |
| `SWITCHBOARD_TLS_SAN` | — | Extra SANs (comma-separated IPs/hostnames) for the generated cert |

Auth: REST uses `Authorization: Bearer <token>`; the WebSocket uses
`?token=<token>` (webviews can't set custom WS headers).

TLS: HTTPS is on by default. When the cert/key files are absent the server
generates a self-signed certificate (ECDSA P-256, ~13-month validity); the
`SWITCHBOARD_TLS_SAN` entries (plus `localhost` and local interface addresses)
become its SANs, which matters only if you later trust it in a browser. The
desktop client accepts self-signed certs directly, so no trust step is needed
there. To terminate TLS yourself (reverse proxy, real CA cert), set
`SWITCHBOARD_TLS=0` and run the proxy in front.

Networking: the desktop client performs REST and WebSocket I/O in its native
(Rust) layer rather than the webview, so it can reach hosts with self-signed
certificates that the webview's fetch/WebSocket would reject. Certificate
validation is intentionally disabled for this self-signed use case.

## Testing
```bash
make test          # fast: shared + server + client unit/integration tests
make test-e2e      # full stack: real server + WS clients + fake PTY agent
make test-web      # browser E2E (Playwright): live server + Vite + xterm terminal
make test-all      # test + test-e2e + test-web
make test-live     # live agent-CLI round-trip (needs claude/qodercli auth)
```
- **Server** integration tests drive a real axum server over `tokio-tungstenite`,
  asserting welcome, full/cursor-scoped byte replay, live streaming, gap-free
  reconnect, snapshot-on-large-backlog, multi-viewer convergence, and ping/pong;
  the PTY supervisor and vt100 emulator have their own unit tests.
- **Client** vitest tests exercise the connection manager with a mock socket and
  fake timers (handshake, binary transport, backoff, manual reconnect, heartbeat
  death/recovery, offline suppression, sleep-triggered reconnect), the store
  cursor logic, and the binary frame codec round-trip.
- **End-to-end** (`e2e/`) spawns the real server binary supervising a fake PTY
  agent on `PATH`, connects real WebSocket clients, and proves the crown-jewel
  guarantee: after a disconnect a reconnecting client is fast-forwarded *exactly*
  the terminal bytes it missed — gap-free, no loss, no duplicates.
- **Browser E2E** (`client/tests-e2e/`, Playwright) boots the real server + the
  Vite dev app and drives a live xterm.js terminal: renders PTY output, types
  input, and verifies the display survives a forced reconnect.

## Build & package
```bash
make build             # build server (release) + client (with fresh TS bindings)
make deploy-server     # stage the server binary in ./dist
make package-client    # Tauri desktop bundles
```

## Design rationale
- **PTY over stream-json**: running each agent as a real interactive terminal
  means new CLIs work with zero adapter code and users answer trust/permission
  prompts exactly as they would locally.
- **Hybrid transport**: raw terminal bytes ride a compact binary data plane while
  structured events stay typed JSON — one socket, no base64 bloat, no drift.
- **WebSocket over polling/SSE**: bidirectional (keystrokes up, terminal output
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
