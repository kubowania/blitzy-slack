/**
 * @file packages/api/test/setup.ts
 *
 * Shared test infrastructure for all Jest suites in `packages/api/test/`.
 * Exports helpers, factories, and re-exports of shared resources (Prisma,
 * Redis) so every suite gets a consistent surface for setup and teardown.
 *
 * This module is imported explicitly by the integration suites
 * (`auth.test.ts`, `channels.test.ts`, `dms.test.ts`, `messages.test.ts`,
 * `files.test.ts`, `search.test.ts`, `socket.test.ts`) via `./setup.js`. It is
 * deliberately NOT matched by Jest's `testMatch` glob (it has no `.test.ts`
 * suffix) and is NOT wired as a `setupFiles` entry — importing it eagerly
 * opens Redis connections (config/redis.ts uses `lazyConnect: false`), so only
 * suites that own a `closeTestResources()` teardown should load it.
 *
 * Compliance:
 *   Rule 3  — strict TypeScript, zero ESLint warnings; no `@ts-ignore`.
 *   Rule 4  — `registerUser` creates users via `POST /api/auth/register`;
 *             this file never inserts users directly through Prisma.
 *   Gate 10 — Pino logs are not silenced; logger.ts owns dev/test formatting.
 *
 * Test database / environment strategy and the rationale for each non-trivial
 * choice are recorded in /docs/decision-log.md, not in these comments.
 */

// Establish the test runtime mode before the hoisted imports evaluate
// `config/env.ts`. `??` preserves an explicitly provided value (e.g. from CI).
process.env.NODE_ENV = process.env.NODE_ENV ?? 'test';

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import jwt, { type SignOptions } from 'jsonwebtoken';
import request from 'supertest';
import type { Application } from 'express';

import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { pubClient, subClient, redisClient, disconnectRedisClients } from '../src/config/redis.js';
import { prisma } from '@app/db';
import type { User } from '@app/shared/types/user';
import type { Channel } from '@app/shared/types/channel';
import type { DirectMessage } from '@app/shared/types/dm';
import { MAX_FILE_SIZE_BYTES } from '@app/shared/constants/limits';

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * Rule 4 seed credentials. The Makefile and scripts/seed-via-api.ts use the
 * same values; exported here for suites that exercise the seed flow.
 */
export const SEED_EMAIL = 'admin@test.com' as const;
export const SEED_PASSWORD = 'Password12345!' as const;

// -----------------------------------------------------------------------------
// Unique Generators
// -----------------------------------------------------------------------------

/** Returns a unique email like `test-1700000000000-abc12345@blitzy-slack.test`. */
export function uniqueEmail(): string {
  return `test-${Date.now()}-${randomBytes(4).toString('hex')}@blitzy-slack.test`;
}

/** Returns a unique displayName like `Test User abc123`. */
export function uniqueDisplayName(): string {
  return `Test User ${randomBytes(3).toString('hex')}`;
}

/**
 * Returns a unique channel name matching the channel-name pattern
 * `/^[a-z0-9_-]+$/` — Slack-style lowercase with hyphens.
 */
export function uniqueChannelName(): string {
  return `test-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

// -----------------------------------------------------------------------------
// File Buffers (for files.test.ts)
// -----------------------------------------------------------------------------

/** Minimal 8-byte PNG signature — enough for multer to accept and record. */
export function tinyPngBuffer(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

/** Zero-filled buffer exactly one byte over the upload limit (for 413 tests). */
export function oversizedBuffer(): Buffer {
  return Buffer.alloc(MAX_FILE_SIZE_BYTES + 1);
}

// -----------------------------------------------------------------------------
// App Factory
// -----------------------------------------------------------------------------

let cachedApp: Application | null = null;

/**
 * Returns the Express application instance, reused across a suite for speed.
 * supertest binds to the app object per request — no port is opened.
 */
export function createTestApp(): Application {
  cachedApp ??= createApp();
  return cachedApp;
}

// -----------------------------------------------------------------------------
// JWT Test Signer
// -----------------------------------------------------------------------------

export interface TestJwtPayload {
  sub: string;
  email: string;
}

/**
 * Signs a JWT for tests using the same algorithm and secret as production
 * (HS256, `env.JWT_SECRET`). Callers may override `expiresIn` — for example
 * `'-1s'` to produce an immediately-expired token for negative-path tests.
 */
export function signTestToken(
  payload: TestJwtPayload,
  options?: Pick<SignOptions, 'expiresIn'>,
): string {
  const expiresIn: SignOptions['expiresIn'] =
    options?.expiresIn ?? (env.JWT_EXPIRES_IN as SignOptions['expiresIn']);
  const signOptions: SignOptions = { algorithm: 'HS256', expiresIn };
  return jwt.sign({ sub: payload.sub, email: payload.email }, env.JWT_SECRET, signOptions);
}

// -----------------------------------------------------------------------------
// User Helpers (Rule 4 — via POST /api/auth/register)
// -----------------------------------------------------------------------------

export interface RegisteredUser {
  token: string;
  user: User;
}

export interface RegisterUserInput {
  email?: string;
  password?: string;
  displayName?: string;
}

/**
 * Rule 4 compliance: creates a user by POSTing to `/api/auth/register` via
 * supertest. This is the only path used to create test users — Prisma user
 * inserts are forbidden here. Unique defaults avoid collisions across parallel
 * suites.
 */
export async function registerUser(input: RegisterUserInput = {}): Promise<RegisteredUser> {
  const app = createTestApp();
  const body = {
    email: input.email ?? uniqueEmail(),
    password: input.password ?? 'StrongPassword123!',
    displayName: input.displayName ?? uniqueDisplayName(),
  };
  const response = await request(app).post('/api/auth/register').send(body);
  if (response.status !== 201) {
    throw new Error(
      `registerUser failed: status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }
  return response.body as RegisteredUser;
}

/**
 * Logs in via `POST /api/auth/login` and returns the freshly issued token plus
 * the user record.
 */
export async function loginUser(input: {
  email: string;
  password: string;
}): Promise<RegisteredUser> {
  const app = createTestApp();
  const response = await request(app).post('/api/auth/login').send(input);
  if (response.status !== 200) {
    throw new Error(
      `loginUser failed: status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }
  return response.body as RegisteredUser;
}

// -----------------------------------------------------------------------------
// Channel + DM Helpers
// -----------------------------------------------------------------------------

export interface CreateTestChannelInput {
  token: string;
  isPrivate: boolean;
  name?: string;
  description?: string;
}

/** Creates a channel via `POST /api/channels` and returns the created record. */
export async function createTestChannel(input: CreateTestChannelInput): Promise<Channel> {
  const app = createTestApp();
  const response = await request(app)
    .post('/api/channels')
    .set('Authorization', `Bearer ${input.token}`)
    .send({
      name: input.name ?? uniqueChannelName(),
      description: input.description,
      isPrivate: input.isPrivate,
    });
  if (response.status !== 201) {
    throw new Error(
      `createTestChannel failed: status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }
  return response.body as Channel;
}

export interface CreateTestDmInput {
  token: string;
  targetUserId: string;
}

/** Creates (or resolves) a 1:1 DM via `POST /api/dms` and returns the record. */
export async function createTestDm(input: CreateTestDmInput): Promise<DirectMessage> {
  const app = createTestApp();
  const response = await request(app)
    .post('/api/dms')
    .set('Authorization', `Bearer ${input.token}`)
    .send({ targetUserId: input.targetUserId });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(
      `createTestDm failed: status=${response.status} body=${JSON.stringify(response.body)}`,
    );
  }
  return response.body as DirectMessage;
}

// -----------------------------------------------------------------------------
// Database Cleanup
// -----------------------------------------------------------------------------

/**
 * Re-export of the Prisma client singleton for tests that need direct reads
 * (e.g. verifying ChannelMember side effects) or non-user seeds (Messages,
 * Reactions). Rule 4 forbids direct User inserts — never call
 * `prismaTest.user.create`.
 */
export const prismaTest = prisma;

/**
 * Removes all test data in dependency-safe order, then clears the uploads
 * directory. Intended for a `beforeEach` hook so each test starts clean.
 *
 * Deletion order (children before parents):
 *   MessageReaction → Message → ChannelMember → Channel →
 *   DMParticipant → DirectMessage → File → User
 */
export async function cleanDatabase(): Promise<void> {
  await prismaTest.messageReaction.deleteMany();
  await prismaTest.message.deleteMany();
  await prismaTest.channelMember.deleteMany();
  await prismaTest.channel.deleteMany();
  await prismaTest.dMParticipant.deleteMany();
  await prismaTest.directMessage.deleteMany();
  await prismaTest.file.deleteMany();
  await prismaTest.user.deleteMany();

  await clearUploadsDirectory();
}

/**
 * Removes every entry inside `FILE_UPLOAD_PATH` without deleting the directory
 * itself, so the upload destination always exists for the next test.
 */
async function clearUploadsDirectory(): Promise<void> {
  const uploadPath = env.FILE_UPLOAD_PATH;
  try {
    await mkdir(uploadPath, { recursive: true });
    const entries = await readdir(uploadPath);
    await Promise.all(
      entries.map((entry) => rm(join(uploadPath, entry), { recursive: true, force: true })),
    );
  } catch {
    // Ignore — the directory may not exist yet on the very first run.
  }
}

// -----------------------------------------------------------------------------
// Redis Cleanup & Re-exports
// -----------------------------------------------------------------------------

/**
 * Re-export the Redis clients for tests (notably socket.test.ts, which wires
 * the Socket.io Redis adapter from `pubClient`/`subClient` and uses
 * `redisClient` for presence assertions and flushing).
 */
export { pubClient, subClient, redisClient };

// -----------------------------------------------------------------------------
// Teardown
// -----------------------------------------------------------------------------

let resourcesClosed = false;

/**
 * Disconnects Prisma and all three Redis clients. Call once from each suite's
 * `afterAll`. Idempotent — repeat calls are no-ops — and forgiving so a
 * teardown error never masks a real test failure.
 */
export async function closeTestResources(): Promise<void> {
  if (resourcesClosed) return;
  resourcesClosed = true;

  await prismaTest.$disconnect().catch(() => undefined);
  await disconnectRedisClients().catch(() => undefined);
}

// -----------------------------------------------------------------------------
// Pre-flight Readiness Check (optional; for suites that need explicit readiness)
// -----------------------------------------------------------------------------

const sleep = promisify(setTimeout);

/**
 * Polls Postgres and Redis until both respond, or throws after `timeoutMs`.
 * Useful in CI where the containers may take a moment to accept connections.
 */
export async function waitForTestInfra(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      await prismaTest.$queryRaw`SELECT 1`;
      await redisClient.ping();
      return;
    } catch (err) {
      lastError = err;
      await sleep(500);
    }
  }
  throw new Error(`Test infrastructure not ready after ${timeoutMs}ms: ${String(lastError)}`);
}
