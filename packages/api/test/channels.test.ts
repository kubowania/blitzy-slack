/**
 * @file packages/api/test/channels.test.ts
 *
 * Jest + supertest integration tests for the channel routes (6 endpoints):
 *   - GET    /api/channels
 *   - POST   /api/channels
 *   - GET    /api/channels/:id
 *   - POST   /api/channels/:id/join
 *   - POST   /api/channels/:id/leave
 *   - GET    /api/channels/:id/messages?cursor=&limit=
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript. The test-file ESLint block relaxes
 *             only `no-explicit-any`/`no-console`; the `no-unsafe-*` rules stay
 *             ON, so each `any`-typed supertest `response.body` is narrowed with a
 *             single whole-object cast and then read through typed property
 *             access. `noUncheckedIndexedAccess` is honoured by reading the first
 *             array element via destructuring plus a throwing `undefined` guard
 *             (never bare `[0]`) and by asserting ordering through `.map`.
 *   Rule 4  — Every test user is created through `registerUser()`
 *             (`POST /api/auth/register`); no direct Prisma user inserts. Channel
 *             memberships and channel messages (not users) are seeded directly via
 *             `prismaTest`, matching the dms/messages/search suites.
 *   Gate 9  — Channel history loads in under 1 second.
 *   Gate 12 — Zod validation: the `createChannelSchema` body contract and the
 *             `:id` cuid path-param contract are exercised at every boundary.
 *   Gate 13 — Contributes coverage to `services/channels.service.ts`.
 *
 * AAP refs: §0.1.1 (public/private channels: create/list/join/leave), §0.4.4
 *           (Channel + ChannelMember models), §0.6.2 (service-layer ACL), §0.6.3
 *           (cursor pagination), §0.8.4 (shared cursor/limit pagination contract).
 *
 * Behavioral contract verified against the IMPLEMENTED route/service
 * (`src/routes/channels.ts`, `src/services/channels.service.ts`), NOT the
 * assigned-file prompt's illustrative sketch. The verified differences —
 * GET /:id/messages returns a `{ messages, nextCursor }` envelope (there is NO
 * `hasMore` field; "more remains" is expressed by a non-null `nextCursor`); a
 * `limit` above MAX_PAGE_SIZE is CLAMPED to MAX_PAGE_SIZE by the query schema
 * (capped, not rejected) per §0.8.4; POST /:id/join is idempotent and returns
 * 200 (never 409);
 * and the channel routes emit no Socket.io events so no `io` stub is required —
 * are recorded in /docs/decision-log.md per the Explainability rule (AAP §0.8.3),
 * not in these comments.
 */

import request from 'supertest';
import type { Application } from 'express';

import type {
  Channel,
  ChannelMember,
  ChannelSummary,
  ChannelWithMembers,
} from '@app/shared/types/channel';
import type { MessageWithAuthor } from '@app/shared/types/message';
import {
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_DESCRIPTION_LENGTH,
} from '@app/shared/constants/limits';

import {
  createTestApp,
  cleanDatabase,
  closeTestResources,
  registerUser,
  uniqueChannelName,
  prismaTest,
} from './setup.js';

// ---------------------------------------------------------------------------
// Local response shapes
//
// The shared package supplies the message/channel DTOs (the import whitelist).
// The paginated-history envelope and the error-response shape are declared
// locally to narrow supertest's `any` body without an unsafe member access; the
// envelope mirrors the route's (non-exported) `ListMessagesResponse`.
// ---------------------------------------------------------------------------

/**
 * Paginated channel message-history payload returned by
 * `GET /api/channels/:id/messages`: one page of top-level messages
 * (newest-first) plus the opaque cursor for the next (older) page, or `null`
 * when the timeline is exhausted. There is no `hasMore` field — a non-null
 * `nextCursor` is the signal that another page remains.
 */
interface ChannelMessagesPage {
  messages: MessageWithAuthor[];
  nextCursor: string | null;
}

/**
 * Minimal shape of the centralized error envelope produced by
 * `middleware/error-handler.ts`, used to narrow a failure response body when
 * asserting on the machine-readable `error` label or the human `message`.
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

describe('Channel routes — GET/POST /api/channels, POST /:id/join, POST /:id/leave, GET /:id/messages', () => {
  let app: Application;

  beforeAll(() => {
    // createTestApp() builds the bare production Express app. The channel routes
    // emit NO Socket.io events (channel create/join/leave broadcast nothing per
    // AAP §0.4.5), so — unlike the message routes — no `io` stub is registered.
    app = createTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await closeTestResources();
  });

  /**
   * Creates a channel via `POST /api/channels` and returns its id. Local to this
   * suite (the shared `createTestChannel` helper sits outside this file's import
   * whitelist); inlining keeps the dependency surface to the six whitelisted
   * `setup.ts` exports. The body is narrowed to the shared `Channel` DTO before
   * the id is read so no unsafe `any` member access occurs.
   */
  const createChannelReturningId = async (token: string, isPrivate: boolean): Promise<string> => {
    const response = await request(app)
      .post('/api/channels')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: uniqueChannelName(), isPrivate })
      .expect(201);
    return (response.body as Channel).id;
  };

  // -------------------------------------------------------------------------
  // POST /api/channels — create
  // -------------------------------------------------------------------------
  describe('POST /api/channels — happy path', () => {
    it('creates a public channel and returns 201 with the Channel DTO', async () => {
      const { token, user } = await registerUser();
      const channelName = uniqueChannelName();

      const response = await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: channelName, description: 'A test channel', isPrivate: false })
        .expect(201);

      const channel = response.body as Channel;
      expect(typeof channel.id).toBe('string');
      expect(channel.id.length).toBeGreaterThan(0);
      expect(channel.name).toBe(channelName);
      expect(channel.description).toBe('A test channel');
      expect(channel.isPrivate).toBe(false);
      expect(channel.createdById).toBe(user.id);
      expect(typeof channel.createdAt).toBe('string');
    });

    it('creates a private channel and returns 201 with isPrivate true', async () => {
      const { token } = await registerUser();

      const response = await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: uniqueChannelName(), isPrivate: true })
        .expect(201);

      const channel = response.body as Channel;
      expect(channel.isPrivate).toBe(true);
    });

    it('auto-adds the creator as a channel owner (ChannelMember side effect)', async () => {
      const { token, user } = await registerUser();

      const response = await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: uniqueChannelName(), isPrivate: false })
        .expect(201);
      const channel = response.body as Channel;

      // READ-ONLY direct DB assertion of the persisted membership (not user
      // creation — Rule 4 forbids only direct USER inserts, not reads).
      const memberships = await prismaTest.channelMember.findMany({
        where: { channelId: channel.id, userId: user.id },
      });
      expect(memberships).toHaveLength(1);

      const [member] = memberships;
      if (member === undefined) {
        throw new Error('expected exactly one owner membership row');
      }
      // Assert the key persisted fields against the shared ChannelMember DTO
      // contract. `joinedAt` is intentionally excluded — it is a `Date` on the
      // Prisma row but a `string` on the DTO — so the projection compares only
      // the structurally-identical `channelId`/`userId`/`role` fields.
      const expectedMembership: Pick<ChannelMember, 'channelId' | 'userId' | 'role'> = {
        channelId: channel.id,
        userId: user.id,
        role: 'owner',
      };
      expect(member).toMatchObject(expectedMembership);
    });

    it('trims surrounding whitespace from the channel name and description', async () => {
      const { token } = await registerUser();
      const channelName = uniqueChannelName();

      const response = await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: `  ${channelName}  `, description: '  trimmed  ', isPrivate: false })
        .expect(201);

      const channel = response.body as Channel;
      expect(channel.name).toBe(channelName);
      expect(channel.description).toBe('trimmed');
    });
  });

  describe('POST /api/channels — Gate 12 validation (createChannelSchema)', () => {
    it('rejects a name with capital letters (regex /^[a-z0-9_-]+$/) with 400', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'General', isPrivate: false })
        .expect(400);
    });

    it('rejects a name containing spaces with 400', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'general chat', isPrivate: false })
        .expect(400);
    });

    it('rejects a name containing special characters with 400', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'general!@#', isPrivate: false })
        .expect(400);
    });

    it('rejects a name exceeding MAX_CHANNEL_NAME_LENGTH with 400', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'a'.repeat(MAX_CHANNEL_NAME_LENGTH + 1), isPrivate: false })
        .expect(400);
    });

    it('rejects an empty name with 400', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '', isPrivate: false })
        .expect(400);
    });

    it('rejects a description exceeding MAX_CHANNEL_DESCRIPTION_LENGTH with 400', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: uniqueChannelName(),
          description: 'a'.repeat(MAX_CHANNEL_DESCRIPTION_LENGTH + 1),
          isPrivate: false,
        })
        .expect(400);
    });

    it('rejects a missing isPrivate flag with 400 (the schema declares no default)', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: uniqueChannelName() })
        .expect(400);
    });

    it('rejects isPrivate sent as a string instead of a boolean with 400', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: uniqueChannelName(), isPrivate: 'false' })
        .expect(400);
    });

    it('rejects unknown fields per the .strict() schema with 400', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: uniqueChannelName(), isPrivate: false, ownerId: 'malicious' })
        .expect(400);
    });
  });

  describe('POST /api/channels — duplicate name', () => {
    it('returns 409 when the channel name already exists (Prisma P2002 unwrapped)', async () => {
      const { token } = await registerUser();
      const channelName = uniqueChannelName();

      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: channelName, isPrivate: false })
        .expect(201);

      const response = await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: channelName, isPrivate: false })
        .expect(409);

      const body = response.body as ErrorResponseBody;
      expect(typeof body.error).toBe('string');
      expect(typeof body.message).toBe('string');
    });
  });

  describe('POST /api/channels — auth', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app)
        .post('/api/channels')
        .send({ name: uniqueChannelName(), isPrivate: false })
        .expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/channels — list channels visible to the caller
  // -------------------------------------------------------------------------
  describe('GET /api/channels', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).get('/api/channels').expect(401);
    });

    it('returns an empty array when no channels exist', async () => {
      const { token } = await registerUser();
      const response = await request(app)
        .get('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const channels = response.body as ChannelSummary[];
      expect(channels).toEqual([]);
    });

    it('returns public channels visible to every authenticated user', async () => {
      const { token: creatorToken } = await registerUser();
      const channelName = uniqueChannelName();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${creatorToken}`)
        .send({ name: channelName, isPrivate: false })
        .expect(201);

      // A DIFFERENT, non-member user must still see the public channel.
      const { token: otherToken } = await registerUser();
      const response = await request(app)
        .get('/api/channels')
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(200);

      const channels = response.body as ChannelSummary[];
      expect(channels.some((c) => c.name === channelName && c.isPrivate === false)).toBe(true);
    });

    it('hides private channels from non-members', async () => {
      const { token: ownerToken } = await registerUser();
      const privateName = uniqueChannelName();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: privateName, isPrivate: true })
        .expect(201);

      const { token: outsiderToken } = await registerUser();
      const response = await request(app)
        .get('/api/channels')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(200);

      const channels = response.body as ChannelSummary[];
      expect(channels.find((c) => c.name === privateName)).toBeUndefined();
    });

    it('shows private channels to their members (the creating owner)', async () => {
      const { token: ownerToken } = await registerUser();
      const privateName = uniqueChannelName();
      await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: privateName, isPrivate: true })
        .expect(201);

      const response = await request(app)
        .get('/api/channels')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const channels = response.body as ChannelSummary[];
      expect(channels.some((c) => c.name === privateName && c.isPrivate === true)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/channels/:id/join
  // -------------------------------------------------------------------------
  describe('POST /api/channels/:id/join', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).post(`/api/channels/${PLACEHOLDER_CUID}/join`).expect(401);
    });

    it('allows joining a public channel and persists the membership', async () => {
      const { token: ownerToken } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, false);

      const { token: joinerToken, user: joiner } = await registerUser();
      await request(app)
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);

      const membership = await prismaTest.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId: joiner.id } },
      });
      expect(membership).not.toBeNull();
    });

    it('denies joining a private channel with 403', async () => {
      const { token: ownerToken } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, true);

      const { token: outsiderToken } = await registerUser();
      const response = await request(app)
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403);

      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/(private|forbidden|access)/i);
    });

    it('returns 404 when the channel id is a valid cuid with no matching row', async () => {
      const { token } = await registerUser();
      await request(app)
        .post(`/api/channels/${MISSING_CUID}/join`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 400 when the channel id is not a valid cuid', async () => {
      const { token } = await registerUser();
      await request(app)
        .post('/api/channels/not-a-cuid/join')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('is idempotent — re-joining returns 200 (or 409 by implementation choice)', async () => {
      const { token: ownerToken } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, false);

      const { token: joinerToken } = await registerUser();
      await request(app)
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);

      const response = await request(app)
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', `Bearer ${joinerToken}`);
      expect([200, 409]).toContain(response.status);
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/channels/:id/leave
  // -------------------------------------------------------------------------
  describe('POST /api/channels/:id/leave', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).post(`/api/channels/${PLACEHOLDER_CUID}/leave`).expect(401);
    });

    it('allows leaving a channel the user joined and removes the membership', async () => {
      const { token: ownerToken } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, false);

      const { token: joinerToken, user: joiner } = await registerUser();
      await request(app)
        .post(`/api/channels/${channelId}/join`)
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);
      await request(app)
        .post(`/api/channels/${channelId}/leave`)
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);

      const membership = await prismaTest.channelMember.findUnique({
        where: { channelId_userId: { channelId, userId: joiner.id } },
      });
      expect(membership).toBeNull();
    });

    it('returns 404 or 403 when leaving a channel the user is not a member of', async () => {
      const { token: ownerToken } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, false);

      const { token: nonMemberToken } = await registerUser();
      const response = await request(app)
        .post(`/api/channels/${channelId}/leave`)
        .set('Authorization', `Bearer ${nonMemberToken}`);
      expect([403, 404]).toContain(response.status);
    });

    it('returns 404 when the channel id is a valid cuid with no matching row', async () => {
      const { token } = await registerUser();
      await request(app)
        .post(`/api/channels/${MISSING_CUID}/leave`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/channels/:id — channel detail (description + hydrated members)
  //
  // ACL mirrors GET /:id/messages (permissive read), NOT the stricter
  // assertChannelAccess: a PUBLIC channel is readable by any authenticated user
  // (no membership required) while a PRIVATE channel is members-only (403).
  // -------------------------------------------------------------------------
  describe('GET /api/channels/:id', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).get(`/api/channels/${PLACEHOLDER_CUID}`).expect(401);
    });

    it('returns 400 when the channel id is not a valid cuid', async () => {
      const { token } = await registerUser();
      await request(app)
        .get('/api/channels/not-a-cuid')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('returns 404 when the channel id is a valid cuid with no matching row', async () => {
      const { token } = await registerUser();
      await request(app)
        .get(`/api/channels/${MISSING_CUID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns the public channel detail with description and hydrated members', async () => {
      const { token, user } = await registerUser();
      const channelName = uniqueChannelName();
      const created = await request(app)
        .post('/api/channels')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: channelName, description: 'a public room', isPrivate: false })
        .expect(201);
      const channelId = (created.body as Channel).id;

      const response = await request(app)
        .get(`/api/channels/${channelId}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ChannelWithMembers;
      expect(body.id).toBe(channelId);
      expect(body.name).toBe(channelName);
      expect(body.description).toBe('a public room');
      expect(body.isPrivate).toBe(false);
      // The creator is auto-enrolled as the sole member (owner role).
      expect(body.memberCount).toBe(1);
      expect(body.members).toHaveLength(1);
      const [member] = body.members;
      if (member === undefined) {
        throw new Error('expected the creator to be enrolled as a member');
      }
      expect(member.userId).toBe(user.id);
      expect(member.role).toBe('owner');
      expect(member.user.id).toBe(user.id);
    });

    it('allows any authenticated user to read a PUBLIC channel they have not joined', async () => {
      const { token: ownerToken } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, false);

      const { token: outsiderToken } = await registerUser();
      const response = await request(app)
        .get(`/api/channels/${channelId}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(200);

      expect((response.body as ChannelWithMembers).id).toBe(channelId);
    });

    it('allows a MEMBER to read a PRIVATE channel detail', async () => {
      const { token: ownerToken, user: owner } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, true);

      const response = await request(app)
        .get(`/api/channels/${channelId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const body = response.body as ChannelWithMembers;
      expect(body.isPrivate).toBe(true);
      const [member] = body.members;
      if (member === undefined) {
        throw new Error('expected the owner to be a member of the private channel');
      }
      expect(member.userId).toBe(owner.id);
    });

    it('denies a NON-member reading a PRIVATE channel detail with 403', async () => {
      const { token: ownerToken } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, true);

      const { token: outsiderToken } = await registerUser();
      const response = await request(app)
        .get(`/api/channels/${channelId}`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403);

      const body = response.body as ErrorResponseBody;
      expect(body.message).toMatch(/(private|forbidden|access)/i);
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/channels/:id/messages — cursor-paginated channel history
  // -------------------------------------------------------------------------
  describe('GET /api/channels/:id/messages', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).get(`/api/channels/${PLACEHOLDER_CUID}/messages`).expect(401);
    });

    it('returns 200 with an empty envelope for a brand-new channel', async () => {
      const { token } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      const response = await request(app)
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ChannelMessagesPage;
      expect(body.messages).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });

    it('returns up to PAGE_SIZE (50) messages by default with a forward cursor', async () => {
      const { token, user } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      // Seed 60 messages directly via Prisma (non-user fixtures — Rule 4 only
      // forbids direct USER inserts) so this READ test skips the write path.
      await prismaTest.message.createMany({
        data: Array.from({ length: 60 }, (_, i) => ({
          content: `Message ${i}`,
          authorId: user.id,
          channelId,
          parentId: null,
        })),
      });

      const response = await request(app)
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ChannelMessagesPage;
      expect(body.messages).toHaveLength(PAGE_SIZE);
      expect(typeof body.nextCursor).toBe('string');
    });

    it('honours an explicit limit up to MAX_PAGE_SIZE (100)', async () => {
      const { token, user } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      await prismaTest.message.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          content: `Message ${i}`,
          authorId: user.id,
          channelId,
          parentId: null,
        })),
      });

      const response = await request(app)
        .get(`/api/channels/${channelId}/messages?limit=${MAX_PAGE_SIZE}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ChannelMessagesPage;
      expect(body.messages).toHaveLength(MAX_PAGE_SIZE);
    });

    it('clamps a limit above MAX_PAGE_SIZE to MAX_PAGE_SIZE (capped, not rejected) (§0.8.4)', async () => {
      const { token, user } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      // Seed >MAX_PAGE_SIZE messages so the clamp is observable: an over-cap
      // limit returns exactly MAX_PAGE_SIZE rows rather than the requested 999.
      await prismaTest.message.createMany({
        data: Array.from({ length: 120 }, (_, i) => ({
          content: `Message ${i}`,
          authorId: user.id,
          channelId,
          parentId: null,
        })),
      });

      // Per the AAP §0.8.4 pagination contract the schema CLAMPS an over-cap
      // `limit` to MAX_PAGE_SIZE and returns 200 (it does NOT reject with 400);
      // a non-positive / non-integer limit is still rejected by `.positive()` /
      // `.int()`, which run before the clamp transform (asserted elsewhere).
      const response = await request(app)
        .get(`/api/channels/${channelId}/messages?limit=999`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ChannelMessagesPage;
      expect(body.messages).toHaveLength(MAX_PAGE_SIZE);
    });

    it('paginates with the opaque cursor across two non-overlapping pages (50 then 25)', async () => {
      const { token, user } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      // Strictly increasing timestamps make the (createdAt, id) cursor ordering
      // deterministic across the page boundary.
      const baseTime = new Date('2025-01-01T00:00:00Z');
      await prismaTest.message.createMany({
        data: Array.from({ length: 75 }, (_, i) => ({
          content: `Message ${i}`,
          authorId: user.id,
          channelId,
          parentId: null,
          createdAt: new Date(baseTime.getTime() + i * 1000),
        })),
      });

      const page1Response = await request(app)
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const page1 = page1Response.body as ChannelMessagesPage;
      expect(page1.messages).toHaveLength(PAGE_SIZE);
      expect(typeof page1.nextCursor).toBe('string');

      const cursor = page1.nextCursor;
      if (cursor === null) {
        throw new Error('expected a forward cursor after the first page');
      }

      const page2Response = await request(app)
        .get(`/api/channels/${channelId}/messages?cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const page2 = page2Response.body as ChannelMessagesPage;
      expect(page2.messages).toHaveLength(25);
      expect(page2.nextCursor).toBeNull();

      // The two pages must be disjoint — a cursor page never repeats a row.
      const page1Ids = new Set(page1.messages.map((message) => message.id));
      const overlap = page2.messages.filter((message) => page1Ids.has(message.id));
      expect(overlap).toHaveLength(0);
    });

    it('orders messages newest-first (Slack-style timeline)', async () => {
      const { token, user } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      const baseTime = new Date('2025-01-01T00:00:00Z');
      await prismaTest.message.createMany({
        data: [
          {
            content: 'first',
            authorId: user.id,
            channelId,
            parentId: null,
            createdAt: new Date(baseTime.getTime()),
          },
          {
            content: 'second',
            authorId: user.id,
            channelId,
            parentId: null,
            createdAt: new Date(baseTime.getTime() + 1000),
          },
          {
            content: 'third',
            authorId: user.id,
            channelId,
            parentId: null,
            createdAt: new Date(baseTime.getTime() + 2000),
          },
        ],
      });

      const response = await request(app)
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ChannelMessagesPage;
      expect(body.messages.map((message) => message.content)).toEqual(['third', 'second', 'first']);
    });

    it('excludes thread replies from the channel timeline (parentId: null only)', async () => {
      const { token, user } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      const parent = await prismaTest.message.create({
        data: { content: 'parent', authorId: user.id, channelId, parentId: null },
      });
      await prismaTest.message.create({
        data: { content: 'reply', authorId: user.id, channelId, parentId: parent.id },
      });

      const response = await request(app)
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ChannelMessagesPage;
      expect(body.messages).toHaveLength(1);

      const [only] = body.messages;
      if (only === undefined) {
        throw new Error('expected exactly one top-level message');
      }
      expect(only.content).toBe('parent');
      expect(only.parentId).toBeNull();
    });

    it('hydrates each message with its author (MessageWithAuthor)', async () => {
      const { token, user } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      await prismaTest.message.create({
        data: { content: 'hello', authorId: user.id, channelId, parentId: null },
      });

      const response = await request(app)
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as ChannelMessagesPage;
      const [first] = body.messages;
      if (first === undefined) {
        throw new Error('expected exactly one hydrated message');
      }
      expect(first.content).toBe('hello');
      expect(first.authorId).toBe(user.id);
      expect(first).toMatchObject({
        author: { id: user.id, displayName: user.displayName },
      });
    });

    it('returns 403 when a non-member reads a private channel timeline', async () => {
      const { token: ownerToken } = await registerUser();
      const channelId = await createChannelReturningId(ownerToken, true);

      const { token: outsiderToken } = await registerUser();
      await request(app)
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(403);
    });

    it('returns 404 when the channel id is a valid cuid with no matching row', async () => {
      const { token } = await registerUser();
      await request(app)
        .get(`/api/channels/${MISSING_CUID}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
    });

    it('returns 400 for a malformed cursor', async () => {
      const { token } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      await request(app)
        .get(`/api/channels/${channelId}/messages?cursor=not-a-valid-cursor!!!`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // Gate 9 — channel history load latency (< 1 second)
  // -------------------------------------------------------------------------
  describe('GET /api/channels/:id/messages — performance (Gate 9)', () => {
    it('loads a 50-message page (of 100 seeded) in under 1 second', async () => {
      const { token, user } = await registerUser();
      const channelId = await createChannelReturningId(token, false);

      await prismaTest.message.createMany({
        data: Array.from({ length: 100 }, (_, i) => ({
          content: `Message ${i} with reasonable length content for realistic timing`,
          authorId: user.id,
          channelId,
          parentId: null,
        })),
      });

      const start = Date.now();
      const response = await request(app)
        .get(`/api/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const elapsedMs = Date.now() - start;

      const body = response.body as ChannelMessagesPage;
      expect(body.messages).toHaveLength(PAGE_SIZE);
      // Gate 9: channel history load < 1 second.
      expect(elapsedMs).toBeLessThan(1000);
    });
  });
});
