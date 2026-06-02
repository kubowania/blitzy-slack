/**
 * @file packages/api/test/messages.test.ts
 *
 * Jest + supertest integration tests for the message routes (4 endpoints):
 *   - POST   /api/messages                       (channel | DM | thread reply | file)
 *   - GET    /api/messages/:id/replies           (thread replies, oldest-first)
 *   - POST   /api/messages/:id/reactions         (add an emoji reaction)
 *   - DELETE /api/messages/:id/reactions/:emoji  (remove an emoji reaction)
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript. The test-file ESLint block relaxes
 *             only `no-explicit-any`/`no-console`; the `no-unsafe-*` rules stay
 *             ON, so each `any`-typed `response.body` is narrowed with a single
 *             whole-object cast and then read through typed property access.
 *             `noUncheckedIndexedAccess` is honoured by reading arrays through
 *             `.map`/`.find` with a throwing guard rather than bare indexing.
 *   Rule 4  — Every test user is created through `registerUser()`
 *             (`POST /api/auth/register`); no direct Prisma user inserts.
 *   Gate 9  — Message delivery completes in under 500 ms (HTTP path).
 *   Gate 12 — Zod validation: the send-message XOR refinement and the reaction
 *             body schema are exercised at every boundary.
 *   Gate 13 — Contributes coverage to `services/messages.service.ts`.
 *
 * AAP refs: §0.1.1 (threads + reactions), §0.4.4 (Message/MessageReaction
 *           models), §0.4.5 (real-time event contract), §0.6.2 (XOR + thread +
 *           file-ownership service rules), §0.8.4 (one file per message).
 *
 * Behavioral contract (verified against the implemented route/service, NOT the
 * assigned-file prompt's illustrative sketch — see /docs/decision-log.md):
 *   - POST /api/messages returns 201 with a hydrated `MessageWithAuthor`.
 *   - GET /:id/replies returns 200 with the shared `Thread` envelope
 *     `{ parent, replies }` — the hydrated parent message plus the
 *     oldest-first reply list (each a hydrated `MessageWithAuthor`).
 *   - POST /:id/reactions and DELETE /:id/reactions/:emoji return the FULL
 *     post-mutation `MessageWithAuthor` (the `{ messageId, reaction }` and
 *     `{ messageId, emoji, userId }` shapes are the Socket.io payloads, asserted
 *     in socket.test.ts, not the HTTP bodies asserted here).
 *   - The message routes broadcast over Socket.io after each mutation; the bare
 *     `createTestApp()` does not attach a real io, so a no-op stub is registered
 *     on the app to let the HTTP routes run end-to-end. Rationale and trade-offs
 *     live in /docs/decision-log.md per the Explainability rule, not here.
 */

import request from 'supertest';
import type { Application } from 'express';

import type {
  Message,
  MessageWithAuthor,
  ReactionSummary,
  Thread,
} from '@app/shared/types/message';
import { MAX_MESSAGE_LENGTH, MAX_EMOJI_LENGTH } from '@app/shared/constants/limits';

import {
  createTestApp,
  cleanDatabase,
  closeTestResources,
  registerUser,
  createTestChannel,
  createTestDm,
  prismaTest,
  uniqueChannelName,
} from './setup.js';

// ---------------------------------------------------------------------------
// Local helper types (kept local to respect the import whitelist — only the
// three message DTOs are imported from the shared package; the error envelope
// and the minimal upload-response shape are declared here).
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the centralized error envelope produced by
 * `middleware/error-handler.ts`, used to narrow supertest's `any` body on
 * failure responses without an unsafe member access.
 */
interface ErrorResponseBody {
  error: string;
  message: string;
  code?: string;
}

/**
 * Minimal shape of the `POST /api/files` response needed to read the new file's
 * id for the file-attachment tests (the full DTO is `FileAttachment`, covered by
 * files.test.ts; only the id is required here).
 */
interface UploadedFileResponse {
  id: string;
}

/**
 * Minimal Socket.io broadcast surface the message routes invoke
 * (`io.to(room).emit(event, payload)` for MESSAGE_NEW / REACTION_* fan-out).
 */
interface BroadcastOperatorStub {
  emit(event: string, ...args: unknown[]): boolean;
}

/**
 * Minimal Socket.io room-operator surface the DM route invokes
 * (`io.in(userRoom(id)).socketsJoin(dmRoom(id))` to subscribe both participants'
 * live sockets to a newly created DM room). A `createTestDm()` call routes
 * through `POST /api/dms`, so this surface must exist for the DM-backed cases.
 */
interface RoomOperatorStub {
  socketsJoin(rooms: string | string[]): void;
  socketsLeave(rooms: string | string[]): void;
}

/**
 * Minimal Socket.io server surface the HTTP routes read via `req.app.get('io')`:
 * `.to(room)` for event fan-out (messages route) and `.in(room)` for room
 * membership mutation (dms route).
 */
interface IoStub {
  to(room: string): BroadcastOperatorStub;
  in(room: string): RoomOperatorStub;
}

/**
 * No-op Socket.io stub: `to(room).emit(...)` and `in(room).socketsJoin(...)` are
 * swallowed so the HTTP routes return their normal status codes instead of
 * throwing on an absent io server (createTestApp() does not attach one).
 */
const ioStub: IoStub = {
  to: (): BroadcastOperatorStub => ({
    emit: (): boolean => true,
  }),
  in: (): RoomOperatorStub => ({
    socketsJoin: (): void => undefined,
    socketsLeave: (): void => undefined,
  }),
};

/** Promise-based delay so successive thread replies get strictly increasing timestamps. */
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Minimal 8-byte PNG signature — enough for multer to accept and record an upload. */
const makeTinyPngBuffer = (): Buffer =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A well-formed cuid that passes Zod `.cuid()` yet resolves to no database row. */
const MISSING_CUID = 'clxnonexistent00000000000';

/** A well-formed cuid used only in unauthenticated path tests (never resolved). */
const PLACEHOLDER_CUID = 'clx0000000000000000000000';

/** The Unicode emoji exercised throughout the reaction tests. */
const THUMBS_UP = '👍';

describe('Message routes — POST /api/messages, GET /:id/replies, POST/DELETE /:id/reactions', () => {
  let app: Application;

  beforeAll(() => {
    app = createTestApp();
    // The message routes broadcast over Socket.io after each successful mutation
    // via `req.app.get('io').to(room).emit(...)`. createTestApp() builds the bare
    // production Express app without the index.ts bootstrap that attaches the io
    // server, so a no-op stub is registered here; otherwise every POST would 500
    // after persistence succeeded. (See /docs/decision-log.md.)
    app.set('io', ioStub);
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await closeTestResources();
  });

  // -------------------------------------------------------------------------
  // POST /api/messages — channel messages
  // -------------------------------------------------------------------------
  describe('POST /api/messages — channel message', () => {
    it('creates a message in a channel where the user is a member (author hydrated)', async () => {
      const { token, user } = await registerUser();
      const channelName = uniqueChannelName();
      const channel = await createTestChannel({ token, isPrivate: false, name: channelName });
      expect(channel.name).toBe(channelName);

      const response = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'Hello world', channelId: channel.id })
        .expect(201);

      const body = response.body as MessageWithAuthor;
      expect(typeof body.id).toBe('string');
      expect(body.content).toBe('Hello world');
      expect(body.authorId).toBe(user.id);
      expect(body.channelId).toBe(channel.id);
      expect(body.dmId).toBeNull();
      expect(body.parentId).toBeNull();
      expect(body.fileId).toBeNull();
      expect(typeof body.createdAt).toBe('string');
      expect(body.author.id).toBe(user.id);
      expect(body.author.displayName).toBe(user.displayName);
      expect(body.reactions).toEqual([]);
      expect(body.replyCount).toBe(0);
      expect(body.file).toBeNull();
    });

    it('returns 403 when posting to a private channel without membership', async () => {
      const { token: ownerToken } = await registerUser();
      const channel = await createTestChannel({ token: ownerToken, isPrivate: true });

      const { token: outsiderToken } = await registerUser();
      const response = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ content: 'sneaky', channelId: channel.id })
        .expect(403);

      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/(member|forbidden|access)/i);
    });

    it('returns 404 when channelId does not exist', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'lost in space', channelId: MISSING_CUID })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/messages — DM messages
  // -------------------------------------------------------------------------
  describe('POST /api/messages — DM message', () => {
    it('creates a message in a DM where the user is a participant', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });

      const response = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'Hi Bob', dmId: dm.id })
        .expect(201);

      // Base-shape assertion via the `Message` DTO (no author/reactions needed here).
      const body = response.body as Message;
      expect(body.content).toBe('Hi Bob');
      expect(body.authorId).toBe(alice.id);
      expect(body.channelId).toBeNull();
      expect(body.dmId).toBe(dm.id);
      expect(body.parentId).toBeNull();
      expect(body.fileId).toBeNull();
    });

    it('returns 403 when the caller is not a DM participant', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });

      const { token: carolToken } = await registerUser();
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${carolToken}`)
        .send({ content: 'eavesdrop', dmId: dm.id })
        .expect(403);
    });

    it('returns 404 when dmId does not exist', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'orphan', dmId: MISSING_CUID })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/messages — Gate 12 validation (XOR refinement + content bounds)
  // -------------------------------------------------------------------------
  describe('POST /api/messages — Gate 12 validation', () => {
    it('rejects a message with NEITHER channelId nor dmId (422)', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'orphan' })
        .expect(422);
    });

    it('rejects a message with BOTH channelId AND dmId (422)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token, targetUserId: bob.id });

      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'confused', channelId: channel.id, dmId: dm.id })
        .expect(422);
    });

    it('rejects empty content (422)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: '', channelId: channel.id })
        .expect(422);
    });

    it('rejects whitespace-only content (trim → empty) (422)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: '   ', channelId: channel.id })
        .expect(422);
    });

    it('rejects content exceeding MAX_MESSAGE_LENGTH (422)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'a'.repeat(MAX_MESSAGE_LENGTH + 1), channelId: channel.id })
        .expect(422);
    });

    it('accepts content exactly at MAX_MESSAGE_LENGTH (201)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'a'.repeat(MAX_MESSAGE_LENGTH), channelId: channel.id })
        .expect(201);
    });

    it('rejects a malformed cuid channelId (422)', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'hi', channelId: 'not-a-cuid' })
        .expect(422);
    });

    it('rejects unknown fields per the .strict() schema (422)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'hi', channelId: channel.id, authorId: 'spoofed' })
        .expect(422);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/messages — thread replies (single-level; container inherited)
  // -------------------------------------------------------------------------
  describe('POST /api/messages — thread reply', () => {
    it('creates a thread reply that shares its parent channel', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const parentResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'parent', channelId: channel.id })
        .expect(201);
      const parentId = (parentResponse.body as MessageWithAuthor).id;

      // The reply carries the matching channelId (the service validates the
      // parent shares the supplied container) plus the parentId.
      const replyResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'reply', parentId, channelId: channel.id })
        .expect(201);

      const reply = replyResponse.body as MessageWithAuthor;
      expect(reply.content).toBe('reply');
      expect(reply.parentId).toBe(parentId);
      expect(reply.channelId).toBe(channel.id);
      expect(reply.dmId).toBeNull();
    });

    it('creates a thread reply that shares its parent DM', async () => {
      const { token: aliceToken } = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });

      const parentResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'parent', dmId: dm.id })
        .expect(201);
      const parentId = (parentResponse.body as MessageWithAuthor).id;

      const replyResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'reply', parentId, dmId: dm.id })
        .expect(201);

      const reply = replyResponse.body as MessageWithAuthor;
      expect(reply.parentId).toBe(parentId);
      expect(reply.dmId).toBe(dm.id);
      expect(reply.channelId).toBeNull();
    });

    it('rejects a two-level thread (reply to a reply) with 422', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const parentResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'parent', channelId: channel.id })
        .expect(201);
      const parentId = (parentResponse.body as MessageWithAuthor).id;

      const replyResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'reply', parentId, channelId: channel.id })
        .expect(201);
      const replyId = (replyResponse.body as MessageWithAuthor).id;

      const nested = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'nested', parentId: replyId, channelId: channel.id });
      // A reply-to-a-reply is a single-level-thread ValidationError (422).
      expect(nested.status).toBe(422);
    });

    it('returns 404 when parentId references a non-existent message', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'orphan reply', parentId: MISSING_CUID, channelId: channel.id })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/messages — file attachments (one file per message; @unique fileId)
  // -------------------------------------------------------------------------
  describe('POST /api/messages — file attachment', () => {
    it('attaches an uploaded file when the uploader is the author', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', makeTinyPngBuffer(), { filename: 'pixel.png', contentType: 'image/png' })
        .expect(201);
      const fileId = (uploadResponse.body as UploadedFileResponse).id;

      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'check this', channelId: channel.id, fileId })
        .expect(201);

      const body = messageResponse.body as MessageWithAuthor;
      expect(body.fileId).toBe(fileId);
      expect(body.file).not.toBeNull();
    });

    it('returns 403 when the fileId was uploaded by a different user', async () => {
      const { token: aliceToken } = await registerUser();
      const channel = await createTestChannel({ token: aliceToken, isPrivate: false });

      const { token: bobToken } = await registerUser();
      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${bobToken}`)
        .attach('file', makeTinyPngBuffer(), { filename: 'bob.png', contentType: 'image/png' })
        .expect(201);
      const fileId = (uploadResponse.body as UploadedFileResponse).id;

      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'stolen', channelId: channel.id, fileId })
        .expect(403);
    });

    it('returns 409 when the fileId is already attached to another message (@unique)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const uploadResponse = await request(app)
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', makeTinyPngBuffer(), { filename: 'shared.png', contentType: 'image/png' })
        .expect(201);
      const fileId = (uploadResponse.body as UploadedFileResponse).id;

      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'first', channelId: channel.id, fileId })
        .expect(201);

      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'second', channelId: channel.id, fileId })
        .expect(409);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/messages/:id — single-message detail (THREAD-002)
  //
  // The detail endpoint returns one fully-hydrated message (author, reactions,
  // file, reply count) and enforces the SAME channel/DM ACL as the timeline and
  // thread reads: 404 for an unknown id, 403 for a caller without access, 422
  // for a malformed cuid path.
  // -------------------------------------------------------------------------
  describe('GET /api/messages/:id', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).get(`/api/messages/${PLACEHOLDER_CUID}`).expect(401);
    });

    it('returns the fully-hydrated message for its author (200)', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const created = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'detail me', channelId: channel.id })
        .expect(201);
      const messageId = (created.body as MessageWithAuthor).id;

      const response = await request(app)
        .get(`/api/messages/${messageId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as MessageWithAuthor;
      expect(body.id).toBe(messageId);
      expect(body.content).toBe('detail me');
      expect(body.channelId).toBe(channel.id);
      expect(body.dmId).toBeNull();
      // Fully hydrated: author + reactions + reply count are present.
      expect(body.author.id).toBe(user.id);
      expect(Array.isArray(body.reactions)).toBe(true);
      expect(body.replyCount).toBe(0);
    });

    it('returns the authoritative replyCount after a thread reply (re-hydration path)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parent = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'parent', channelId: channel.id })
        .expect(201);
      const parentId = (parent.body as MessageWithAuthor).id;

      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'reply', parentId, channelId: channel.id })
        .expect(201);

      const response = await request(app)
        .get(`/api/messages/${parentId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as MessageWithAuthor;
      expect(body.id).toBe(parentId);
      // The same hydration the message:updated broadcast carries: an incremented
      // reply count read straight from the authoritative row.
      expect(body.replyCount).toBe(1);
    });

    it('returns a DM message for a participant (200)', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });
      const created = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'dm detail', dmId: dm.id })
        .expect(201);
      const messageId = (created.body as MessageWithAuthor).id;

      const response = await request(app)
        .get(`/api/messages/${messageId}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = response.body as MessageWithAuthor;
      expect(body.id).toBe(messageId);
      expect(body.dmId).toBe(dm.id);
      expect(body.channelId).toBeNull();
      expect(body.author.id).toBe(alice.id);
    });

    it('returns 404 for an unknown but well-formed message id', async () => {
      const { token } = await registerUser();
      await request(app)
        .get(`/api/messages/${MISSING_CUID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 403 when the caller cannot access the message (private non-member)', async () => {
      const { token: ownerToken } = await registerUser();
      const channel = await createTestChannel({ token: ownerToken, isPrivate: true });
      const created = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ content: 'private detail', channelId: channel.id })
        .expect(201);
      const messageId = (created.body as MessageWithAuthor).id;

      const { token: outsiderToken } = await registerUser();
      await request(app)
        .get(`/api/messages/${messageId}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403);
    });

    it('returns 422 for a malformed message id in the path (Gate 12)', async () => {
      const { token } = await registerUser();
      await request(app)
        .get('/api/messages/not-a-cuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(422);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/messages/:id/replies — thread reply listing
  // -------------------------------------------------------------------------
  describe('GET /api/messages/:id/replies', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).get(`/api/messages/${PLACEHOLDER_CUID}/replies`).expect(401);
    });

    it('returns the hydrated parent and an empty reply list when the parent has no replies', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parentResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'parent', channelId: channel.id })
        .expect(201);
      const parentId = (parentResponse.body as MessageWithAuthor).id;

      const response = await request(app)
        .get(`/api/messages/${parentId}/replies`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const thread = response.body as Thread;
      expect(thread.parent.id).toBe(parentId);
      expect(thread.parent.content).toBe('parent');
      expect(thread.parent.replyCount).toBe(0);
      expect(Array.isArray(thread.replies)).toBe(true);
      expect(thread.replies).toHaveLength(0);
    });

    it('returns thread replies in chronological order (oldest first)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parentResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'parent', channelId: channel.id })
        .expect(201);
      const parentId = (parentResponse.body as MessageWithAuthor).id;

      for (const text of ['first', 'second', 'third']) {
        await request(app)
          .post('/api/messages')
          .set('Authorization', `Bearer ${token}`)
          .send({ content: text, parentId, channelId: channel.id })
          .expect(201);
        // Distinct timestamps make the createdAt ordering deterministic.
        await sleep(10);
      }

      const response = await request(app)
        .get(`/api/messages/${parentId}/replies`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const thread = response.body as Thread;
      expect(thread.parent.id).toBe(parentId);
      expect(thread.parent.replyCount).toBe(3);
      expect(thread.replies).toHaveLength(3);
      expect(thread.replies.map((reply) => reply.content)).toEqual(['first', 'second', 'third']);
    });

    it('returns 404 for an unknown parent message id', async () => {
      const { token } = await registerUser();
      await request(app)
        .get(`/api/messages/${MISSING_CUID}/replies`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 403 when the caller cannot access the parent (private non-member)', async () => {
      const { token: ownerToken } = await registerUser();
      const channel = await createTestChannel({ token: ownerToken, isPrivate: true });
      const parentResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ content: 'private parent', channelId: channel.id })
        .expect(201);
      const parentId = (parentResponse.body as MessageWithAuthor).id;

      const { token: outsiderToken } = await registerUser();
      await request(app)
        .get(`/api/messages/${parentId}/replies`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/messages/:id/reactions — add reaction
  // -------------------------------------------------------------------------
  describe('POST /api/messages/:id/reactions', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app)
        .post(`/api/messages/${PLACEHOLDER_CUID}/reactions`)
        .send({ emoji: THUMBS_UP })
        .expect(401);
    });

    it('adds a reaction and returns the message with the aggregated summary', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'react to me', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      // Reaction toggle status is implementation-defined (200 or 201 both valid);
      // the DB-state and summary assertions below are the real contract.
      const response = await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emoji: THUMBS_UP });
      expect([200, 201]).toContain(response.status);

      const body = response.body as MessageWithAuthor;
      const summary: ReactionSummary | undefined = body.reactions.find(
        (reaction) => reaction.emoji === THUMBS_UP,
      );
      if (summary === undefined) {
        throw new Error('expected a 👍 reaction summary on the message');
      }
      expect(summary.count).toBe(1);
      expect(summary.userIds).toContain(user.id);
      expect(summary.hasCurrentUser).toBe(true);
    });

    it('is idempotent — adding the same reaction twice keeps a single row', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'react', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const first = await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emoji: THUMBS_UP });
      expect([200, 201]).toContain(first.status);

      const second = await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emoji: THUMBS_UP });
      expect([200, 201]).toContain(second.status);

      const reactions = await prismaTest.messageReaction.findMany({ where: { messageId } });
      expect(reactions).toHaveLength(1);
    });

    it('aggregates reactions from multiple users', async () => {
      const { token: ownerToken } = await registerUser();
      const channel = await createTestChannel({ token: ownerToken, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ content: 'react', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const ownerReaction = await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ emoji: THUMBS_UP });
      expect([200, 201]).toContain(ownerReaction.status);

      const { token: bobToken, user: bob } = await registerUser();
      await request(app)
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);

      const response = await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ emoji: THUMBS_UP });
      expect([200, 201]).toContain(response.status);

      const body = response.body as MessageWithAuthor;
      const summary = body.reactions.find((reaction) => reaction.emoji === THUMBS_UP);
      if (summary === undefined) {
        throw new Error('expected a 👍 reaction summary on the message');
      }
      expect(summary.count).toBe(2);
      expect(summary.userIds).toContain(bob.id);
      expect(summary.hasCurrentUser).toBe(true);
    });

    it('returns 403 when reacting in an unmembered private channel', async () => {
      const { token: ownerToken } = await registerUser();
      const channel = await createTestChannel({ token: ownerToken, isPrivate: true });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ content: 'private', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const { token: outsiderToken } = await registerUser();
      await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ emoji: THUMBS_UP })
        .expect(403);
    });

    it('returns 404 when the message id does not exist', async () => {
      const { token } = await registerUser();
      await request(app)
        .post(`/api/messages/${MISSING_CUID}/reactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emoji: THUMBS_UP })
        .expect(404);
    });

    it('returns 422 for an empty emoji string', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'x', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emoji: '' })
        .expect(422);
    });

    it('returns 422 for an emoji exceeding MAX_EMOJI_LENGTH', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'x', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emoji: 'a'.repeat(MAX_EMOJI_LENGTH + 1) })
        .expect(422);
    });

    it('returns 422 for unknown fields per the .strict() schema', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'x', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emoji: THUMBS_UP, userId: 'spoofed' })
        .expect(422);
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/messages/:id/reactions/:emoji — remove reaction
  // -------------------------------------------------------------------------
  describe('DELETE /api/messages/:id/reactions/:emoji', () => {
    const encodedThumbsUp = encodeURIComponent(THUMBS_UP);

    it('returns 401 without an Authorization header', async () => {
      await request(app)
        .delete(`/api/messages/${PLACEHOLDER_CUID}/reactions/${encodedThumbsUp}`)
        .expect(401);
    });

    it('removes the caller reaction and returns the message without it', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'react', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const added = await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${token}`)
        .send({ emoji: THUMBS_UP });
      expect([200, 201]).toContain(added.status);

      const response = await request(app)
        .delete(`/api/messages/${messageId}/reactions/${encodedThumbsUp}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as MessageWithAuthor;
      expect(body.id).toBe(messageId);
      expect(body.reactions.find((reaction) => reaction.emoji === THUMBS_UP)).toBeUndefined();

      const reactions = await prismaTest.messageReaction.findMany({ where: { messageId } });
      expect(reactions).toHaveLength(0);
    });

    it('is idempotent — removing a non-existent reaction does not error', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'no react', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const response = await request(app)
        .delete(`/api/messages/${messageId}/reactions/${encodedThumbsUp}`)
        .set('Authorization', `Bearer ${token}`);
      expect([200, 204, 404]).toContain(response.status);
    });

    it('removes only the caller reaction and preserves other users reactions', async () => {
      const { token: aliceToken } = await registerUser();
      const channel = await createTestChannel({ token: aliceToken, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ content: 'react', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const { token: bobToken } = await registerUser();
      await request(app)
        .post(`/api/channels/${channel.id}/join`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(200);

      const aliceReaction = await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .send({ emoji: THUMBS_UP });
      expect([200, 201]).toContain(aliceReaction.status);
      const bobReaction = await request(app)
        .post(`/api/messages/${messageId}/reactions`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ emoji: THUMBS_UP });
      expect([200, 201]).toContain(bobReaction.status);

      await request(app)
        .delete(`/api/messages/${messageId}/reactions/${encodedThumbsUp}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const remaining = await prismaTest.messageReaction.findMany({
        where: { messageId, emoji: THUMBS_UP },
      });
      expect(remaining).toHaveLength(1);
    });

    it('returns 403 when removing a reaction in an unmembered private channel', async () => {
      const { token: ownerToken } = await registerUser();
      const channel = await createTestChannel({ token: ownerToken, isPrivate: true });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ content: 'private', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const { token: outsiderToken } = await registerUser();
      await request(app)
        .delete(`/api/messages/${messageId}/reactions/${encodedThumbsUp}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // Message immutability — no edit or delete routes exist (AAP §0.7.2)
  // -------------------------------------------------------------------------
  describe('Message immutability — no edit or delete routes', () => {
    it('does not expose PATCH /api/messages/:id (404 or 405)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'immutable', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const response = await request(app)
        .patch(`/api/messages/${messageId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'edited' });
      expect([404, 405]).toContain(response.status);
    });

    it('does not expose DELETE /api/messages/:id (404 or 405)', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const messageResponse = await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'immutable', channelId: channel.id })
        .expect(201);
      const messageId = (messageResponse.body as MessageWithAuthor).id;

      const response = await request(app)
        .delete(`/api/messages/${messageId}`)
        .set('Authorization', `Bearer ${token}`);
      expect([404, 405]).toContain(response.status);
    });
  });

  // -------------------------------------------------------------------------
  // Gate 9 — message delivery latency (HTTP path; Socket.io path in socket.test.ts)
  // -------------------------------------------------------------------------
  describe('POST /api/messages — performance (Gate 9)', () => {
    it('delivers a channel message in under 500 ms', async () => {
      const { token } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const start = Date.now();
      await request(app)
        .post('/api/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'quick', channelId: channel.id })
        .expect(201);
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(500);
    });
  });
});
