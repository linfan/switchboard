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
| `DEPLOY.md` | Quick start, configuration reference, installing & running as a service (systemd / nssm / launchd), upgrading |
| `BUILD.md` | Release & cross builds, packaging, test suites, app-icon regeneration |
| `ARCHITECTURE.md` | How it works: durability, wire protocol, `SWB-v1` transport security, repeater, self-upgrade |
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

A thin Tauri shell around a plain web client, talking WebSocket directly to each
hosting service. The service owns durability — every PTY output chunk is
sequenced and persisted to SQLite before it is broadcast — and each task runs in
its own detached `pty-host` process, so the server can restart or replace itself
without killing tasks. The full design (the gap-free replay guarantee, the wire
protocol, `SWB-v1` transport security, repeater internals, self-upgrade) is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Quick start
```bash
make setup        # install Rust + client + e2e deps
make run-server   # hosting service on https://127.0.0.1:8787
make run-client   # in another terminal — the desktop client (Tauri dev)
```
In the client, add a service (**+svc**: host `127.0.0.1`, token `dev-token`),
create a task (**+task**), and open its live terminal. Prerequisites, remote and
repeater setups, service installation, and upgrading are in
[DEPLOY.md](DEPLOY.md).

## License
MIT
