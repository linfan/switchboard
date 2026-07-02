# Agent-Manage

Cross-host, multi-agent management tool. A desktop **client** connects to one or
more **hosting services**; each hosting service runs and supervises multiple
CLI-based agent tasks (Claude Code, Qoder CLI, or any compatible CLI agent).
Each task is an independent conversation with its own isolated context.

> Status: **in active development** — see [`PLAN.md`](./PLAN.md) for the phase
> plan and current progress.

## Highlights
- **One client, many hosts, many tasks.** Add hosting services at runtime; run
  many concurrent agent conversations per host.
- **Real-time streaming** over a persistent WebSocket.
- **No message loss.** Every agent event is sequenced and persisted server-side;
  reconnects replay undelivered events gap-free with client-side dedup.
- **Resilient client.** Configurable auto-reconnect + manual trigger; detects
  network drops *and* system resume-from-sleep.

## Repository layout
| Path       | What |
|------------|------|
| `shared/`  | Rust protocol crate (serde) → generates TypeScript bindings via `ts-rs` |
| `server/`  | Rust hosting service (axum, SQLite, agent process supervisor) |
| `client/`  | Tauri 2 + React + Zustand desktop client |
| `Makefile` | Unified build/test/run/deploy |
| `PLAN.md`  | Architecture + phased plan + progress |

## Prerequisites
- Rust (stable) + Cargo
- Node.js 20+ and npm
- A CLI agent to host: [`claude`](https://claude.com/claude-code) and/or `qodercli`
- Tauri prerequisites for your OS (see https://tauri.app)

## Quick start
```bash
make setup                  # install Rust + client deps
make run-server             # start a hosting service on 127.0.0.1:8787
# in another terminal:
make run-client             # launch the desktop client
```
In the client: **Add service** → `ws://127.0.0.1:8787` with token `dev-token`
→ **New task** → pick the service + agent tool → start chatting.

## Architecture, setup, usage, design rationale
Detailed sections are filled in as phases land — see `PLAN.md` for the current
design of record. (This README is expanded to full architecture/usage/rationale
in the final phase.)

## License
MIT
