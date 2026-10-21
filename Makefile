# Switchboard — unified build/test/run/deploy
# Run `make help` for a summary of targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# GNU sed (Linux) and BSD sed (macOS) both accept an attached backup suffix on
# `-i` (they disagree on the empty-suffix form), so edit with `.bak` and clean
# it up in the same recipe line.
SED_INPLACE := sed -i.bak

CARGO ?= cargo
NPM ?= npm
SERVER_BIN ?= switchboard-server
LINUX_TARGET ?= x86_64-unknown-linux-musl
LINUX_LINKER ?= $(CURDIR)/scripts/zig-cc
LINUX_LINKER_ENV = CARGO_TARGET_$(shell echo $(LINUX_TARGET) | tr 'a-z-' 'A-Z_')_LINKER
LINUX_CC_ENV = CC_$(shell echo $(LINUX_TARGET) | tr '-' '_')
LINUX_AR_ENV = AR_$(shell echo $(LINUX_TARGET) | tr '-' '_')
ZIG_TARGET = $(subst -unknown-,-,$(LINUX_TARGET))
# Windows cross-build. `gnullvm` rather than `gnu` because zig's bundled mingw is
# ucrt/lld-based, so the same zig that cross-builds Linux also links a native
# .exe. The server needs nothing else; the client additionally needs mingw-w64's
# windres, the only resource compiler tauri-build knows how to drive off-Windows.
WINDOWS_TARGET ?= x86_64-pc-windows-gnullvm
WINDOWS_LINKER ?= $(CURDIR)/scripts/zig-cc
WINDOWS_LINKER_ENV = CARGO_TARGET_$(shell echo $(WINDOWS_TARGET) | tr 'a-z-' 'A-Z_')_LINKER
WINDOWS_CC_ENV = CC_$(shell echo $(WINDOWS_TARGET) | tr '-' '_')
WINDOWS_AR_ENV = AR_$(shell echo $(WINDOWS_TARGET) | tr '-' '_')
WINDOWS_ZIG_TARGET = x86_64-windows-gnu
# One cross-build environment shared by the server and the Tauri client shell.
WINDOWS_CROSS_ENV = ZIG_TARGET=$(WINDOWS_ZIG_TARGET) \
  $(WINDOWS_LINKER_ENV)=$(WINDOWS_LINKER) \
  $(WINDOWS_CC_ENV)=$(WINDOWS_LINKER) \
  $(WINDOWS_AR_ENV)=$(CURDIR)/scripts/zig-ar
# Raw cargo artifact name for the client shell (`tauri build --no-bundle` leaves
# the binary under the crate's target dir rather than renaming it to productName).
CLIENT_WINDOWS_BIN ?= switchboard-client.exe
SERVER_ADDR ?= 127.0.0.1:8787
SERVER_TOKEN ?= dev-token
SERVER_DATA ?= server/data/switchboard.db
# Repeater mode: a stable-IP relay (REPEATER_ADDR is the worker-facing leg) that
# forwards client traffic to one worker that dials out. REPEATER_CA is the PEM
# whose leaf cert the dialing worker pins (the repeater's own cert by default).
REPEATER_ADDR ?= 127.0.0.1:8788
REPEATER_TOKEN ?= dev-repeater-token
REPEATER_CA ?= server/data/switchboard-cert.pem
REPEATER_DATA ?= server/data/switchboard-worker.db

# `make set-version x.y.z` — the version is a positional extra goal, so lift it
# out of MAKECMDGOALS and give it a no-op rule of its own (otherwise make fails
# with "no rule to make target 'x.y.z'").
ifneq (,$(filter set-version,$(MAKECMDGOALS)))
VERSION := $(word 2,$(MAKECMDGOALS))
ifneq (,$(VERSION))
$(VERSION):
	@:
endif
endif

# ---------------------------------------------------------------- meta
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- setup
.PHONY: setup setup-server setup-server-linux setup-server-windows setup-client setup-client-windows setup-e2e
setup: setup-server setup-client setup-e2e ## Install all toolchains/deps
setup-server: ## Fetch Rust deps
	$(CARGO) fetch
setup-server-linux: ## Install Rust target + check linker for Linux cross-builds
	rustup target add $(LINUX_TARGET)
	@command -v zig >/dev/null || { echo "zig not found. Install: brew install zig"; exit 1; }
setup-server-windows: ## Install Rust target + check linker for Windows cross-builds
	rustup target add $(WINDOWS_TARGET)
	@command -v zig >/dev/null || { echo "zig not found. Install: brew install zig"; exit 1; }
setup-client: ## Install client node deps
	cd client && $(NPM) install
setup-client-windows: ## Install Rust target + check linker/resource compiler for Windows client cross-builds
	rustup target add $(WINDOWS_TARGET)
	@command -v zig >/dev/null || { echo "zig not found. Install: brew install zig"; exit 1; }
	@command -v x86_64-w64-mingw32-windres >/dev/null \
	  || { echo "x86_64-w64-mingw32-windres not found (embeds the icon + version resource). Install: brew install mingw-w64"; exit 1; }
setup-e2e: ## Install e2e harness deps
	cd e2e && $(NPM) install

# ---------------------------------------------------------------- build
.PHONY: build build-server build-server-linux build-server-windows build-client build-client-windows build-shared
build: build-server build-client ## Build everything
build-shared: ## Build shared protocol crate + emit TS bindings into client/src/protocol
	TS_RS_EXPORT_DIR="$(CURDIR)" $(CARGO) test -p switchboard-shared
build-server: ## Build the hosting service (release)
	$(CARGO) build -p switchboard-server --release
build-server-linux: ## Cross-compile a static server for Linux (needs zig: brew install zig)
	ZIG_TARGET=$(ZIG_TARGET) \
	$(LINUX_LINKER_ENV)=$(LINUX_LINKER) \
	$(LINUX_CC_ENV)=$(LINUX_LINKER) \
	$(LINUX_AR_ENV)=$(CURDIR)/scripts/zig-ar \
	RUSTFLAGS="$${RUSTFLAGS:-} -C link-self-contained=no" \
	$(CARGO) build -p switchboard-server --release --target $(LINUX_TARGET)
build-server-windows: ## Cross-compile the server .exe for Windows (needs zig: brew install zig)
	$(WINDOWS_CROSS_ENV) \
	$(CARGO) build -p switchboard-server --release --target $(WINDOWS_TARGET)
build-client: build-shared ## Build the Tauri client
	cd client && $(NPM) install --silent && $(NPM) run build
build-client-windows: build-shared ## Cross-compile the desktop client .exe for Windows (portable, no installer)
	cd client && $(NPM) install --silent && \
	$(WINDOWS_CROSS_ENV) \
	$(NPM) exec -- tauri build --target $(WINDOWS_TARGET) --no-bundle

# ---------------------------------------------------------------- run
.PHONY: run-server run-client
run-server: ## Run hosting service (SERVER_ADDR, SERVER_TOKEN, SERVER_DATA overridable)
	SWITCHBOARD_ADDR=$(SERVER_ADDR) \
	SWITCHBOARD_TOKEN=$(SERVER_TOKEN) \
	SWITCHBOARD_DB=$(SERVER_DATA) \
	RUST_LOG=$${RUST_LOG:-info} \
	$(CARGO) run -p switchboard-server
run-client: build-shared ## Run the Tauri client in dev mode
	cd client && $(NPM) run tauri dev
run-repeater: ## Run a repeater relay (client-facing SERVER_ADDR + worker-facing REPEATER_ADDR, HTTPS)
	SWITCHBOARD_MODE=repeater \
	SWITCHBOARD_ADDR=$(SERVER_ADDR) \
	SWITCHBOARD_TOKEN=$(SERVER_TOKEN) \
	SWITCHBOARD_REPEATER_ADDR=$(REPEATER_ADDR) \
	SWITCHBOARD_REPEATER_TOKEN=$(REPEATER_TOKEN) \
	RUST_LOG=$${RUST_LOG:-info} \
	$(CARGO) run -p switchboard-server
run-repeater-client: ## Run a worker that dials out to a repeater (no client-facing bind; pins REPEATER_CA)
	SWITCHBOARD_REPEATER_ADDR=$(REPEATER_ADDR) \
	SWITCHBOARD_REPEATER_TOKEN=$(REPEATER_TOKEN) \
	SWITCHBOARD_REPEATER_CA=$(REPEATER_CA) \
	SWITCHBOARD_DB=$(REPEATER_DATA) \
	RUST_LOG=$${RUST_LOG:-info} \
	$(CARGO) run -p switchboard-server

# ---------------------------------------------------------------- test
.PHONY: test test-all test-shared test-server test-client test-client-native test-e2e test-upgrade test-web test-live
test: test-shared test-server test-client test-client-native ## Run all fast (non-live, non-e2e) tests
test-all: test test-e2e test-upgrade test-web ## Run everything incl. end-to-end + browser tests
test-shared: ## Test shared protocol crate (also regenerates TS bindings)
	TS_RS_EXPORT_DIR="$(CURDIR)" $(CARGO) test -p switchboard-shared
test-server: ## Test hosting service
	$(CARGO) test -p switchboard-server
test-client: ## Test client (vitest)
	cd client && $(NPM) test --silent
test-client-native: ## Test desktop bridge (cargo)
	@# The root workspace is only shared + server, so test-server never reaches this.
	cd client/src-tauri && $(CARGO) test
test-e2e: ## End-to-end: real server binary + WS clients + fake PTY agent (gap-free reconnect)
	$(CARGO) build -p switchboard-server
	cd e2e && $(NPM) install --silent && $(NPM) test
test-upgrade: ## End-to-end: real self-upgrades (upload + re-exec) with a live WS client
	$(CARGO) build -p switchboard-server
	cd e2e && $(NPM) install --silent && $(NPM) run test:upgrade
test-web: ## Browser E2E (Playwright): live server + Vite + xterm terminal render/type/reconnect
	cd client && $(NPM) install --silent && $(NPM) exec -- playwright install chromium && $(NPM) run test:e2e
test-live: ## Run live agent-CLI tests (needs claude/qodercli auth)
	AGENT_LIVE=1 $(CARGO) test -p switchboard-server -- --ignored --nocapture

# ---------------------------------------------------------------- quality
.PHONY: fmt lint
fmt: ## Format Rust + client + e2e
	$(CARGO) fmt
	cd client/src-tauri && $(CARGO) fmt
	cd client && $(NPM) run fmt
	cd e2e && $(NPM) install --silent && $(NPM) run fmt
lint: ## Lint Rust (clippy + rustfmt) + client (tsc + eslint + prettier) + e2e
	$(CARGO) fmt --check
	cd client/src-tauri && $(CARGO) fmt --check
	cd client && $(NPM) run fmt:check
	cd client && $(NPM) run typecheck
	cd e2e && $(NPM) install --silent && $(NPM) run fmt:check && $(NPM) run lint
	$(CARGO) clippy --all-targets -- -D warnings
	cd client/src-tauri && $(CARGO) clippy --all-targets -- -D warnings
	cd client && $(NPM) run lint

# ---------------------------------------------------------------- release
.PHONY: set-version
set-version: ## Align every component to one version: make set-version x.y.z
	@test -n "$(VERSION)" || { echo "usage: make set-version x.y.z"; exit 1; }
	@echo "$(VERSION)" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+.-][0-9A-Za-z.+.-]*)?$$' \
	  || { echo "error: '$(VERSION)' is not valid semver"; exit 1; }
	@# Rust workspace (server + shared crates) + root Cargo.lock
	$(SED_INPLACE) '/^\[workspace\.package\]/,/^edition/s/^version = ".*"/version = "$(VERSION)"/' Cargo.toml && rm -f Cargo.toml.bak
	$(CARGO) metadata --format-version=1 >/dev/null
	@# Desktop client: package.json + package-lock.json
	cd client && $(NPM) version $(VERSION) --no-git-tag-version --allow-same-version --silent >/dev/null
	@# Tauri bundle version + shell crate + its Cargo.lock
	$(SED_INPLACE) 's/"version": "[^"]*"/"version": "$(VERSION)"/' client/src-tauri/tauri.conf.json && rm -f client/src-tauri/tauri.conf.json.bak
	$(SED_INPLACE) 's/^version = ".*"/version = "$(VERSION)"/' client/src-tauri/Cargo.toml && rm -f client/src-tauri/Cargo.toml.bak
	cd client/src-tauri && $(CARGO) metadata --format-version=1 >/dev/null
	@echo "All components set to $(VERSION) — review with: git diff"

# ---------------------------------------------------------------- deploy
.PHONY: package-server package-server-linux package-server-windows package-client package-client-windows clean distclean
package-server: build-server ## Produce a self-contained server release artifact
	@mkdir -p dist
	cp target/release/$(SERVER_BIN) dist/ 2>/dev/null || true
	@echo "Server binary staged in ./dist"
package-server-linux: build-server-linux ## Produce a Linux server release artifact
	@mkdir -p dist
	cp target/$(LINUX_TARGET)/release/$(SERVER_BIN) dist/$(SERVER_BIN)-linux
	@echo "Linux server binary staged in ./dist/$(SERVER_BIN)-linux"
package-server-windows: build-server-windows ## Produce a Windows server release artifact
	@mkdir -p dist
	cp target/$(WINDOWS_TARGET)/release/$(SERVER_BIN).exe dist/$(SERVER_BIN).exe
	@echo "Windows server binary staged in ./dist/$(SERVER_BIN).exe"
package-client: build-client ## Package the desktop client as a DMG
	@# bundle_dmg.sh styles the DMG window with an AppleScript that macOS TCC
	@# denies outside an authorized terminal (-1743 "not authorized to send
	@# Apple events to Finder"), and Tauri swallows the script's stderr so the
	@# target just fails with "error running bundle_dmg.sh". Detecting CI makes
	@# Tauri pass --skip-jenkins, skipping that step. tauri.conf.json sets no DMG
	@# background, window size or icon positions, so nothing is lost.
	cd client && CI=true $(NPM) run tauri build
	@rm -fr client/src-tauri/target/release/bundle/macos/*.app
	@mkdir -p ./dist && mv client/src-tauri/target/release/bundle/dmg/*.dmg ./dist/
	@echo "Moved bundle to: $$(ls -t dist/*.dmg | head -1)"
package-client-windows: build-client-windows ## Produce a portable Windows client artifact
	@mkdir -p dist
	cp client/src-tauri/target/$(WINDOWS_TARGET)/release/$(CLIENT_WINDOWS_BIN) dist/Switchboard.exe
	@# Non-MSVC builds of webview2-com-sys import the loader dynamically, so the
	@# DLL it extracted from the WebView2 SDK has to travel next to the .exe.
	cp "$$(find client/src-tauri/target/$(WINDOWS_TARGET)/release/build -path '*webview2-com-sys*/out/x64/WebView2Loader.dll' | head -1)" dist/
	@echo "Windows client staged in ./dist: Switchboard.exe + WebView2Loader.dll"
clean: ## Remove build artifacts (keeps fetched deps)
	$(CARGO) clean
	cd client/src-tauri && $(CARGO) clean
	rm -rf client/dist dist
	rm -rf client/test-results client/playwright-report client/tests-e2e/.server.json
distclean: clean ## Also remove fetched dependencies (node_modules)
	rm -rf client/node_modules e2e/node_modules
