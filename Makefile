SHELL := /bin/bash
.DEFAULT_GOAL := help

# Load .env if present so DATABASE_URL/REDIS_URL/etc. are available to targets.
ifneq (,$(wildcard ./.env))
include .env
export
endif

PORT ?= 3000
API_HEALTH_URL ?= http://localhost:$(PORT)/api/health

.PHONY: help local up down clean install migrate seed build lint format typecheck test test-e2e

help: ## Show available targets
	@echo "blitzy-slack — make targets:"
	@echo "  make local      Full local bring-up: docker up -> install -> migrate -> seed -> dev servers"
	@echo "  make up         Start PostgreSQL 16 + Redis 7 (docker compose, waits for healthy)"
	@echo "  make down       Stop docker services"
	@echo "  make clean      down + remove node_modules, dist, uploads, coverage, reports"
	@echo "  make install    pnpm install (workspace)"
	@echo "  make migrate    prisma migrate deploy (@app/db)"
	@echo "  make seed       Seed admin@test.com via POST /api/auth/register"
	@echo "  make build      Build all packages"
	@echo "  make lint       eslint --max-warnings 0"
	@echo "  make format     prettier --write"
	@echo "  make typecheck  tsc --noEmit across packages"
	@echo "  make test       Unit tests (jest)"
	@echo "  make test-e2e   Playwright E2E"

up: ## Start infra (Postgres + Redis)
	docker compose up -d --wait

down: ## Stop infra
	docker compose down

clean: down ## Remove installed deps and build artifacts
	rm -rf node_modules packages/*/node_modules dist packages/*/dist \
		packages/api/uploads uploads coverage packages/*/coverage \
		playwright-report test-results

install: ## Install workspace dependencies
	pnpm install

migrate: up ## Apply database migrations
	pnpm --filter @app/db exec prisma migrate deploy

seed: ## Seed the test user via the registration flow (Rule 4)
	pnpm tsx scripts/seed-via-api.ts

build: ## Build every package
	pnpm -r build

lint: ## Lint with zero-warning policy (Rule 3)
	pnpm lint

format: ## Format with prettier
	pnpm format

typecheck: ## Typecheck all packages
	pnpm typecheck

test: ## Run unit tests
	pnpm -r --if-present test

test-e2e: ## Run Playwright E2E tests
	pnpm exec playwright test

local: up install migrate ## End-to-end local bring-up (Rule 5)
	@echo "==> Starting API dev server (background) and waiting for health..."
	pnpm --filter @app/api dev & \
	API_PID=$$!; \
	for i in $$(seq 1 60); do \
		if curl -sf "$(API_HEALTH_URL)" >/dev/null 2>&1; then echo "==> API healthy"; break; fi; \
		sleep 2; \
	done; \
	$(MAKE) seed || true; \
	echo "==> Starting web dev server..."; \
	pnpm --filter @app/web dev
