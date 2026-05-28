# Blitzy Slack

A Slack-clone proof-of-concept demonstrating real-time team messaging with channels, direct messages, threads, reactions, file sharing, full-text search, and presence — runnable end-to-end with a single command.

## Status

This project is an **experimental** proof-of-concept (see `lifecycle: experimental` in [`catalog-info.yaml`](catalog-info.yaml)) intended for **local demonstration only — it is not hardened for production**. Development follows the Agent Action Plan (AAP) and the Explainability rule: every non-trivial decision is captured in [`docs/decision-log.md`](docs/decision-log.md) rather than in code comments.

## Quickstart

```bash
git clone https://github.com/Blitzy-Sandbox/blitzy-slack.git
cd blitzy-slack
cp .env.example .env
make local
```

When `make local` completes, the API is reachable at <http://localhost:3000> and the web client at <http://localhost:5173>. Sign in with the seeded credentials below.

| Credential | Value            |
| ---------- | ---------------- |
| Email      | `admin@test.com` |
| Password   | `Password12345!` |

## Prerequisites

- **Docker** 24+ with Compose v2 — runs the PostgreSQL 16 and Redis 7 containers.
- **Node.js** 22 LTS — the version is pinned in `.nvmrc`.
- **pnpm** 9 — managed via Corepack: `corepack enable && corepack prepare pnpm@latest --activate`.
- **GNU make** — drives the single command interface described below.

## Make Targets

The root `Makefile` is the single command surface — every operation routes through `make`, so there is no need to memorize pnpm, prisma, docker, or playwright commands.

| Target           | What it does                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `make local`     | One-shot end-to-end local bring-up: Docker up → install → migrate → seed → start API and web dev servers. |
| `make up`        | Starts the PostgreSQL 16 and Redis 7 containers via Docker Compose and waits until they are healthy.      |
| `make down`      | Stops the Docker Compose services.                                                                        |
| `make clean`     | Stops services and removes `node_modules`, build outputs, `uploads/`, coverage, and test reports.         |
| `make install`   | Installs all workspace dependencies with pnpm.                                                            |
| `make migrate`   | Applies all Prisma migrations to the database.                                                            |
| `make seed`      | Seeds the test user via `POST /api/auth/register` (Rule 4).                                               |
| `make build`     | Builds every workspace package for production.                                                            |
| `make lint`      | Runs ESLint with `--max-warnings 0` across all workspaces (Rule 3).                                       |
| `make format`    | Formats all source files with Prettier.                                                                   |
| `make typecheck` | Type-checks every package with `tsc --noEmit`.                                                            |
| `make test`      | Runs the Jest unit and integration test suites across all packages.                                       |
| `make test-e2e`  | Runs the Playwright end-to-end suite.                                                                     |

Running `make` with no arguments (or `make help`) prints the full target list.

## Architecture Overview

```mermaid
graph TB
    Browser[Web Browser]
    Web[packages/web<br/>React 19 + Vite 6<br/>shadcn/ui + Tailwind v4]
    API[packages/api<br/>Express 5 + Socket.io 4.8<br/>Pino logger]
    Shared[packages/shared<br/>Types + Zod schemas]
    DBPkg[packages/db<br/>Prisma 6 schema + client]
    PG[(PostgreSQL 16)]
    RD[(Redis 7)]
    FS[/FILE_UPLOAD_PATH<br/>local filesystem/]

    Browser -->|HTTPS / WS| Web
    Web -->|fetch /api/*| API
    Web -->|socket.io-client| API
    Web -. imports types and Zod .-> Shared
    API -. imports types and Zod .-> Shared
    API -->|Prisma queries| PG
    API -->|ioredis + adapter pub/sub| RD
    API -->|multer disk write/read| FS
    API -. Prisma client re-exported .-> DBPkg
    DBPkg -->|prisma migrate deploy| PG
```

The workspace is a pnpm monorepo of four packages: `packages/shared` is a dependency-free leaf of shared types and Zod schemas; `packages/db` owns the Prisma schema and client; `packages/api` is the Express + Socket.io server; and `packages/web` is the React client.

## Tech Stack

| Layer           | Choice                                              |
| --------------- | --------------------------------------------------- |
| Runtime         | Node.js 22 LTS                                      |
| Language        | TypeScript 5.7+ (strict)                            |
| Monorepo        | pnpm 9 workspaces                                   |
| API server      | Express 5 + Socket.io 4.8                           |
| Real-time       | Socket.io with `@socket.io/redis-adapter` (Rule 2)  |
| ORM             | Prisma 6 against PostgreSQL 16                      |
| Cache & pub/sub | Redis 7 (ioredis)                                   |
| Web framework   | React 19 + Vite 6 + React Router 7                  |
| UI primitives   | shadcn/ui (copy-paste) + Tailwind CSS v4            |
| Client state    | Zustand + TanStack Query 5                          |
| Validation      | Zod (shared client/server)                          |
| Auth            | JWT (HS256) over both HTTP and WebSocket handshakes |
| Logging         | Pino + pino-http                                    |
| Unit tests      | Jest                                                |
| E2E tests       | Playwright                                          |

## Repository Layout

```
blitzy-slack/
├── Makefile                  ← single command surface (Rule 5)
├── docker-compose.yml        ← Postgres 16 + Redis 7
├── pnpm-workspace.yaml
├── package.json              ← root manifest
├── tsconfig.base.json        ← strict TS config (Rule 3)
├── eslint.config.js          ← zero-warning lint (Rule 3)
├── playwright.config.ts
├── .env.example
├── packages/
│   ├── db/                   ← Prisma schema, migrations, client
│   ├── shared/               ← Types + Zod schemas (client + server)
│   ├── api/                  ← Express + Socket.io server
│   └── web/                  ← React + Vite client
├── scripts/
│   └── seed-via-api.ts       ← Rule 4 seed mechanism
├── docs/
│   ├── index.md
│   └── decision-log.md       ← Explainability rule (the "why")
└── screenshots/              ← 1,022 PNG reference UI specifications (Rule 1)
```

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` before running `make local`; the committed template ships with working local defaults. The core application variables are:

| Variable           | Purpose                                                       | Example                                                           |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `NODE_ENV`         | Runtime mode (`development`, `test`, or `production`)         | `development`                                                     |
| `DATABASE_URL`     | PostgreSQL connection string used by Prisma and the API       | `postgresql://slack:slack@localhost:5432/slack_dev?schema=public` |
| `REDIS_URL`        | Redis connection for the Socket.io adapter and presence cache | `redis://localhost:6379`                                          |
| `JWT_SECRET`       | HMAC secret for signing and verifying JWTs                    | 32+ random bytes — `openssl rand -hex 32`                         |
| `JWT_EXPIRES_IN`   | JWT token lifetime                                            | `7d`                                                              |
| `FILE_UPLOAD_PATH` | Directory for uploaded attachments                            | `./uploads`                                                       |
| `MAX_FILE_SIZE_MB` | Per-file upload cap, in megabytes                             | `10`                                                              |
| `VITE_API_URL`     | Web → API base URL                                            | `http://localhost:3000`                                           |
| `VITE_WS_URL`      | Web → Socket.io URL                                           | `http://localhost:3000`                                           |

The root `.env.example` additionally defines Docker and tooling variables with working defaults — `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`, `REDIS_PORT`, `API_PORT`, and `VITE_APP_URL`. See [`.env.example`](.env.example) for the complete annotated list.

## Testing

```bash
make test            # Jest unit + integration tests across packages
make test-e2e        # Playwright end-to-end suite
```

The coverage floor is ≥ 80 % line coverage on `packages/api/src/services/*` and `packages/shared/src/schemas/*`. The Playwright suite includes a screenshot-fidelity check that compares rendered pages against the reference screenshots in `screenshots/`.

## Visual Reference

The `screenshots/` directory contains 1,022 PNG captures of the Slack web UI (Mobbin, July 2024). They are the authoritative visual specification for every implemented screen (Rule 1). Features visible in the screenshots that are **not** in this PoC's scope (Lists, Canvas, Huddles, Apps marketplace, and similar) are intentionally excluded — see [`docs/decision-log.md`](docs/decision-log.md) for the scope rationale.

## Why Decisions Were Made the Way They Were

Every non-trivial implementation decision is recorded in [`docs/decision-log.md`](docs/decision-log.md). Rationale is **never** embedded in code comments — the decision log is the single source of truth. If you read the codebase and wonder "why this and not that?", the answer lives in the log.

## License & Contributing

This repository is a Blitzy sandbox proof-of-concept; ownership and lifecycle metadata are declared in [`catalog-info.yaml`](catalog-info.yaml).
