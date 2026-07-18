# Switchboard — unified build/test/run/deploy
# Run `make help` for a summary of targets.

SHELL := /bin/bash
.DEFAULT_GOAL := help

CARGO ?= cargo
NPM ?= npm
SERVER_BIN ?= switchboard-server
SERVER_ADDR ?= 127.0.0.1:8787
SERVER_TOKEN ?= dev-token
SERVER_DATA ?= server/data/switchboard.db

# ---------------------------------------------------------------- meta
.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ---------------------------------------------------------------- setup
.PHONY: setup setup-server setup-client setup-e2e
setup: setup-server setup-client setup-e2e ## Install all toolchains/deps
setup-server: ## Fetch Rust deps
	$(CARGO) fetch
setup-client: ## Install client node deps
	cd client && $(NPM) install
setup-e2e: ## Install e2e harness deps
	cd e2e && $(NPM) install

# ---------------------------------------------------------------- build
.PHONY: build build-server build-client build-shared
build: build-server build-client ## Build everything
build-shared: ## Build shared protocol crate + emit TS bindings into client/src/protocol
	TS_RS_EXPORT_DIR="$(CURDIR)" $(CARGO) test -p switchboard-shared
build-server: ## Build the hosting service (release)
	$(CARGO) build -p switchboard-server --release
build-client: build-shared ## Build the Tauri client
	cd client && $(NPM) run build

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
.PHONY: package-server package-client clean
package-server: build-server ## Produce a self-contained server release artifact
	@mkdir -p dist
	cp target/release/$(SERVER_BIN) dist/ 2>/dev/null || true
	@echo "Server binary staged in ./dist"
package-client: build-client ## Package the desktop client (Tauri bundles)
	cd client && $(NPM) run tauri build
clean: ## Remove build artifacts
	$(CARGO) clean
	cd client/src-tauri && $(CARGO) clean
	rm -rf client/dist client/node_modules e2e/node_modules dist
	rm -rf client/test-results client/playwright-report client/tests-e2e/.server.json
