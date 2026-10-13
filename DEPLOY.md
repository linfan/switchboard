# Switchboard — Quick Start & Deployment

How to configure and run Switchboard, install the hosting service on a host,
and register it as a system service on **Linux (systemd)**, **Windows (nssm)**,
and **macOS (launchd)**. For release builds, cross-compiles, and the test suites
see [BUILD.md](BUILD.md); the full environment-variable reference is in
[Configuration](#configuration) below.

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
[Transport security (`SWB-v1`)](ARCHITECTURE.md#transport-security-swb-v1).

### TLS & certificates

HTTPS is on by default. When the cert/key files are absent the server
generates a self-signed certificate (ECDSA P-256, ~13-month validity); the
`SWITCHBOARD_TLS_SAN` entries (plus `localhost` and local interface addresses)
become its SANs, which matters only if you later trust it in a browser. The
desktop client **pins** the self-signed leaf on first add (hostname ignored), so
no CA trust step is needed there. To terminate TLS yourself (reverse proxy, real
CA cert), set `SWITCHBOARD_TLS=0` and run the proxy in front.

Networking: the desktop client performs REST and WebSocket I/O in its native
(Rust) layer rather than the webview, using **rustls with a pinning verifier** —
it reaches self-signed hosts (which the webview's fetch/WebSocket would reject)
while still authenticating the channel by the captured leaf-cert fingerprint, so
an active MITM is rejected on pin mismatch.

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

## Installing on a server host

The server is a single self-contained binary (see [BUILD.md](BUILD.md) for
building one); only the binary and its state (SQLite DB, generated TLS cert/key,
logs) need a home.

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
variables, point the service manager at the binary, and enable auto-restart.
Logs go to stdout by default; under a service manager either read them from the
manager's journal/event log, or set `SWITCHBOARD_LOG` for size-based rolling
files — see [Log file rotation](#log-file-rotation-switchboard_log).

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
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/switchboard/bin
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
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

> `Restart=always`, not `on-failure`: systemd counts `SIGHUP`, `SIGINT`,
> `SIGTERM`, and `SIGPIPE` as *successful* termination for non-oneshot
> services, so a service killed by SIGPIPE would never be restarted by
> `on-failure`.

Enable and control it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now switchboard      # start now + on every boot
systemctl status switchboard                 # health check
journalctl -u switchboard -f                 # follow logs
```

To repeat the same for a **repeater** or a **dial-out worker**, register a second
unit with that role's variables instead (see
[Configuration](#configuration)).

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
nssm set Switchboard AppEnvironmentExtra SWITCHBOARD_ADDR=0.0.0.0:8787 SWITCHBOARD_TOKEN=choose-a-strong-token SWITCHBOARD_DB="C:\ProgramData\Switchboard\switchboard.db" SWITCHBOARD_TLS_CERT="C:\ProgramData\Switchboard\switchboard-cert.pem" SWITCHBOARD_TLS_KEY="C:\ProgramData\Switchboard\switchboard-key.pem" "SWITCHBOARD_LOG=C:\ProgramData\Switchboard\logs\switchboard.log|100mb*5" RUST_LOG=info "PATH=C:\Program Files\Git;%SystemRoot%\System32;%SystemRoot%"
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
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
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
