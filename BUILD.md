# Switchboard — Building & Testing

How to produce release artifacts (hosting service and desktop client),
cross-compile from any dev machine, run the test suites, and regenerate the app
icon. Toolchains are listed under [Prerequisites](DEPLOY.md#prerequisites).

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
Self-upgrade works here too — see [Upgrading](DEPLOY.md#upgrading); it needs the
service to be registered so the manager restarts it, because Windows cannot
re-exec.

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

## Testing
```bash
make test          # fast: shared + server + client unit/integration tests
make test-e2e      # full stack: real server + WS clients + fake PTY agent
make test-upgrade  # real self-upgrades (upload + re-exec) with a live WS client
make test-web      # browser E2E (Playwright): live server + Vite + xterm terminal
make test-all      # test + test-e2e + test-upgrade + test-web
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
  the terminal bytes it missed — gap-free, no loss, no duplicates.
- **Upgrade E2E** (`make test-upgrade`) performs a real self-upgrade (upload +
  re-exec/swap) with a live WebSocket client attached, and requires the task to
  still be running, and still answering input, under its replacement.
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
