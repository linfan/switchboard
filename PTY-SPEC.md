# Switchboard — PTY Mode Spec (v2 pivot)

Status: **proposed** · Supersedes the stream-json data plane in `PLAN.md`.

## 1. Decision & rationale

Drop the stream-json integration as the data plane. **Every task is a real
interactive CLI process attached to a server-side pseudo-terminal (PTY); the
client renders it with a browser terminal emulator (xterm.js).**

Why: the `--print --input-format stream-json --output-format stream-json`
contract is effectively a Claude Code convention. Only Claude and deliberate
clones (`qodercli`, and *maybe* Amp / cursor-agent) fit it cleanly; Codex/Gemini
use different JSON schemas, OpenCode is an HTTP-server model, and the long tail
(aider, pi, goose, …) is TUI-first. A PTY is the **universal** integration: any
terminal tool works because we are just being its terminal. It also makes
interactive prompts (trust dialogs, permission approvals, y/N) *just work* —
they are answered natively instead of needing per-tool flags.

Cost we accept: a terminal is a **stateful byte stream**, not discrete seq'd
messages, so "no message loss" becomes "the client's screen is provably
reconstructed after reconnect." Section 5 handles this.

### What changes vs. the current build

| Area | v1 (stream-json) | v2 (PTY) |
|------|------------------|----------|
| Process | `Command` + piped stdio, `-p` stream-json argv | `portable-pty` PTY + native interactive argv |
| Wire data plane | JSON `Message{seq, AgentEvent}` (text frames) | **binary WS frames** of raw terminal bytes |
| Server state | append JSON events to SQLite | append byte-chunks + **server-side vt100 emulator** |
| Reconnect | replay events `seq > cursor` | **snapshot** (rebuild screen) then live; byte-replay as fast-path |
| Client render | React message list | **xterm.js** terminal panel |
| Control plane | JSON `ClientMsg`/`ServerMsg` | same JSON control plane, trimmed |

Kept unchanged: bearer-token auth, per-service connection manager
(backoff/heartbeat/sleep/online detection), service list, task CRUD, SQLite
durability discipline (persist-before-broadcast, monotonic per-task seq,
durable per-client cursors), ts-rs for the control plane.

## 2. Architecture

```
┌──────────────── Client (Tauri/React) ─────────────────┐
│ Sidebar (services + tasks)   TerminalView (xterm.js)   │
│                               • term.onData → INPUT     │
│                               • FitAddon → resize       │
│                               • write(OUTPUT/SNAPSHOT)  │
│ ConnectionManager (per svc): control=JSON text frames, │
│   data=binary frames; backoff/heartbeat/sleep/online   │
└───────────────▲───────────────────────────▲───────────┘
       control (text JSON)          data (binary frames)
                │                            │
        ┌───────┴────────────────────────────┴─────────┐
        │ Hosting service (Rust / axum /ws)             │
        │  TaskManager                                  │
        │   └ PtyProc (portable-pty)                    │
        │       master ⇄ CLI (native interactive TUI)   │
        │       reader → { vt100 emulator (authoritative│
        │                  screen+scrollback),          │
        │                  SQLite chunk log (durable),  │
        │                  broadcast bus (binary) }      │
        │       writer ← client keystrokes              │
        │  SQLite: tasks · pty_chunks · delivery_cursors│
        └───────────────────────────────────────────────┘
```

## 3. Process supervision (`server/src/pty_proc.rs`, replaces `agent_proc.rs`)

`portable-pty` is synchronous; bridge it to tokio with dedicated threads +
channels.

> Since this spec was written, all of the below runs in the task's own detached
> `pty-host` process rather than in the server (`server/src/host/`), so that
> replacing the server binary does not kill running tasks. The mechanics are
> unchanged; the server now reaches them over a local socket instead of owning
> the PTY directly.

1. `native_pty_system().openpty(PtySize { rows, cols, pixel_width:0, pixel_height:0 })`
   using the client-provided initial size from `create_task` (default 80×24).
2. `CommandBuilder` with the tool's **native interactive argv** (see §7), `cwd`,
   inherited env. `pair.slave.spawn_command(cmd)` → `child`.
3. **Reader**: `pair.master.try_clone_reader()` in a `spawn_blocking`/std thread;
   read into a buffer, forward chunks over an `mpsc` to the async output pipeline.
4. **Writer**: `pair.master.take_writer()` in a thread fed by an `mpsc`; each
   INPUT frame's bytes are written verbatim to the PTY.
5. **Resize**: `pair.master.resize(PtySize{..})` on each `resize` control msg;
   also resize the vt100 parser so snapshots match.
6. **Waiter**: `child.wait()` in a thread → emit `TaskState::Exited{code}`.
7. **Terminate**: `child.kill()` → `TaskState::Terminated`. Dropping viewer
   handles must NOT kill the child (same bug fixed in v1).

## 4. Transport protocol — hybrid text/binary

WebSocket frames are self-delimiting and carry an opcode. We use it directly:

- **Text frames** = JSON control plane (`ClientMsg`/`ServerMsg`, §6). Low volume,
  keeps ts-rs type-safety.
- **Binary frames** = terminal data plane. Compact fixed header, no base64.

`ws.binaryType = "arraybuffer"` on the client. `task_id` is sent as the 16 raw
bytes of its UUID. Multi-byte integers are big-endian.

### Binary frame layouts

Server → Client:
```
OUTPUT    [0x01][task_id:16][seq:u64][data: raw PTY bytes]
SNAPSHOT  [0x02][task_id:16][seq:u64][data: ANSI to reconstruct current screen]
```
Client → Server:
```
INPUT     [0x10][task_id:16][data: raw keystroke bytes]
```

- `seq` on OUTPUT is the monotonic per-task chunk sequence (durable, §5).
- SNAPSHOT's `seq` is the chunk seq the snapshot already reflects; the client's
  live position starts there.
- INPUT needs no seq: WS/TCP preserves order and the server writes bytes in
  arrival order.

Codec lives in `shared` as a small documented module (`frame.rs`): pure
`encode_*`/`decode` fns returning a `Frame` enum. Not ts-rs (binary), but unit
round-trip tested on both sides (Rust + a mirrored TS encoder/decoder).

## 5. Durability & gap-free reconnect (the core guarantee, in PTY terms)

Guarantee restated: **after any (re)connect, the client's terminal state
provably equals the server's, with no lost output.**

Server pipeline for each PTY chunk (in order, before broadcast):
1. Allocate next `seq` and insert `pty_chunks(task_id, seq, bytes, ts)` in one
   transaction (`UPDATE tasks SET last_seq = last_seq + 1 RETURNING` + insert) —
   same collision-free discipline as v1.
2. Feed the bytes into the task's **vt100 parser** (authoritative screen +
   bounded scrollback).
3. Broadcast an OUTPUT binary frame to live viewers.

On (re)connect the client sends `Hello { cursors: {task_id: last_seq} }`. Per
task the server picks a replay strategy:

- **Snapshot (always correct, default).** Render the current screen via
  `vt100::Screen::contents_formatted()` (returns the escape sequences that
  recreate the visible grid) and send a SNAPSHOT frame carrying the current tail
  `seq`. Client does `term.reset()` then `term.write(snapshot)`. Cost is
  O(screen), independent of session length. Then resume live from tail seq.
- **Byte fast-forward (optimization).** If the client's cursor is recent
  (`tail - cursor ≤ N` chunks / bytes), replay raw OUTPUT chunks `seq > cursor`
  instead — byte-exact, preserves scrollback continuity, no reset.

Either path ends with `ReplayDone{task_id, last_seq}`. `Ack{task_id, seq}`
persists the delivery cursor (used to pick fast-forward vs snapshot and to bound
log growth). Because the emulator state is a pure function of the ordered chunk
log, snapshot and fast-forward converge to the identical screen — and multiple
concurrent viewers of one task all converge on the server's authoritative state.

Retention: keep the full `pty_chunks` log for audit + scrollback by default;
optional trimming of chunks below the min delivered cursor beyond a byte budget
is a later enhancement (snapshot makes it safe to trim).

## 6. Control plane types (`shared`, trimmed)

Remove: `ClientMsg::UserInput`, `ServerMsg::Message`, `AgentEvent`. (Text turns
now flow as keystrokes in INPUT frames; structured events are gone.)

Add / change:
```
ClientMsg (text/JSON):
  Hello         { client_id, cursors }                    // unchanged
  CreateTask    { tool, title?, cwd?, cols, rows }         // + initial PTY size; initial_prompt dropped
  Resize        { task_id, cols, rows }                    // NEW
  TerminateTask { task_id }                                // unchanged
  Ack           { task_id, seq }                           // unchanged (now chunk seq)
  Ping          { ts }                                     // unchanged

ServerMsg (text/JSON):
  Welcome     { service, tasks }                           // unchanged
  TaskCreated { task }                                     // unchanged
  TaskState   { task_id, status }                          // unchanged
  ReplayDone  { task_id, last_seq }                        // unchanged
  Pong        { ts }                                       // unchanged
  Error       { task_id?, code?, message }                 // unchanged
```
OUTPUT / SNAPSHOT / INPUT are binary frames (§4), not part of the ts-rs enums.
`TaskInfo.last_seq` now means "highest chunk seq". ts-rs still regenerates the
control-plane bindings.

## 7. Agent launch (`server/src/agent.rs`)

Keep the adapter registry, but `argv()` now returns the **native interactive**
command (no `-p`, no stream-json):
- `claude` → `["claude"]` (optionally `--permission-mode <mode>` if the operator
  wants to preset it; otherwise prompts are answered live in the terminal).
- `qodercli` → `["qodercli"]`.
- New tools = one registry entry: how to launch it interactively. `available`
  detection (PATH lookup) is unchanged.

## 8. Client

- Deps: `@xterm/xterm`, `@xterm/addon-fit` (autosize), optional
  `@xterm/addon-webgl` (perf). (Playwright already installed for tests.)
- **TerminalView** wraps an xterm.js `Terminal`:
  - mount → attach to a persistent `Terminal` for that task (see below),
    `FitAddon.fit()`, send initial `Resize`.
  - `term.onData(bytes → INPUT frame)`, `term.onResize(→ Resize control msg)`.
  - incoming OUTPUT/SNAPSHOT → `term.write(bytes)`; SNAPSHOT is preceded by
    `term.reset()`.
- **Terminal instance lifecycle**: keep a `Map<taskId, Terminal>` *outside* React
  (in the pool) so switching tasks in the sidebar detaches/reattaches the DOM
  element without losing scrollback. This replaces the store's per-conversation
  message array; the store keeps only task metadata + delivery cursor.
- **ConnectionManager**: set `binaryType`; on message, branch text vs binary;
  add `sendInput(taskId, bytes)` and `sendResize(...)`; everything else
  (backoff, heartbeat, sleep/online) unchanged.
- Store: drop `messages`/`applyMsg` message handling; keep services (persisted),
  task list, and cursors (persisted). `Ack` still advances/persists cursors.

## 9. Testing

- **shared**: binary frame encode/decode round-trips (Rust); mirrored TS
  frame codec unit test; control-plane serde round-trips (trimmed).
- **server**: `pty_proc` against a fake TUI script (emits known ANSI, echoes
  input, exits) — assert output bytes, input echo, resize effect, clean exit,
  terminate. vt100 snapshot test: feed bytes → assert `contents_formatted`
  reconstructs the expected screen. WS binary plane: connect→stream→drop→
  reconnect → assert SNAPSHOT rebuilds the exact screen and live resumes;
  multi-viewer convergence.
- **client**: frame codec + store unit tests (vitest). xterm.js rendering is not
  jsdom-friendly → covered by Playwright instead.
- **Playwright (now the payoff)**: launch the web client against a real server
  hosting a fake TUI agent; type into the terminal, assert rendered screen text
  via the xterm DOM/accessibility tree; drop the socket, assert the screen
  survives reconnect.
- **e2e**: real server binary + PTY + fake TUI on PATH + real WS client sending
  INPUT frames; assert OUTPUT byte stream and snapshot-on-reconnect (the v2
  analogue of the v1 gap-free reconnect test).

## 10. Phased implementation (P9)

- ✅ **P9.1 — Protocol**: `shared/src/frame.rs` binary codec (OUTPUT/SNAPSHOT/
  INPUT, 16-byte UUID header, BE seq) + hand-mirrored `client/src/net/frame.ts`.
  *Test:* 8 Rust + 9 TS round-trip/rejection tests. **Sequencing note:** the JSON
  enum trim (drop `UserInput`/`Message`/`AgentEvent`, add `Resize`, resize
  `CreateTask`) is coupled to consumer rewrites, so it rides with P9.2/P9.3
  (server) and P9.4 (client) to keep every commit building.
- **P9.2 — PTY supervisor**: `pty_proc.rs` (portable-pty, reader/writer/waiter
  bridge, resize, kill); native argv in `agent.rs`. *Test:* fake-TUI spawn/echo/
  resize/exit/terminate.
- **P9.3 — Server data plane**: vt100 emulator + `pty_chunks` durable log +
  binary WS fan-out + snapshot/fast-forward reconnect + resize. *Test:* reconnect
  snapshot fidelity, live streaming, multi-viewer convergence.
- **P9.4 — Client terminal**: xterm.js TerminalView + persistent Terminal map +
  binary transport in ConnectionManager + store trim. *Test:* frame/store vitest.
- **P9.5 — E2E + Playwright + docs**: fake-TUI e2e reconnect-snapshot; Playwright
  terminal render/type/reconnect; update README, Makefile, PLAN.md.

Each sub-phase ends with an atomic conventional commit.

## 11. Risks & mitigations

- **Sync↔async PTY bridge / backpressure** → dedicated threads + bounded
  channels; coalesce reader output into ≤ (a few) KB chunks to cap frame rate.
- **Snapshot fidelity** → `vt100::contents_formatted` covers the visible screen;
  scrollback needs byte fast-forward or an explicit scrollback fetch (deferred).
- **Resize races** (redraw mid-resize) → resize PTY and vt100 together; snapshot
  is taken at a consistent point.
- **Binary framing bugs** → single shared codec, round-trip tested both sides.
- **xterm.js untestable in jsdom** → Playwright is the render test surface.
- **Security**: raw keystrokes reach a real shell/agent with the host's
  privileges — same trust model as SSH-to-your-own-box; bearer token + `wss://`
  behind TLS remain mandatory for remote hosts. Native interactive mode means
  the *user* answers permission/trust prompts, rather than us auto-bypassing them.

## 12. Open questions (pick before P9.3)

1. **Reconnect default**: snapshot-only (simplest, drops scrollback across
   reconnects) vs snapshot + bounded byte fast-forward (preserves recent
   scrollback). Spec assumes snapshot default + fast-forward when cursor recent.
2. **Scrollback**: rely on the CLI's own scrollback within the PTY viewport, or
   have the client keep a large xterm scrollback fed by fast-forward? Deferred.
3. **Log retention**: keep full `pty_chunks` forever (audit) vs trim beyond a
   byte budget once delivered. Spec keeps full by default.
