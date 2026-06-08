# blitzy-slack

A self-hosted **Slack clone** proof-of-concept: a real-time team chat web application that
mirrors Slack's web UI. It implements email/password authentication, public and private
channels, direct messages, message threads, emoji reactions, file sharing, full-text search,
user presence, and paginated message history — with every new message, reaction, typing
indicator, and presence change delivered live over WebSockets.

The whole stack runs locally with a single command, `make local`, which brings up PostgreSQL
and Redis via Docker Compose, applies database migrations, seeds a test user through the
registration API, and starts the API and web servers.

## Stack

- **Web** — React 19, Vite 6, Tailwind CSS v4, shadcn/ui
- **API** — Express 5, Socket.io 4.8 (Redis adapter), Prisma 6
- **Data** — PostgreSQL 16, Redis 7
- **Tooling** — pnpm workspaces, TypeScript (strict), ESLint, Jest, Playwright

See the repository `README.md` for the quickstart and Make-target reference, and
[`decision-log.md`](decision-log.md) for the rationale behind non-trivial implementation
decisions.
