/**
 * Prisma `db seed` delegate.
 *
 * Invoked by the Prisma CLI when it runs `prisma db seed` (the command is
 * resolved from the `prisma.seed` field in `packages/db/package.json`, which is
 * `"tsx prisma/seed.ts"`). To satisfy Rule 4 (AAP §0.8.1), the seed test user
 * is created exclusively through `POST /api/auth/register`, never by a direct
 * database INSERT — so this delegate performs no database access of its own,
 * holds no credentials, and never instantiates a database client. The seed
 * credentials live solely in the root script (the single source of truth).
 *
 * The single source of truth for the seed operation lives at
 * `scripts/seed-via-api.ts` (also invoked directly by `make seed`). This file
 * launches that script as a `tsx` child process and propagates the child's
 * exit status, so the Prisma-driven seed path and the Makefile seed path share
 * identical behaviour.
 *
 * Rationale and trade-offs for the spawn-based delegation are recorded in
 * `docs/decision-log.md` (Explainability rule, AAP §0.8.3); they are
 * intentionally not duplicated in these comments.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Absolute path to the root seed script. `import.meta.url` is resolved to a
 * filesystem path and walked three directories up (prisma → db → packages →
 * repo root) so the target resolves correctly no matter which working
 * directory the Prisma CLI invokes the seed from.
 */
const ROOT_SEED_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
  'seed-via-api.ts',
);

/**
 * Spawns `tsx scripts/seed-via-api.ts` as a child process and resolves with its
 * numeric exit code (or rejects if the process could not be spawned or was
 * killed by a signal). `stdio: 'inherit'` streams the child's seed progress and
 * errors straight through to the developer; `env: process.env` forwards the
 * loaded environment (e.g. `VITE_API_URL`) that tells the script where the API
 * lives.
 */
function main(): Promise<number> {
  return new Promise<number>((resolveExit, rejectExit) => {
    const child = spawn('tsx', [ROOT_SEED_SCRIPT], {
      stdio: 'inherit',
      env: process.env,
      shell: false,
    });

    child.on('error', (err: Error) => {
      rejectExit(err);
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (signal !== null) {
        rejectExit(new Error(`Seed script terminated by signal ${signal}`));
        return;
      }
      resolveExit(code ?? 0);
    });
  });
}

try {
  const exitCode = await main();
  process.exit(exitCode);
} catch (err) {
  console.error('[prisma db seed] Delegate failed:', err);
  process.exit(1);
}
