/**
 * @file packages/api/test/dms.test.ts
 *
 * Jest + supertest integration tests for the direct-message routes (3 endpoints):
 *   - GET  /api/dms                              — list DMs the caller participates in
 *   - POST /api/dms                              — start or find a 1:1 DM (idempotent)
 *   - GET  /api/dms/:id/messages?cursor=&limit=  — paginated DM message history
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript. The test-file ESLint block relaxes
 *             only `no-explicit-any` / `no-console`; the `no-unsafe-*` rules stay
 *             ON, so every `any`-typed supertest `response.body` is narrowed with
 *             a single whole-object cast and then read through typed property
 *             access. `noUncheckedIndexedAccess` is honoured by reading the first
 *             array element via destructuring plus a throwing `undefined` guard,
 *             never by bare `[0]` indexing.
 *   Rule 4  — Every test user is created through `registerUser()`
 *             (`POST /api/auth/register`); no direct Prisma user inserts. DM
 *             messages (not users) are seeded directly via Prisma, matching the
 *             channels/search suites.
 *   Gate 9  — DM history loads in under 1 second.
 *   Gate 12 — Zod validation: the `startDmSchema` body contract and the
 *             `:id` cuid path-param contract are exercised at every boundary.
 *   Gate 13 — Contributes coverage to `services/dms.service.ts`.
 *
 * AAP refs: §0.1.1 (1:1 DMs), §0.4.4 (DirectMessage / DMParticipant models),
 *           §0.6.2 (self-DM block + find-then-create idempotency), §0.8.4
 *           (shared cursor/limit pagination contract).
 *
 * Behavioral contract verified against the IMPLEMENTED route/service
 * (`src/routes/dms.ts`, `src/services/dms.service.ts`), NOT the assigned-file
 * prompt's illustrative sketch. The verified differences — POST /api/dms always
 * responds 200; GET /:id/messages returns a `{ messages, nextCursor }` envelope
 * (there is no `hasMore` field); participants are hydrated as `PublicUser`
 * (read via `.id`); and the route guards `req.app.get('io')` so no Socket.io
 * stub is required — are recorded in /docs/decision-log.md per the
 * Explainability rule (AAP §0.8.3), not in these comments.
 */

import request from 'supertest';
import type { Application } from 'express';

import type { DirectMessage, DMWithParticipants } from '@app/shared/types/dm';
import type { MessageWithAuthor } from '@app/shared/types/message';
import { PAGE_SIZE, MAX_PAGE_SIZE } from '@app/shared/constants/limits';

import {
  createTestApp,
  cleanDatabase,
  closeTestResources,
  registerUser,
  prismaTest,
} from './setup.js';

// ---------------------------------------------------------------------------
// Local response shapes
//
// Only the three DM/message DTOs are imported from the shared package (the
// import whitelist). The paginated-history envelope and the error-response
// shape are declared locally to narrow supertest's `any` body without an
// unsafe member access.
// ---------------------------------------------------------------------------

/**
 * Paginated DM message-history payload returned by `GET /api/dms/:id/messages`:
 * one page of messages (newest-first) plus the opaque cursor for the next
 * (older) page, or `null` when the timeline is exhausted. Structurally mirrors
 * the route's `ListDmMessagesResponse` (which is not exported).
 */
interface DmMessagesPage {
  messages: MessageWithAuthor[];
  nextCursor: string | null;
}

/**
 * Minimal shape of the centralized error envelope produced by
 * `middleware/error-handler.ts`, used to narrow a failure response body when
 * asserting on the human-readable `message`.
 */
interface ErrorResponseBody {
  error: string;
  message: string;
  code?: string;
}

// ---------------------------------------------------------------------------
// Cuid fixtures
// ---------------------------------------------------------------------------

/** A well-formed cuid that passes Zod `.cuid()` yet resolves to no database row. */
const MISSING_CUID = 'clxnonexistent00000000000';

/** A well-formed cuid used only in unauthenticated path tests (never resolved). */
const PLACEHOLDER_CUID = 'clx0000000000000000000000';

describe('Direct message routes — GET /api/dms, POST /api/dms, GET /api/dms/:id/messages', () => {
  let app: Application;

  beforeAll(() => {
    // createTestApp() builds the bare production Express app. The DM routes read
    // `req.app.get('io')` but guard the call with an `if (io !== undefined)`
    // check, so — unlike the message routes — no Socket.io stub is registered
    // here; the route simply skips the room-join side effect.
    app = createTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await closeTestResources();
  });

  /**
   * Creates (or resolves) a 1:1 DM via `POST /api/dms` and returns its id.
   * Local to this suite because the shared `createTestDm()` helper sits outside
   * this file's import whitelist; inlining keeps the dependency surface to the
   * five whitelisted `setup.ts` exports.
   */
  const startDmReturningId = async (token: string, targetUserId: string): Promise<string> => {
    const response = await request(app)
      .post('/api/dms')
      .set('Authorization', `Bearer ${token}`)
      .send({ targetUserId });
    expect([200, 201]).toContain(response.status);
    return (response.body as DirectMessage).id;
  };

  // -------------------------------------------------------------------------
  // POST /api/dms — start or find a 1:1 DM
  // -------------------------------------------------------------------------
  describe('POST /api/dms', () => {
    it('creates a new DM and returns it with both participants hydrated', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();

      const response = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetUserId: bob.id });

      // The implemented route responds 200 for both the find and the create
      // path; the accept-list tolerates a future 201-on-create without a false
      // failure (rationale in /docs/decision-log.md).
      expect([200, 201]).toContain(response.status);

      const dm = response.body as DMWithParticipants;
      expect(typeof dm.id).toBe('string');
      expect(dm.id.length).toBeGreaterThan(0);
      expect(typeof dm.createdAt).toBe('string');

      // Participants are hydrated as PublicUser ({ id, displayName, avatarUrl });
      // the identity is read via `.id` (the DTO carries no `userId` field).
      expect(dm.participants).toHaveLength(2);
      const participantIds = dm.participants.map((participant) => participant.id);
      expect(participantIds).toContain(alice.id);
      expect(participantIds).toContain(bob.id);
    });

    it('is idempotent — a second call returns the same DM (200) with no duplicate row', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();

      const first = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetUserId: bob.id });
      expect([200, 201]).toContain(first.status);
      const firstDm = first.body as DirectMessage;

      const second = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetUserId: bob.id })
        .expect(200);
      const secondDm = second.body as DirectMessage;

      expect(secondDm.id).toBe(firstDm.id);

      // The unique constraint on the canonical participant pair means exactly
      // one DirectMessage row exists regardless of how many times it is started.
      const dms = await prismaTest.directMessage.findMany();
      expect(dms).toHaveLength(1);
    });

    it('returns the same DM regardless of which participant initiates', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { token: bobToken, user: bob } = await registerUser();

      const fromAlice = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetUserId: bob.id });
      expect([200, 201]).toContain(fromAlice.status);
      const fromAliceDm = fromAlice.body as DirectMessage;

      const fromBob = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ targetUserId: alice.id })
        .expect(200);
      const fromBobDm = fromBob.body as DirectMessage;

      expect(fromBobDm.id).toBe(fromAliceDm.id);

      const dms = await prismaTest.directMessage.findMany();
      expect(dms).toHaveLength(1);
    });

    it('rejects a DM with oneself (403 Forbidden)', async () => {
      const { token, user } = await registerUser();

      const response = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: user.id })
        .expect(403);

      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/(self|forbidden|own)/i);
    });

    it('returns 404 when the target user does not exist', async () => {
      const { token } = await registerUser();

      await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: MISSING_CUID })
        .expect(404);
    });

    it('returns 400 when targetUserId is missing (Gate 12)', async () => {
      const { token } = await registerUser();

      await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(400);
    });

    it('returns 400 when targetUserId is not a cuid (Gate 12)', async () => {
      const { token } = await registerUser();

      await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: 'not-a-cuid' })
        .expect(400);
    });

    it('returns 400 for unknown fields per the .strict() schema (Gate 12)', async () => {
      const { token } = await registerUser();
      const { user: bob } = await registerUser();

      await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${token}`)
        .send({ targetUserId: bob.id, extra: 'rejected' })
        .expect(400);
    });

    it('returns 401 without an Authorization header', async () => {
      const { user: bob } = await registerUser();

      await request(app).post('/api/dms').send({ targetUserId: bob.id }).expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/dms — list the caller's DMs
  // -------------------------------------------------------------------------
  describe('GET /api/dms', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).get('/api/dms').expect(401);
    });

    it('returns an empty array when the caller has no DMs', async () => {
      const { token } = await registerUser();

      const response = await request(app)
        .get('/api/dms')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const dms = response.body as DMWithParticipants[];
      expect(dms).toHaveLength(0);
    });

    it('returns the DMs the caller participates in with the other participant hydrated', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();

      const createResponse = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetUserId: bob.id });
      expect([200, 201]).toContain(createResponse.status);
      const created = createResponse.body as DirectMessage;

      const listResponse = await request(app)
        .get('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const dms = listResponse.body as DMWithParticipants[];
      expect(dms).toHaveLength(1);

      const [dm] = dms;
      if (dm === undefined) {
        throw new Error('expected exactly one DM in the list');
      }
      expect(dm.id).toBe(created.id);
      const participantIds = dm.participants.map((participant) => participant.id);
      expect(participantIds).toContain(alice.id);
      expect(participantIds).toContain(bob.id);
    });

    it('does not return DMs the caller does not participate in', async () => {
      const { token: aliceToken } = await registerUser();
      const { token: bobToken } = await registerUser();
      const { user: carol } = await registerUser();

      // A DM between Bob and Carol — Alice is not a participant.
      const bobCarol = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ targetUserId: carol.id });
      expect([200, 201]).toContain(bobCarol.status);

      const aliceList = await request(app)
        .get('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const dms = aliceList.body as DMWithParticipants[];
      expect(dms).toHaveLength(0);
    });

    it('returns multiple DMs when the caller participates in several', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();
      const { user: carol } = await registerUser();

      const first = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetUserId: bob.id });
      expect([200, 201]).toContain(first.status);

      const second = await request(app)
        .post('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ targetUserId: carol.id });
      expect([200, 201]).toContain(second.status);

      const response = await request(app)
        .get('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const dms = response.body as DMWithParticipants[];
      expect(dms).toHaveLength(2);
    });

    it('orders DMs by most-recent activity first (newest lastMessageAt first)', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const { user: carol } = await registerUser();
      const { user: dave } = await registerUser();

      // Create the conversations in the OPPOSITE order to their eventual
      // activity ranking. The database returns rows newest-created first, so
      // the handler must genuinely re-sort by activity rather than echo the
      // database order — this asserts real server-side ordering.
      const dmDave = await startDmReturningId(aliceToken, dave.id);
      const dmCarol = await startDmReturningId(aliceToken, carol.id);
      const dmBob = await startDmReturningId(aliceToken, bob.id);

      // Seed one message per DM with strictly increasing timestamps so the
      // server-side ordering (newest activity first) is fully deterministic.
      await prismaTest.message.create({
        data: {
          content: 'oldest',
          authorId: alice.id,
          dmId: dmBob,
          parentId: null,
          createdAt: new Date('2025-01-01T00:00:00Z'),
        },
      });
      await prismaTest.message.create({
        data: {
          content: 'middle',
          authorId: alice.id,
          dmId: dmCarol,
          parentId: null,
          createdAt: new Date('2025-01-02T00:00:00Z'),
        },
      });
      await prismaTest.message.create({
        data: {
          content: 'newest',
          authorId: alice.id,
          dmId: dmDave,
          parentId: null,
          createdAt: new Date('2025-01-03T00:00:00Z'),
        },
      });

      const response = await request(app)
        .get('/api/dms')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const dms = response.body as DMWithParticipants[];
      const orderedIds = dms.map((dm) => dm.id);
      expect(orderedIds).toEqual([dmDave, dmCarol, dmBob]);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/dms/:id/messages — paginated DM history (newest-first)
  // -------------------------------------------------------------------------
  describe('GET /api/dms/:id/messages', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).get(`/api/dms/${PLACEHOLDER_CUID}/messages`).expect(401);
    });

    it('returns an empty timeline (messages: [], nextCursor: null) for a new DM', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      const response = await request(app)
        .get(`/api/dms/${dmId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = response.body as DmMessagesPage;
      expect(body.messages).toHaveLength(0);
      expect(body.nextCursor).toBeNull();
    });

    it('returns the timeline for a participating user (author hydrated)', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      await prismaTest.message.create({
        data: { content: 'hi', authorId: alice.id, dmId, parentId: null },
      });

      const response = await request(app)
        .get(`/api/dms/${dmId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = response.body as DmMessagesPage;
      expect(body.messages).toHaveLength(1);

      const [first] = body.messages;
      if (first === undefined) {
        throw new Error('expected exactly one DM message');
      }
      expect(first.content).toBe('hi');
      expect(first.authorId).toBe(alice.id);
      expect(first.dmId).toBe(dmId);
      expect(first.author.id).toBe(alice.id);
      expect(body.nextCursor).toBeNull();
    });

    it('returns 403 when the caller is not a participant', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      const { token: carolToken } = await registerUser();
      await request(app)
        .get(`/api/dms/${dmId}/messages`)
        .set('Authorization', `Bearer ${carolToken}`)
        .expect(403);
    });

    it('returns 404 for an unknown but well-formed dmId', async () => {
      const { token } = await registerUser();

      await request(app)
        .get(`/api/dms/${MISSING_CUID}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 400 for a malformed dmId in the path (Gate 12)', async () => {
      const { token } = await registerUser();

      await request(app)
        .get('/api/dms/not-a-cuid/messages')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('returns 400 for a malformed cursor (Gate 12)', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      // The cursor is an opaque base64 (createdAt, id) token; arbitrary text
      // that does not decode to a valid payload must be rejected, not ignored.
      await request(app)
        .get(`/api/dms/${dmId}/messages?cursor=not-a-valid-cursor`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(400);
    });

    it('returns 400 for a well-formed token whose payload lacks the cursor shape (Gate 12)', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      // A token that base64url-decodes to valid JSON but omits the required
      // (createdAt, id) fields must also be rejected: decoding succeeds yet the
      // payload shape is invalid, so the server returns 400 rather than 500.
      const wrongShapeCursor = Buffer.from(
        JSON.stringify({ foo: 'bar' }),
        'utf8',
      ).toString('base64url');

      await request(app)
        .get(`/api/dms/${dmId}/messages?cursor=${encodeURIComponent(wrongShapeCursor)}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(400);
    });

    it('returns 400 for a limit below 1 or above MAX_PAGE_SIZE (Gate 12)', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      // limit must be a positive integer no greater than MAX_PAGE_SIZE (100);
      // the schema rejects both a non-positive value and an over-cap value.
      await request(app)
        .get(`/api/dms/${dmId}/messages?limit=0`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(400);

      await request(app)
        .get(`/api/dms/${dmId}/messages?limit=${MAX_PAGE_SIZE + 50}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(400);
    });

    it('returns at most PAGE_SIZE (50) messages by default and a forward cursor', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      await prismaTest.message.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          content: `Message ${i}`,
          authorId: alice.id,
          dmId,
          parentId: null,
        })),
      });

      const response = await request(app)
        .get(`/api/dms/${dmId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = response.body as DmMessagesPage;
      expect(body.messages).toHaveLength(PAGE_SIZE);
      expect(typeof body.nextCursor).toBe('string');
    });

    it('supports cursor-based pagination across two non-overlapping pages (50 then 25)', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      // Strictly increasing timestamps make the (createdAt, id) cursor ordering
      // deterministic across the page boundary.
      const baseTime = new Date('2025-01-01T00:00:00Z');
      await prismaTest.message.createMany({
        data: Array.from({ length: 75 }, (_, i) => ({
          content: `Message ${i}`,
          authorId: alice.id,
          dmId,
          parentId: null,
          createdAt: new Date(baseTime.getTime() + i * 1000),
        })),
      });

      const page1Response = await request(app)
        .get(`/api/dms/${dmId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      const page1 = page1Response.body as DmMessagesPage;
      expect(page1.messages).toHaveLength(PAGE_SIZE);
      expect(typeof page1.nextCursor).toBe('string');

      const cursor = page1.nextCursor;
      if (cursor === null) {
        throw new Error('expected a forward cursor after the first page');
      }

      const page2Response = await request(app)
        .get(`/api/dms/${dmId}/messages?cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      const page2 = page2Response.body as DmMessagesPage;
      expect(page2.messages).toHaveLength(25);
      expect(page2.nextCursor).toBeNull();

      // The two pages must be disjoint — a cursor page never repeats a row.
      const page1Ids = new Set(page1.messages.map((message) => message.id));
      const overlap = page2.messages.filter((message) => page1Ids.has(message.id));
      expect(overlap).toHaveLength(0);
    });

    it('caps the page size at MAX_PAGE_SIZE (100) even when limit=100 is requested', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      await prismaTest.message.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          content: `Message ${i}`,
          authorId: alice.id,
          dmId,
          parentId: null,
        })),
      });

      const response = await request(app)
        .get(`/api/dms/${dmId}/messages?limit=${MAX_PAGE_SIZE}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = response.body as DmMessagesPage;
      expect(body.messages).toHaveLength(MAX_PAGE_SIZE);
      expect(typeof body.nextCursor).toBe('string');
    });

    it('excludes thread replies from the main timeline (parentId: null only)', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      const parent = await prismaTest.message.create({
        data: { content: 'parent', authorId: alice.id, dmId, parentId: null },
      });
      await prismaTest.message.create({
        data: { content: 'reply', authorId: alice.id, dmId, parentId: parent.id },
      });

      const response = await request(app)
        .get(`/api/dms/${dmId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = response.body as DmMessagesPage;
      expect(body.messages).toHaveLength(1);

      const [only] = body.messages;
      if (only === undefined) {
        throw new Error('expected exactly one top-level message');
      }
      expect(only.content).toBe('parent');
      expect(only.parentId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Gate 9 — DM history load latency
  // -------------------------------------------------------------------------
  describe('GET /api/dms/:id/messages — performance (Gate 9)', () => {
    it('loads a 50-message DM page in under 1 second', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dmId = await startDmReturningId(aliceToken, bob.id);

      await prismaTest.message.createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          content: `Message ${i} with a reasonable amount of body text`,
          authorId: alice.id,
          dmId,
          parentId: null,
        })),
      });

      const start = Date.now();
      const response = await request(app)
        .get(`/api/dms/${dmId}/messages`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
      const elapsedMs = Date.now() - start;

      const body = response.body as DmMessagesPage;
      expect(body.messages).toHaveLength(PAGE_SIZE);
      expect(elapsedMs).toBeLessThan(1000);
    });
  });
});
