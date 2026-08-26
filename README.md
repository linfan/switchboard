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
- **MITM-resistant transport (`SWB-v1`).** All legs are TLS with **certificate
  pinning** (SHA-256 of the leaf DER, trust-on-first-use), and the shared token is
  **never transmitted** — the client proves knowledge with a channel-bound
  HMAC-SHA256, so a captured transcript can't be replayed or relayed onto another
  channel.
- **Repeater mode (no stable IP required).** A stable-IP **repeater** relays
  traffic to one **worker that dials out**; both sides connect outbound. The
  repeater forwards opaque bytes, so it's fully transparent — the client points at
  a URL + token exactly as with a direct worker.

## Repository layout
| Path       | What |
|------------|------|
| `shared/`  | Rust protocol crate: serde control-plane types (→ TS via `ts-rs`) + the binary frame codec |
| `server/`  | Rust hosting service (axum, SQLite, PTY supervisor + vt100 emulator) |
| `client/`  | Tauri 2 + React + Zustand desktop client with xterm.js terminals |
| `e2e/`     | End-to-end harness: real server binary + WS clients + fake PTY agent |
| `Makefile` | Unified build/test/run/deploy |
| `DEPLOY.md` | Quick start, release builds, and service registration (systemd / nssm / launchd) |
| `PTY-SPEC.md` | The v2 PTY design |

## Architecture

```
┌──────────────────────────────┐         ┌────────────────────────────────────┐
│  Desktop client (Tauri/React)│         │  Hosting service (Rust / axum)       │
│                              │  WS/WSS  │                                      │
│  ConnectionPool              │◀────────▶│  /ws ── control + data planes ─┐     │
│   └ ConnectionManager (×N)   │  + REST  │                      ▼         │     │
│       • Hello + cursors      │          │   TaskManager ── broadcast bus │     │
│       • heartbeat watchdog   │  JSON ctl│      │                         │     │
│       • backoff reconnect    │  + binary│      ├─ HostLink ── local IPC ─┤     │
│       • sleep/online detect  │  frames  │      │    to each pty-host     │     │
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
- Each task's PTY and agent live in a **separate `pty-host` process**, spawned
  detached, which the server drives over a local socket (unix socket / named
  pipe). So the server holds no OS resource belonging to a task and can be
  replaced — for a self-upgrade, a crash, a service restart — without killing
  anything: the new process re-attaches and resumes each byte stream at the
  offset the old one had persisted. See [Self-upgrade](#self-upgrade).

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

### Transport security (`SWB-v1`)

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

### Repeater mode (no stable IP required)

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

### Agent integration

In PTY mode each tool runs as an ordinary interactive terminal program (no `-p`,
no stream-json) on a server-side pseudo-terminal; the PTY *is* the integration
surface, so the agent answers its own trust/permission prompts live. The
supervisor (`server/src/pty_proc.rs`) bridges the synchronous `portable-pty`
master to tokio — inside the task's `pty-host` process (`server/src/host/`) —
and a vt100 emulator (`server/src/terminal.rs`) tracks the screen for snapshots
in the server. Adding a new CLI agent is one registry entry in
`server/src/agent.rs`.

### Self-upgrade

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

## Quick start & deployment

See [DEPLOY.md](DEPLOY.md) for prerequisites, the quick start (local, remote,
and repeater setups), release/cross builds, installing the hosting service, and
registering it with **systemd** (Linux), **nssm** (Windows), or **launchd**
(macOS).

## Configuration

### Server (worker) environment variables

The default role: binds a client-facing address, serves the API + WS, and runs
PTYs locally.

| Var | Default | Meaning |
|-----|---------|---------|
| `SWITCHBOARD_MODE` | `worker` | Role selector: `worker` or `repeater` |
| `SWITCHBOARD_ADDR` | `127.0.0.1:8787` | Client-facing listen address |
| `SWITCHBOARD_TOKEN` | `dev-token` | Shared client token (never transmitted; proven via HMAC) |
| `SWITCHBOARD_DB` | `server/data/switchboard.db` | SQLite path |
| `SWITCHBOARD_NAME` | host name | Service display name |
| `SWITCHBOARD_PERMISSION_MODE` | `default` | Passed to the agent's `--permission-mode` |
| `SWITCHBOARD_TLS` | `1` (on) | HTTPS/WSS; set `0` to serve plain HTTP |
| `SWITCHBOARD_TLS_CERT` | `server/data/switchboard-cert.pem` | PEM cert path (auto-generated if missing) |
| `SWITCHBOARD_TLS_KEY` | `server/data/switchboard-key.pem` | PEM key path (auto-generated if missing) |
| `SWITCHBOARD_TLS_SAN` | — | Extra SANs (comma-separated IPs/hostnames) for the generated cert |
| `SWITCHBOARD_LOG` | — | Rolling log file, `<path>\|<max-size>*<max-archives>` (see [Log file rotation](#log-file-rotation-switchboard_log)) |

To run a worker **behind a repeater** (worker-repeater-client), leave
`SWITCHBOARD_ADDR` / `SWITCHBOARD_TOKEN` unset and set the vars in
[Worker behind a repeater (dial-out)](#worker-behind-a-repeater-dial-out);
it dials out and needs no client-facing bind.

### Repeater environment variables

Set `SWITCHBOARD_MODE=repeater` to run the relay. It binds a client-facing **and**
a worker-facing HTTPS listener, forwards opaque bytes to the one paired worker,
and runs no tasks itself.

| Var | Default | Meaning |
|-----|---------|---------|
| `SWITCHBOARD_MODE` | `worker` | Must be `repeater` to select this role |
| `SWITCHBOARD_ADDR` | `127.0.0.1:8787` | Client-facing HTTPS listen address |
| `SWITCHBOARD_TOKEN` | `dev-token` | Client token validated at ingress (never transmitted) |
| `SWITCHBOARD_REPEATER_ADDR` | — | Worker-facing HTTPS bind that the dialing worker connects to |
| `SWITCHBOARD_REPEATER_TOKEN` | — | Shared secret for the worker↔repeater tunnel |
| `SWITCHBOARD_TLS` / `_CERT` / `_KEY` / `_SAN` | as above | TLS for both listeners (same semantics as the server table) |
| `SWITCHBOARD_NAME` | host name | Service display name |
| `SWITCHBOARD_LOG` | — | Rolling log file, `<path>\|<max-size>*<max-archives>` (see [Log file rotation](#log-file-rotation-switchboard_log)) |

### Worker behind a repeater (dial-out)

A worker-repeater-client sets no `SWITCHBOARD_ADDR` / `SWITCHBOARD_TOKEN`; it only
dials out to the repeater. Note that `SWITCHBOARD_REPEATER_CA` is read **only**
by this role — the repeater itself never uses it.

| Var | Default | Meaning |
|-----|---------|---------|
| `SWITCHBOARD_REPEATER_ADDR` | — | Repeater address to dial |
| `SWITCHBOARD_REPEATER_TOKEN` | — | Shared secret for the worker↔repeater tunnel |
| `SWITCHBOARD_REPEATER_CA` | — | PEM whose leaf cert the worker pins on the tunnel |
| `SWITCHBOARD_DB` / `SWITCHBOARD_NAME` / `SWITCHBOARD_LOG` | as above | Same semantics as the server table |

### Log file rotation (`SWITCHBOARD_LOG`)

Logs go to stdout by default. Set `SWITCHBOARD_LOG` to write to a **size-based
rolling file** instead, in the format
`<file-path>|<max-size><unit>*<max-archive-count>`:

```bash
SWITCHBOARD_LOG='logs/switchboard.log|100mb*5'
```

This writes to `logs/switchboard.log`, rolls it once a write would push it past
100 MiB, and keeps at most **5** archived generations (`switchboard.log.1` …
`switchboard.log.5`, newest first; the oldest is discarded on roll). Parent
directories are created if missing. Size units are case-insensitive — `b`, `kb`,
`mb`, `gb` (or the bare `k` / `m` / `g`); a plain number is bytes. Applies to
every role (worker, repeater, worker-repeater-client), and `RUST_LOG` still
controls the level/filter. A `count` of `0` keeps no archives (the file is
truncated in place on roll). Quote the spec in shells where `|` is a pipe —
`set "SWITCHBOARD_LOG=…|100mb*5"` in `cmd.exe`, single quotes in POSIX shells —
otherwise the value arrives truncated and is ignored with a warning.

Stdout logs are colorized only when stdout is a terminal that renders ANSI
escapes (on Windows the console's virtual-terminal mode is switched on for this,
and pre-1809 consoles that reject it get plain text). Redirected output and log
files are never colorized; set `NO_COLOR=1` to turn color off everywhere.

Role selection: `SWITCHBOARD_MODE=repeater` → **repeater**. Otherwise a worker
with **no** `SWITCHBOARD_ADDR`/`SWITCHBOARD_TOKEN` but a `SWITCHBOARD_REPEATER_ADDR`
+ `SWITCHBOARD_REPEATER_TOKEN` becomes a **worker-repeater-client** (dials out);
any other worker is **worker-direct** (binds and serves).

Auth (`SWB-v1`): the token is **never sent**. REST requests carry `X-Swb-Ts` /
`X-Swb-Nonce` / `X-Swb-Mac` (a per-request HMAC over method, path+query,
`SHA-256(body)`, timestamp, nonce, and the channel's cert fingerprint); the
WebSocket runs a nonce challenge-response at connect. See
[Transport security (`SWB-v1`)](#transport-security-swb-v1).

TLS: HTTPS is on by default. When the cert/key files are absent the server
generates a self-signed certificate (ECDSA P-256, ~13-month validity); the
`SWITCHBOARD_TLS_SAN` entries (plus `localhost` and local interface addresses)
become its SANs, which matters only if you later trust it in a browser. The
desktop client **pins** the self-signed leaf on first add (hostname ignored), so
no CA trust step is needed there. To terminate TLS yourself (reverse proxy, real
CA cert), set `SWITCHBOARD_TLS=0` and run the proxy in front.

Networking: the desktop client performs REST and WebSocket I/O in its native
(Rust) layer rather than the webview, using **rustls with a pinning verifier** — it
reaches self-signed hosts (which the webview's fetch/WebSocket would reject) while
still authenticating the channel by the captured leaf-cert fingerprint, so an
active MITM is rejected on pin mismatch.

To supply your own self-signed key pair instead of letting the server generate
one, create a `tls/` directory and run:

```bash
mkdir -p tls
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout tls/private.key -out tls/certificate.pem -days 397 \
    -subj "/O=Switchboard/CN=Switchboard" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.1.50" \
    -addext "extendedKeyUsage=serverAuth"
```

Replace `192.168.1.50` with the address clients dial (add one `IP:`/`DNS:` entry
per address). Then point `SWITCHBOARD_TLS_CERT` / `SWITCHBOARD_TLS_KEY` at the
generated files. `-days 397` stays under the 398-day cap macOS/Safari enforce, so
the same cert can also be trusted in a browser.

Two encoding details are **not** optional — rustls (the desktop client's pinning
verifier, the worker's outbound leg to a repeater, and the server's own key
loader) is stricter than OpenSSL's defaults:

- **`-addext` — the cert must be X.509 v3.** `openssl req -x509` with no
  extensions at all emits a **v1** certificate, which rustls rejects at handshake
  time with `invalid peer certificate: Other(OtherError(UnsupportedCertVersion))`.
  Any one `-addext` forces v3, so `subjectAltName` already covers it. Whether the
  older extension-less command happened to work depended entirely on the local
  OpenSSL: OpenSSL 3.x with a config that sets `x509_extensions` adds extensions
  (→ v3) on its own, while LibreSSL (macOS's `/usr/bin/openssl`) and any build
  running without a usable `openssl.cnf` produce v1.
- **EC keys need `-pkeyopt ec_param_enc:named_curve`.** If you prefer ECDSA
  P-256 over RSA, use
  `-newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -pkeyopt ec_param_enc:named_curve`.
  Without the second `-pkeyopt`, OpenSSL/LibreSSL write the curve as *explicit*
  parameters, which rustls can't read — the server then fails to start with
  `failed to parse private key as RSA, ECDSA, or EdDSA`. RSA has no equivalent
  trap, hence the default above.

Verify both before deploying:

```bash
openssl x509 -in tls/certificate.pem -noout -text | grep -E "Version|DNS:|IP Address"
#         Version: 3 (0x2)     <- must say 3, not 1
head -1 tls/private.key        # BEGIN PRIVATE KEY (PKCS#8) or BEGIN RSA PRIVATE KEY
```

On Windows, use the OpenSSL that ships with Git for Windows
(`C:\Program Files\Git\usr\bin\openssl.exe`); from Git Bash the command above works
verbatim. If OpenSSL isn't available, **omit the cert/key files entirely and let the
server generate the pair on startup** — it emits a correct v3 ECDSA P-256 cert with
the right SANs, and the desktop client pins it on first add, so this is the
recommended path on every platform.

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
  the PTY supervisor and vt100 emulator have their own unit tests. A repeater
  suite boots a live repeater + a worker that dials in and re-runs the WS
  assertions **through the tunnel** (the transparency proof), plus REST, a
  >2 MiB chunked upload, unsigned-request rejection, and single-worker pairing.
  Crypto has vectors in `shared/` (HMAC determinism, wrong-token/nonce/`cb`
  rejects, domain separation, tunnel-codec round-trips).
- **Client** vitest tests exercise the connection manager with a mock socket and
  fake timers (handshake, binary transport, backoff, manual reconnect, heartbeat
  death/recovery, offline suppression, sleep-triggered reconnect), the store
  cursor logic, and the binary frame codec round-trip.
- **End-to-end** (`e2e/`) spawns the real server binary supervising a fake PTY
  agent on `PATH`, connects real WebSocket clients, and proves the crown-jewel
  guarantee: after a disconnect a reconnecting client is fast-forwarded *exactly*
  the terminal bytes it missed — gap-free, no loss, no duplicates. It then kills
  the server outright and requires the task to still be running, and still
  answering input, under its replacement.
- **Browser E2E** (`client/tests-e2e/`, Playwright) boots the real server + the
  Vite dev app and drives a live xterm.js terminal: renders PTY output, types
  input, and verifies the display survives a forced reconnect.

## App icon
The icon is authored as SVG (`client/src-tauri/icons/icon.svg` for large sizes,
`icon-small.svg` for ≤64px). After editing an SVG, regenerate the bundled PNGs
and `.icns` (needs `iconutil`, macOS-only). `render-icon.mjs` writes `icon.ico`
itself — Windows needs every frame in one file, so there is nothing to rename:
```bash
cd client/src-tauri/icons
node render-icon.mjs                        # render 16–1024px PNGs + icon.ico
cp 32.png 32x32.png                         # map to the names tauri.conf.json bundles
cp 128.png 128x128.png
cp 256.png 128x128@2x.png
cp 1024.png icon.png
ICONSET=switchboard.iconset; rm -rf "$ICONSET"; mkdir "$ICONSET"
cp 16.png "$ICONSET/icon_16x16.png";      cp 32.png "$ICONSET/icon_16x16@2x.png"
cp 32.png "$ICONSET/icon_32x32.png";      cp 64.png "$ICONSET/icon_32x32@2x.png"
cp 128.png "$ICONSET/icon_128x128.png";   cp 256.png "$ICONSET/icon_128x128@2x.png"
cp 256.png "$ICONSET/icon_256x256.png";   cp 512.png "$ICONSET/icon_256x256@2x.png"
cp 512.png "$ICONSET/icon_512x512.png";   cp 1024.png "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o icon.icns
rm -rf "$ICONSET" 16.png 32.png 48.png 64.png 128.png 256.png 512.png 1024.png
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
