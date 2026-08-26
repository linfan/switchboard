# Switchboard — Quick Start & Deployment

How to run Switchboard locally, build release binaries of the hosting service,
and register it as a system service on **Linux (systemd)**, **Windows (`sc`)**,
and **macOS (launchd)**. For the full environment-variable reference see
[Configuration](README.md#configuration).

## Prerequisites
- Rust (stable) + Cargo
- Node.js 20+ and npm
- A CLI agent to host: [`claude`](https://claude.com/claude-code) and/or `qodercli`
- Tauri prerequisites for your OS (see https://tauri.app) — only needed to run
  the desktop shell; the web client builds without them.

## Quick start

The server speaks **HTTPS by default — even on localhost** — generating a
self-signed certificate on first run. The desktop client routes its networking
through its native (Rust) layer, which **pins** the server's certificate on first
add (trust-on-first-use) rather than trusting a CA, so there is no certificate to
install: just point the client at the host and it captures the pin automatically.

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

In the client, add the service with the host's IP/hostname and that token — the
client pins the cert on first add. Ensure the host firewall / cloud security group
allows inbound TCP on the port.

> **Security note:** the `SWB-v1` layer resists an active man-in-the-middle even
> with a self-signed cert — the pin (SHA-256 of the leaf, captured on first add)
> authenticates the channel, and the token is never transmitted (proven via a
> channel-bound HMAC). For maximum assurance on an untrusted network, confirm the
> fingerprint the server logs on startup matches the one captured on first add, or
> front the server with a reverse proxy holding a real CA certificate (set
> `SWITCHBOARD_TLS=0` and terminate TLS there).

### Running behind a repeater

For a host with no stable inbound IP, run a **repeater** on a stable-IP box and
have the worker dial out to it. On the repeater:

```bash
make run-repeater        # client-facing SERVER_ADDR + worker-facing REPEATER_ADDR (both HTTPS)
```

On the worker box (no client-facing bind; it pins the repeater's cert PEM):

```bash
make run-repeater-client # dials SWITCHBOARD_REPEATER_ADDR, pins SWITCHBOARD_REPEATER_CA
```

Point the client at the **repeater's** `SWITCHBOARD_ADDR` + `SWITCHBOARD_TOKEN` —
it behaves identically to a direct worker.

Prefer the browser during development? `cd client && npm run dev` serves the same
UI at http://localhost:5173. The browser build uses the webview's own
fetch/WebSocket (not the native bridge), so it can't accept a self-signed cert —
run the server with `SWITCHBOARD_TLS=0` and select the **http** protocol in the
dialog, or trust the generated `server/data/switchboard-cert.pem` in your OS
keychain.

## Building release binaries

```bash
make build             # build server (release) + client (with fresh TS bindings)
make package-server    # stage the server binary in ./dist
make package-client    # Tauri desktop bundles
```

### Cross-compiling the hosting service
The server cross-builds to Linux and Windows from any dev machine using `zig` as
the C compiler/linker (`brew install zig`) — no mingw-w64, MSVC, or musl toolchain
to install:
```bash
make setup-server-linux      # rustup target + zig check
make package-server-linux    # -> dist/switchboard-server-linux (static musl)
make setup-server-windows
make package-server-windows  # -> dist/switchboard-server.exe
```
The Windows build targets `x86_64-pc-windows-gnullvm` (zig's bundled mingw is
ucrt/lld-based) and imports only system DLLs. Terminal tasks there run on a
**ConPTY**, so `cmd`, `powershell`, and `pwsh` all work as a task's command —
which needs Windows 10 1809 or newer. Bare names resolve through `PATHEXT`, and
CLIs installed as `.cmd` shims (npm's `claude`) are launched via `%COMSPEC%`.
Self-upgrade works here too — see [Upgrading](#upgrading); it needs the service
to be registered so the manager restarts it, because Windows cannot re-exec.

### Cross-compiling the desktop client
The Tauri shell also cross-builds to Windows, but needs one extra tool:
mingw-w64's `windres`, the only resource compiler `tauri-build` drives on a
non-Windows host (it embeds `icons/icon.ico` and the version metadata).
```bash
brew install zig mingw-w64
make setup-client-windows
make package-client-windows  # -> dist/Switchboard.exe + WebView2Loader.dll
```
The frontend bundle is compiled into the binary, so the staged pair is the whole
app — copy both files to the Windows machine and run the `.exe`. Three caveats:
- **`WebView2Loader.dll` must sit next to the .exe.** `webview2-com-sys` links
  the loader statically only under MSVC; every other target (including this one)
  imports it from the DLL, so `package-client-windows` stages it alongside.
- **No installer off-Windows.** The NSIS and MSI bundlers only exist in the
  Tauri CLI's Windows build (`tauri build --bundles` offers just `app`/`dmg`/`ios`
  on macOS), so the target passes `--no-bundle`. Run `make package-client` on a
  Windows host, or in CI, if you need an `.msi`/`-setup.exe`.
- **WebView2 itself is a runtime dependency.** Tauri renders through it rather
  than shipping a browser engine. Windows 11 and current Windows 10 include it;
  older installs need Microsoft's Evergreen bootstrapper once.

#### "Could not find the WebView2 Runtime"
The DLL is not what's missing. `WebView2Loader.dll` is only a lookup shim — were
it absent the process would die at load time ("code execution cannot proceed"),
not show a dialog. This dialog means the loader ran and found no **runtime**: a
separate ~150 MB Edge install under `C:\Program Files (x86)\Microsoft\EdgeWebView\`.
Common on Windows Server, LTSC, and N editions. Check it:
```powershell
Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -EA 0
Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -Name pv -EA 0
```
A missing key, or `pv = 0.0.0.0` (leftover from a broken uninstall), both trigger
it. Fix with the Evergreen bootstrapper from
https://developer.microsoft.com/en-us/microsoft-edge/webview2:
`MicrosoftEdgeWebview2Setup.exe /silent /install` — as admin for machine-wide,
otherwise per-user (which also works). A portable `.exe` can never self-install
the runtime; `webviewInstallMode` only applies to the NSIS/MSI bundlers we skip.

For a fully self-contained drop, use the **Fixed Version** runtime instead:
download the CAB from that page, extract it beside `Switchboard.exe`, and set
`WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` to the extracted folder — the loader honors
that variable when the app passes a null browser folder, which is what wry does.
Costs ~180 MB and you own the patch cadence.

## Installing on a server host

The server is a single self-contained binary; only the binary and its state
(SQLite DB, generated TLS cert/key, logs) need a home.

1. **Copy the binary.**
   - Linux: `dist/switchboard-server-linux` → `/opt/switchboard/switchboard-server` (chmod +x)
   - Windows: `dist/switchboard-server.exe` → `C:\Program Files\Switchboard\`
   - macOS: the native `target/release/switchboard-server` → `/usr/local/bin/`
2. **Create a state directory** the service user can write to, e.g.
   `/opt/switchboard/data` (Linux/macOS) or `C:\ProgramData\Switchboard` (Windows).
   The SQLite DB and the auto-generated self-signed TLS cert/key live here
   (`SWITCHBOARD_DB`, `SWITCHBOARD_TLS_CERT`, `SWITCHBOARD_TLS_KEY`).
3. **Make the agent CLIs reachable.** Tasks spawn `claude` / `qodercli` by name,
   so they must be on the *service user's* `PATH` (set `PATH` explicitly in the
   unit/plist/wrapper below — services do not inherit your login shell's `PATH`).
4. **Choose a strong token** (`SWITCHBOARD_TOKEN`) and the bind address
   (`SWITCHBOARD_ADDR=0.0.0.0:8787` for remote access); open the port in the
   host firewall / cloud security group.
5. **Smoke-test before registering**: run the binary once in the foreground with
   the intended environment and confirm the client can connect, then register the
   service.

## Registering as a system service

All three platforms follow the same shape: put configuration in environment
variables, point the service manager at the binary, and enable restart-on-failure.
Logs go to stdout by default; under a service manager either read them from the
manager's journal/event log, or set `SWITCHBOARD_LOG` for size-based rolling
files — see [Log file rotation](README.md#log-file-rotation-switchboard_log).

### Linux — systemd

Create a dedicated user and directories:

```bash
sudo useradd --system --create-home --home-dir /opt/switchboard switchboard
sudo mkdir -p /opt/switchboard/data /opt/switchboard/logs /etc/switchboard
```

Put the configuration in an environment file, `/etc/switchboard/switchboard.env`:

```bash
SWITCHBOARD_ADDR=0.0.0.0:8787
SWITCHBOARD_TOKEN=choose-a-strong-token
SWITCHBOARD_DB=/opt/switchboard/data/switchboard.db
SWITCHBOARD_TLS_CERT=/opt/switchboard/data/switchboard-cert.pem
SWITCHBOARD_TLS_KEY=/opt/switchboard/data/switchboard-key.pem
SWITCHBOARD_LOG=/opt/switchboard/logs/switchboard.log|100mb*5
RUST_LOG=info
# must include the directories holding claude / qodercli
PATH=/usr/local/bin:/usr/bin:/bin:/opt/switchboard/bin
```

Register the unit, `/etc/systemd/system/switchboard.service`:

```ini
[Unit]
Description=Switchboard hosting service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=switchboard
WorkingDirectory=/opt/switchboard
EnvironmentFile=/etc/switchboard/switchboard.env
ExecStart=/opt/switchboard/switchboard-server
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enable and control it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now switchboard      # start now + on every boot
systemctl status switchboard                 # health check
journalctl -u switchboard -f                 # follow logs
```

To repeat the same for a **repeater** or a **dial-out worker**, register a second
unit with that role's variables instead (see
[Configuration](README.md#configuration)).

### Windows — nssm

`switchboard-server.exe` is a plain console binary — it never speaks the SCM
protocol (`StartServiceCtrlDispatcher` / `SetServiceStatus`), so registering it
directly with `sc` would start the process but leave `sc start` blocking until
the SCM's start timeout: the process never reports `SERVICE_RUNNING`. Wrap it
with **nssm** (https://nssm.cc/) instead, which implements the SCM side and runs
the binary as a child. Download nssm and make `nssm.exe` reachable (e.g. put it
next to the binary or add it to `PATH`).

Register the service pointing straight at the `.exe` — nssm sets environment
variables natively, so no `run-switchboard.cmd` wrapper is needed — then
configure the working directory, environment, and restart policy:

```bat
nssm install Switchboard "C:\Program Files\Switchboard\switchboard-server.exe"
nssm set Switchboard AppDirectory "C:\Program Files\Switchboard"
nssm set Switchboard AppEnvironmentExtra SWITCHBOARD_ADDR=0.0.0.0:8787 SWITCHBOARD_TOKEN=choose-a-strong-token SWITCHBOARD_DB="C:\ProgramData\Switchboard\switchboard.db" SWITCHBOARD_TLS_CERT="C:\ProgramData\Switchboard\switchboard-cert.pem" SWITCHBOARD_TLS_KEY="C:\ProgramData\Switchboard\switchboard-key.pem" "SWITCHBOARD_LOG=C:\ProgramData\Switchboard\logs\switchboard.log|100mb*5" RUST_LOG=info "PATH=C:\Program Files\Switchboard;C:\Program Files\nodejs;%SystemRoot%\System32;%SystemRoot%"
nssm set Switchboard AppExit Default Restart
nssm set Switchboard AppRestartDelay 3000
```

From an **elevated** shell, start and check the service:

```bat
nssm start Switchboard
nssm status Switchboard
```

Notes:
- `AppEnvironmentExtra` merges each variable into the service's environment — it
  does **not** replace the whole environment (that is `AppEnvironment`, which you
  should avoid). Each `nssm set … AppEnvironmentExtra` call replaces the previous
  list, so keep all variables in the single command above. Quote any value that
  contains spaces or shell metacharacters — especially `SWITCHBOARD_LOG`:
  unquoted, the `|` is a cmd pipe and the value gets cut at the path.
- Drop the `PATH=` argument if `claude` / `qodercli` already resolve for the
  service account; override it only when they live outside the default paths.
  `cmd` expands `%SystemRoot%` before nssm stores the value.
- There is no console under the SCM, so set `SWITCHBOARD_LOG` to get logs on
  disk (or redirect the binary's stdout instead:
  `nssm set Switchboard AppStdout <file>`).
- Terminal tasks run on ConPTY (Windows 10 1809+).
- The `AppExit Default Restart` line above is what makes self-upgrade work.
  Windows has no `execve`, so the server swaps its own `.exe` and exits, leaving
  nssm to start the new one; drop that setting and the service stays down after
  an upgrade.
- nssm terminates the **entire process tree** when the service application exits
  (its default behavior), and a self-upgrade is exactly such an exit. Tasks used
  to die with it — every running task came back `Exited` after an upgrade. The
  server now launches each `pty-host` through a one-shot `pty-host-shim`
  process, so a host is never a descendant of the server by the time it exits
  and no tree walk can reach it. No nssm setting is required.

Remove the service with:

```bat
nssm stop Switchboard
nssm remove Switchboard confirm
```

### macOS — launchd

Install the binary (e.g. `/usr/local/bin/switchboard-server`), create the state
directories, then write a daemon plist,
`/Library/LaunchDaemons/com.switchboard.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.switchboard.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/switchboard-server</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/opt/switchboard</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>SWITCHBOARD_ADDR</key>
        <string>0.0.0.0:8787</string>
        <key>SWITCHBOARD_TOKEN</key>
        <string>choose-a-strong-token</string>
        <key>SWITCHBOARD_DB</key>
        <string>/opt/switchboard/data/switchboard.db</string>
        <key>SWITCHBOARD_TLS_CERT</key>
        <string>/opt/switchboard/data/switchboard-cert.pem</string>
        <key>SWITCHBOARD_TLS_KEY</key>
        <string>/opt/switchboard/data/switchboard-key.pem</string>
        <key>SWITCHBOARD_LOG</key>
        <string>/opt/switchboard/logs/switchboard.log|100mb*5</string>
        <key>RUST_LOG</key>
        <string>info</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Load and control it (a LaunchDaemon runs at boot as root; for a per-user agent
instead, use `~/Library/LaunchAgents` and the `gui/<uid>` domain):

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/com.switchboard.server.plist
sudo launchctl kickstart -k system/com.switchboard.server   # restart
launchctl print system/com.switchboard.server               # status
sudo launchctl bootout system/com.switchboard.server        # unload
```

## Upgrading

- Back up the SQLite file (`SWITCHBOARD_DB`) before upgrading — it holds all task
  history and replay cursors.
- **Running tasks survive an upgrade on every platform.** Each task's PTY and
  agent live in a separate `pty-host` process, spawned detached from the server,
  so replacing the server never touches them: the new process re-attaches over
  the host's local socket and resumes each byte stream at the exact offset the
  old one had persisted. An upgrade costs a moment of buffered output, not a
  task. While no server is attached the host keeps buffering; if the gap runs
  long enough to exhaust its retention (4 MiB unacknowledged) it stops draining
  the PTY, which pauses the agent rather than losing its output. On Windows the
  host is additionally spawned through a short-lived `pty-host-shim` so it is
  not the server's descendant — service managers there kill process trees on
  exit, and the shim's immediate death hides the host from that walk (see the
  nssm note above).
- Self-upgrade is exposed as `POST /api/admin/upgrade/upload` (raw binary body)
  and `POST /api/admin/upgrade/url` (`{"url", "sha256"}`); both accept an
  optional SHA-256 and reject a binary built for another OS or CPU before
  replacing anything. The desktop client's *Upgrade host* dialog drives both.
- Where the new process comes from differs by platform, and that is all that
  differs: Linux and macOS re-exec in place, keeping the same pid. Windows cannot
  re-exec, so the server renames the running `.exe` aside, writes the new one in
  its place, and exits — the service manager starts it (see the nssm note above).
  A self-spawned replacement is deliberately *not* used: nssm restarts the
  service on exit, so it and our child would fight over the client port.
- Replacing the binary by hand and restarting the service works equally well on
  every platform, and keeps tasks running for the same reason. Reconnecting
  clients are fast-forwarded from the persisted log, so nothing is lost either
  way.
- The client/server wire protocol is **not** version-negotiated, so keep the two
  in step across releases (`make set-version` aligns every component). `GET
  /health` and the client's service list both report the version a host is
  actually running.
