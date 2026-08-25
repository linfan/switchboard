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
Self-upgrade (`POST /upgrade`) stays unix-only: it re-execs in place to carry live
PTYs across the restart, which has no Windows equivalent.

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

### Windows — `sc`

`sc` has no way to attach environment variables to a service, so either set them
machine-wide (`setx /M SWITCHBOARD_ADDR 0.0.0.0:8787`, …) and register the `.exe`
directly, or — recommended — register a small wrapper script that sets them:

`C:\Program Files\Switchboard\run-switchboard.cmd`:

```bat
@echo off
set SWITCHBOARD_ADDR=0.0.0.0:8787
set SWITCHBOARD_TOKEN=choose-a-strong-token
set SWITCHBOARD_DB=C:\ProgramData\Switchboard\switchboard.db
set SWITCHBOARD_LOG=C:\ProgramData\Switchboard\logs\switchboard.log|100mb*5
set RUST_LOG=info
"C:\Program Files\Switchboard\switchboard-server.exe"
```

From an **elevated** shell, create and start the service:

```bat
sc create Switchboard binPath= "C:\Program Files\Switchboard\run-switchboard.cmd" start= auto
sc start Switchboard
sc query Switchboard
```

Notes:
- There is no console under the SCM, so set `SWITCHBOARD_LOG` to get logs on disk.
- The service account's `PATH` must resolve `claude` / `qodercli`; add a
  `set PATH=...` line to the wrapper if they live outside the default paths.
- Terminal tasks run on ConPTY (Windows 10 1809+). Self-upgrade (`POST /upgrade`)
  is unix-only; on Windows upgrade by replacing the `.exe` and restarting.

Remove the service with:

```bat
sc stop Switchboard
sc delete Switchboard
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
- On Linux/macOS the server supports in-place self-upgrade (`POST /upgrade`),
  which re-execs and carries live PTYs across the restart. Under a service
  manager you can equally just replace the binary and restart the service —
  reconnecting clients are fast-forwarded from the persisted log, so nothing is
  lost.
- On Windows, stop the service, replace the `.exe`, and start it again.
