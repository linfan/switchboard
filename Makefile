# Switchboard — unified build/test/run/deploy
# Run `make help` for a summary of targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

CARGO ?= cargo
NPM ?= npm
SERVER_BIN ?= switchboard-server
LINUX_TARGET ?= x86_64-unknown-linux-musl
LINUX_LINKER ?= $(CURDIR)/scripts/zig-cc
LINUX_LINKER_ENV = CARGO_TARGET_$(shell echo $(LINUX_TARGET) | tr 'a-z-' 'A-Z_')_LINKER
LINUX_CC_ENV = CC_$(shell echo $(LINUX_TARGET) | tr '-' '_')
LINUX_AR_ENV = AR_$(shell echo $(LINUX_TARGET) | tr '-' '_')
ZIG_TARGET = $(subst -unknown-,-,$(LINUX_TARGET))
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

# ---------------------------------------------------------------- meta
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- setup
.PHONY: setup setup-server setup-server-linux setup-client setup-e2e
setup: setup-server setup-client setup-e2e ## Install all toolchains/deps
setup-server: ## Fetch Rust deps
	$(CARGO) fetch
setup-server-linux: ## Install Rust target + check linker for Linux cross-builds
	rustup target add $(LINUX_TARGET)
	@command -v zig >/dev/null || { echo "zig not found. Install: brew install zig"; exit 1; }
setup-client: ## Install client node deps
	cd client && $(NPM) install
setup-e2e: ## Install e2e harness deps
	cd e2e && $(NPM) install

# ---------------------------------------------------------------- build
.PHONY: build build-server build-server-linux build-client build-shared
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
build-client: build-shared ## Build the Tauri client
	cd client && $(NPM) install --silent && $(NPM) run build

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
.PHONY: test test-all test-shared test-server test-client test-e2e test-web test-live
test: test-shared test-server test-client ## Run all fast (non-live, non-e2e) tests
test-all: test test-e2e test-web ## Run everything incl. end-to-end + browser tests
test-shared: ## Test shared protocol crate (also regenerates TS bindings)
	TS_RS_EXPORT_DIR="$(CURDIR)" $(CARGO) test -p switchboard-shared
test-server: ## Test hosting service
	$(CARGO) test -p switchboard-server
test-client: ## Test client (vitest)
	cd client && $(NPM) test --silent
test-e2e: ## End-to-end: real server binary + WS clients + fake PTY agent (gap-free reconnect)
	$(CARGO) build -p switchboard-server
	cd e2e && $(NPM) install --silent && $(NPM) test
test-web: ## Browser E2E (Playwright): live server + Vite + xterm terminal render/type/reconnect
	cd client && $(NPM) install --silent && $(NPM) exec -- playwright install chromium && $(NPM) run test:e2e
test-live: ## Run live agent-CLI tests (needs claude/qodercli auth)
	AGENT_LIVE=1 $(CARGO) test -p switchboard-server -- --ignored --nocapture

# ---------------------------------------------------------------- quality
.PHONY: fmt lint
fmt: ## Format Rust + client
	$(CARGO) fmt
	cd client && $(NPM) run fmt --if-present
lint: ## Lint Rust (clippy) + client
	$(CARGO) clippy --all-targets -- -D warnings
	cd client && $(NPM) run lint --if-present

# ---------------------------------------------------------------- deploy
.PHONY: package-server package-server-linux package-client clean distclean
package-server: build-server ## Produce a self-contained server release artifact
	@mkdir -p dist
	cp target/release/$(SERVER_BIN) dist/ 2>/dev/null || true
	@echo "Server binary staged in ./dist"
package-server-linux: build-server-linux ## Produce a Linux server release artifact
	@mkdir -p dist
	cp target/$(LINUX_TARGET)/release/$(SERVER_BIN) dist/$(SERVER_BIN)-linux
	@echo "Linux server binary staged in ./dist/$(SERVER_BIN)-linux"
package-client: build-client ## Package the desktop client (Tauri bundles)
	cd client && $(NPM) run tauri build
clean: ## Remove build artifacts (keeps fetched deps)
	$(CARGO) clean
	cd client/src-tauri && $(CARGO) clean
	rm -rf client/dist dist
	rm -rf client/test-results client/playwright-report client/tests-e2e/.server.json
distclean: clean ## Also remove fetched dependencies (node_modules)
	rm -rf client/node_modules e2e/node_modules
