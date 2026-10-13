# Switchboard — Architecture

How the pieces fit together and why: the client/host/`pty-host` split, the
durability model behind gap-free replay, the control and data planes, `SWB-v1`
transport security, repeater mode, and self-upgrade.

## Components

- The **client** is a pure web app inside a thin Tauri shell; it talks WebSocket
  directly to each hosting service. All reconnect/liveness logic is in the
  frontend so it works identically in a browser or the desktop build. Each task
  is an xterm.js `Terminal` kept in a registry outside React, so switching the
  selected conversation never loses scrollback.
- The **hosting service** owns durability. Every PTY output chunk gets a
  monotonic per-task sequence number, is persisted to SQLite *before*
  broadcasting, and is also fed to a server-side vt100 emulator that can redraw
  the current screen on demand.
- Each task's PTY and agent live in a **separate `pty-host` process**, spawned
  detached, which the server drives over a local socket (unix socket / named
  pipe). So the server holds no OS resource belonging to a task and can be
  replaced — for a self-upgrade, a crash, a service restart — without killing
  anything: the new process re-attaches and resumes each byte stream at the
  offset the old one had persisted. See [Self-upgrade](#self-upgrade).

## Durability & gap-free replay (the core guarantee)

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

## Reconnection & liveness (client)

- **Auto-reconnect** with exponential backoff + jitter, capped; **manual**
  `Reconnect now` per service.
- **Heartbeat**: periodic `Ping`; if no `Pong` within the deadline the link is
  declared dead and torn down → triggers reconnect. Also yields an RTT.
- **Network detection**: browser `online`/`offline` events suppress pointless
  retries while down and reconnect immediately on restore.
- **Sleep/resume detection**: a clock-drift watchdog — if wall-clock elapsed
  between ticks far exceeds the tick cadence, the process was suspended, so the
  (now-stale) socket is force-reconnected.

## Wire protocol

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

## Transport security (`SWB-v1`)

Every leg (client↔worker, client↔repeater, repeater↔worker) resists an **active
on-path attacker** who can sniff, modify, drop, inject, or attempt to terminate
TLS. Two independent layers, both required (`shared/src/auth.rs`, shared verbatim
by server and the client's Rust bridge so the two can't drift):

1. **Authenticated channel — cert pinning.** The connecting side pins the
   listener's leaf cert by `SHA-256(leaf_DER)` and hard-fails on mismatch
   (hostname ignored, so self-signed just works). The client captures the pin on
   first add (**trust-on-first-use**, during the `/api/info` probe) and enforces it
   on every connection thereafter; a worker dialing a repeater pins the PEM at
   `SWITCHBOARD_REPEATER_CA`.
2. **Channel-bound challenge-response — the token is never on the wire.** The
   shared token appears in no header, URL, or frame. Instead the client proves
   knowledge with `HMAC-SHA256` over a server nonce and the channel's cert
   fingerprint (`cb`), so a captured proof can't be replayed (per-connection nonce)
   or relayed onto a different TLS channel (a MITM's channel has a different `cb`).
   - **WS / tunnel** (one handshake per connection): server sends
     `AuthChallenge { server_nonce }`; client replies `AuthResponse { client_nonce,
     mac }` with `mac = HMAC(token, "SWB-WS-v1" ‖ server_nonce ‖ client_nonce ‖ cb)`.
   - **REST** (stateless, per request): each `/api/*` request carries `X-Swb-Ts`,
     `X-Swb-Nonce`, `X-Swb-Mac`, where the MAC also covers the method, path+query,
     and `SHA-256(body)`. The server enforces a ±30 s clock-skew window plus a
     single-use nonce cache.

Domain-separation tags (`SWB-WS-v1` / `SWB-REST-v1`) prevent cross-context MAC
reuse; every MAC input is length-prefixed so no field can be confused for another.
The server logs its leaf-cert fingerprint on startup so an operator can convey it
out-of-band for the client's first-use pin.

## Repeater mode (no stable IP required)

For a worker host **without** a stable, client-reachable IP, a **repeater** with a
stable IP sits in the middle. Both the worker and the client dial *out* to it:

```
 client ──REST/WS──▶ repeater :SWITCHBOARD_ADDR        repeater :SWITCHBOARD_REPEATER_ADDR ◀──wss── worker (dials out)
                     (validates SWITCHBOARD_TOKEN)       (validates SWITCHBOARD_REPEATER_TOKEN)     │ runs TaskManager/PTYs
                              └──────── one multiplexed reverse tunnel (single WS) ─────────────────┘   locally
```

- **One binary, three roles**, selected by env: **worker-direct** (today's
  default — binds `SWITCHBOARD_ADDR`, runs PTYs), **repeater**
  (`SWITCHBOARD_MODE=repeater` — binds a client-facing and a worker-facing HTTPS
  listener, runs nothing), and **worker-repeater-client** (a worker with no
  `SWITCHBOARD_ADDR`/`SWITCHBOARD_TOKEN` but a `SWITCHBOARD_REPEATER_*` target —
  dials out and serves all client traffic through the tunnel).
- **Transparent by construction.** The repeater forwards **opaque application
  bytes** over a single WebSocket, multiplexing every client interaction by a
  `u64` stream id (`shared/src/tunnel.rs`). It never parses API semantics, so any
  new REST route or `ClientMsg`/`ServerMsg` variant works with no repeater change.
  `/health` is answered locally (reports paired/unpaired) so liveness works with no
  worker.
- **Auth terminated per hop.** The repeater validates the client's `SWB-v1` proof
  at ingress (its own cert is the `cb`) and authenticates the worker tunnel with
  `SWITCHBOARD_REPEATER_TOKEN` — **no client credential ever crosses the tunnel**.
- **Single worker, self-healing.** Only one worker pairs at a time; a second is
  rejected until the first's tunnel dies (TCP close or missed heartbeat). Bodies
  are chunked with app-level `PING`/`PONG` heartbeats + idle timeout; a client
  disconnect sends `RST` to cancel in-flight worker work. If no worker is paired
  when a request arrives, the repeater waits a short grace window, then fails
  (REST `502` / WS close) and the client's existing backoff retries.

## Agent integration

In PTY mode each tool runs as an ordinary interactive terminal program (no `-p`,
no stream-json) on a server-side pseudo-terminal; the PTY *is* the integration
surface, so the agent answers its own trust/permission prompts live. The
supervisor (`server/src/pty_proc.rs`) bridges the synchronous `portable-pty`
master to tokio — inside the task's `pty-host` process (`server/src/host/`) —
and a vt100 emulator (`server/src/terminal.rs`) tracks the screen for snapshots
in the server. Adding a new CLI agent is one registry entry in
`server/src/agent.rs`. The design decision behind this pivot (and what it
replaced) is recorded in [PTY-SPEC.md](PTY-SPEC.md).

## Self-upgrade

A host can replace its own binary while it is serving: `POST
/api/admin/upgrade/upload` takes the raw bytes, `POST /api/admin/upgrade/url` has
the host download them itself, both with an optional SHA-256. The binary is
rejected before anything is touched unless it is an executable for the host's own
OS *and* CPU — pushing the wrong build is the one mistake that could otherwise
leave a service down.

**Running tasks are unaffected**, because they are not in the server process:
their PTYs live in the detached `pty-host` processes described above, and the
replacement server re-attaches to them. All an upgrade costs is a moment of
buffered output.

How the new process starts is the only platform difference. Linux and macOS
`execve` in place, keeping the same pid. Windows cannot re-exec and cannot
overwrite a running image either, so the server renames its own `.exe` aside
(which the loader permits), writes the new one into that path, and exits — the
service manager starts it. That requires nssm's `AppExit Default Restart`; see
[DEPLOY.md](DEPLOY.md#upgrading).

Because a Windows service manager kills the whole process *tree* when the
application exits, a pty-host there is spawned through a one-shot
`pty-host-shim` process that exits immediately — by the time the server exits,
the host is nobody's descendant, so the tree kill cannot reach it. Unix needs no
such trick: `execve` never kills children.

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
