# blitzy-slack — Makefile: the single command surface (Rule 5).
# Every Docker, pnpm, Prisma, and Playwright operation routes through a target
# below. Run `make help` for the list. Rationale lives in /docs/decision-log.md.

.DEFAULT_GOAL := help

# Keep recursive $(MAKE) output clean (suppress "Entering directory" noise).
MAKEFLAGS += --no-print-directory

# Load a root .env when present and export it, so DATABASE_URL / REDIS_URL /
# VITE_API_URL / POSTGRES_* reach every recipe shell, docker compose, and tsx.
ifneq (,$(wildcard .env))
include .env
export
endif

# Workspace package names — MUST match the "name" field in each package.json.
PKG_DB  := @app/db
PKG_API := @app/api
PKG_WEB := @app/web

.PHONY: help install up local dev build test test-e2e lint format typecheck migrate seed db-studio down clean

help: ## Show all available targets
	@echo "blitzy-slack — available make targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "} {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install all workspace dependencies via pnpm
	@echo "→ Installing workspace dependencies..."
	@pnpm install

up: ## Start PostgreSQL 16 + Redis 7 via Docker (waits for healthy)
	@echo "→ Starting Docker services (Postgres 16 + Redis 7)..."
	@docker compose up -d --wait

local: ## Full local bring-up: Docker -> install -> migrate -> seed -> dev servers
	@echo "→ Bringing up blitzy-slack locally..."
	@$(MAKE) up
	@$(MAKE) install
	@$(MAKE) migrate
	@echo "→ Starting API dev server in the background (logs: /tmp/blitzy-slack-api.log)..."
	@pnpm --filter $(PKG_API) dev > /tmp/blitzy-slack-api.log 2>&1 & echo $$! > /tmp/blitzy-slack-api.pid
	@echo "→ Waiting for $${VITE_API_URL:-http://localhost:3000}/api/health ..."
	@for i in $$(seq 1 60); do \
		if curl -sf "$${VITE_API_URL:-http://localhost:3000}/api/health" > /dev/null 2>&1; then \
			echo "→ API is healthy."; \
			break; \
		fi; \
		if [ $$i -eq 60 ]; then \
			echo "→ API did not become healthy in time. See /tmp/blitzy-slack-api.log"; \
			exit 1; \
		fi; \
		sleep 1; \
	done
	@$(MAKE) seed
	@echo "→ Starting web dev server (Ctrl+C to stop)..."
	@pnpm --filter $(PKG_WEB) dev

dev: local ## Alias for `make local`

build: ## Build every workspace package for production
	@echo "→ Building all packages..."
	@pnpm -r build

test: ## Run Jest unit tests across packages plus the Playwright E2E suite
	@echo "→ Running unit tests (Jest)..."
	@pnpm -r --if-present test
	@echo "→ Running E2E tests (Playwright)..."
	@pnpm exec playwright test

test-e2e: ## Run the Playwright E2E suite only
	@echo "→ Running E2E tests (Playwright)..."
	@pnpm exec playwright test

lint: ## Lint all workspaces with zero warnings allowed (Rule 3)
	@echo "→ Linting (--max-warnings 0 per Rule 3)..."
	@pnpm exec eslint . --max-warnings 0

format: ## Format the repository with Prettier
	@echo "→ Formatting with Prettier..."
	@pnpm exec prettier --write .

typecheck: ## Type-check every workspace package (tsc --noEmit)
	@echo "→ Type-checking all packages..."
	@pnpm -r --if-present typecheck

migrate: ## Apply all Prisma migrations to the database
	@echo "→ Applying Prisma migrations..."
	@pnpm --filter $(PKG_DB) exec prisma migrate deploy

seed: ## Seed the test user via POST /api/auth/register (Rule 4)
	@echo "→ Seeding test user via API (admin@test.com)..."
	@pnpm exec tsx scripts/seed-via-api.ts

db-studio: ## Open Prisma Studio against the dev database
	@echo "→ Opening Prisma Studio..."
	@pnpm --filter $(PKG_DB) exec prisma studio

down: ## Stop the Docker Compose services
	@echo "→ Stopping Docker services..."
	@docker compose down

clean: down ## Stop Docker, then remove node_modules, build artifacts, and uploads
	@echo "→ Removing dependencies and build artifacts..."
	@find . -name 'node_modules' -type d -prune -exec rm -rf '{}' +
	@find . -name 'dist' -type d -prune -exec rm -rf '{}' +
	@find . -name 'coverage' -type d -prune -exec rm -rf '{}' +
	@rm -rf uploads packages/api/uploads playwright-report test-results
	@echo "→ Clean complete."
