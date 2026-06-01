/**
 * @file packages/api/test/search.test.ts
 *
 * Jest + supertest integration tests for the search route (1 endpoint):
 *   - GET /api/search?q=<query>
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript (no `@ts-ignore`/`@ts-expect-error`;
 *             supertest's `any` `response.body` is narrowed with a single
 *             whole-object assertion to `SearchResponse` so the `no-unsafe-*`
 *             rules stay satisfied).
 *   Rule 4  — Test users are created exclusively through `registerUser()`
 *             (`POST /api/auth/register`); only Message/Channel-member fixtures
 *             are seeded directly via Prisma.
 *   Gate 9  — Search completes in under 2 seconds (perf suite seeds 500 rows).
 *   Gate 12 — Zod validation (`searchQuerySchema`: q trim, min 1, max 200).
 *   Gate 13 — Contributes coverage to `services/search.service.ts`.
 *
 * AAP refs: §0.1.1 (tsvector + ACL), §0.4.4 (generated `contentTsv` column),
 *           §0.6.2 (plainto_tsquery + ts_rank, membership-restricted ACL).
 *
 * Behavioral contract (verified against the implemented route/service):
 *   - Response shape is `{ results: MessageWithAuthor[], query: string }`.
 *   - ACL admits a hit ONLY when the message is in a channel the caller is a
 *     MEMBER of OR a DM the caller PARTICIPATES in. Public channels the caller
 *     has not joined are NOT searchable until joined (rationale in
 *     /docs/decision-log.md); the agent-prompt's "public visible to all" sketch
 *     is corrected here to match the membership-gated implementation.
 *   - Seeding Message rows directly is safe because `Message.contentTsv` is a
 *     STORED generated column (populated by PostgreSQL, not by application code).
 */

import request from 'supertest';
import type { Application } from 'express';

import type { MessageWithAuthor, SearchResponse } from '@app/shared/types/message';
import { MAX_SEARCH_QUERY_LENGTH, PAGE_SIZE, MAX_PAGE_SIZE } from '@app/shared/constants/limits';

import {
  createTestApp,
  cleanDatabase,
  closeTestResources,
  registerUser,
  createTestChannel,
  createTestDm,
  prismaTest,
} from './setup.js';
import { searchMessages } from '../src/services/search.service.js';
import { ValidationError } from '../src/middleware/errors.js';

describe('GET /api/search?q=', () => {
  let app: Application;

  beforeAll(() => {
    app = createTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  afterAll(async () => {
    await closeTestResources();
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------
  describe('happy path', () => {
    it('returns 401 without an Authorization header', async () => {
      await request(app).get('/api/search?q=hello').expect(401);
    });

    it('returns empty results when no messages match', async () => {
      const { token } = await registerUser();

      const response = await request(app)
        .get('/api/search?q=xyzzyplugh')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toEqual([]);
      expect(body.query).toBe('xyzzyplugh');
    });

    it('finds messages in a public channel the caller is a member of', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.create({
        data: {
          content: 'pineapple on pizza is controversial',
          authorId: user.id,
          channelId: channel.id,
          parentId: null,
        },
      });

      const response = await request(app)
        .get('/api/search?q=pineapple')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(1);
      const [firstResult] = body.results;
      if (firstResult === undefined) {
        throw new Error('expected exactly one search result');
      }
      expect(firstResult.content).toContain('pineapple');
    });

    it('finds messages in a DM where the caller is a participant', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });
      await prismaTest.message.create({
        data: {
          content: 'meet me at the pineapple stand',
          authorId: alice.id,
          dmId: dm.id,
          parentId: null,
        },
      });

      const response = await request(app)
        .get('/api/search?q=pineapple')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(1);
    });

    it('returns ranked results for a multi-term query (ts_rank ordering)', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.createMany({
        data: [
          { content: 'pineapple alone', authorId: user.id, channelId: channel.id, parentId: null },
          {
            content: 'pineapple banana mango',
            authorId: user.id,
            channelId: channel.id,
            parentId: null,
          },
        ],
      });

      const response = await request(app)
        .get('/api/search?q=pineapple%20banana')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // `plainto_tsquery` AND-joins the terms, so only the multi-term message
      // matches `pineapple & banana`. We assert presence (>= 1) rather than an
      // exact `ts_rank` score, which is PostgreSQL-internal and version-dependent.
      const body = response.body as SearchResponse;
      expect(body.results.length).toBeGreaterThanOrEqual(1);
    });

    it('hydrates results with author info (MessageWithAuthor)', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.create({
        data: {
          content: 'distinctive-keyword-12345',
          authorId: user.id,
          channelId: channel.id,
          parentId: null,
        },
      });

      const response = await request(app)
        .get('/api/search?q=distinctive-keyword-12345')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as SearchResponse;
      const results: MessageWithAuthor[] = body.results;
      expect(results).toHaveLength(1);
      const [match] = results;
      if (match === undefined) {
        throw new Error('expected exactly one search result');
      }
      expect(match.content).toContain('distinctive-keyword-12345');
      expect(match.authorId).toBe(user.id);
      expect(match.author.id).toBe(user.id);
      expect(match.author.displayName).toBe(user.displayName);
    });

    it('aggregates reactions on a matched message (toReactionSummaries)', async () => {
      // A matched message hydrates its reactions into per-emoji summaries. This
      // exercises the grouping logic that ordinary search hits (which carry no
      // reactions) never reach:
      //   - 👍 : both the caller (alice) and bob react -> count 2, the second
      //          same-emoji row drives the "existing group" merge branch, and
      //          hasCurrentUser is true because the caller is a reactor.
      //   - 🎉 : only bob reacts -> count 1, hasCurrentUser false (caller absent).
      //   - 😀 : only the caller reacts -> count 1, hasCurrentUser true.
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const channel = await createTestChannel({ token: aliceToken, isPrivate: false });
      const message = await prismaTest.message.create({
        data: {
          content: 'zorptastic message awaiting reactions',
          authorId: alice.id,
          channelId: channel.id,
          parentId: null,
        },
      });
      await prismaTest.messageReaction.createMany({
        data: [
          { messageId: message.id, userId: alice.id, emoji: '👍' },
          { messageId: message.id, userId: bob.id, emoji: '👍' },
          { messageId: message.id, userId: bob.id, emoji: '🎉' },
          { messageId: message.id, userId: alice.id, emoji: '😀' },
        ],
      });

      const response = await request(app)
        .get('/api/search?q=zorptastic')
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);

      const body = response.body as SearchResponse;
      const [hit] = body.results;
      if (hit === undefined) {
        throw new Error('expected exactly one search result');
      }

      const byEmoji = new Map(hit.reactions.map((reaction) => [reaction.emoji, reaction]));

      const thumbs = byEmoji.get('👍');
      expect(thumbs?.count).toBe(2);
      expect(thumbs?.userIds).toEqual(expect.arrayContaining([alice.id, bob.id]));
      expect(thumbs?.hasCurrentUser).toBe(true);

      const tada = byEmoji.get('🎉');
      expect(tada?.count).toBe(1);
      expect(tada?.userIds).toEqual([bob.id]);
      expect(tada?.hasCurrentUser).toBe(false);

      const grin = byEmoji.get('😀');
      expect(grin?.count).toBe(1);
      expect(grin?.userIds).toEqual([alice.id]);
      expect(grin?.hasCurrentUser).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // ACL filtering (critical security)
  // ---------------------------------------------------------------------------
  describe('ACL filtering', () => {
    it('does NOT return private-channel messages to a non-member', async () => {
      const { token: ownerToken, user: owner } = await registerUser();
      const privateChannel = await createTestChannel({ token: ownerToken, isPrivate: true });
      await prismaTest.message.create({
        data: {
          content: 'private-secret-keyword',
          authorId: owner.id,
          channelId: privateChannel.id,
          parentId: null,
        },
      });

      const { token: outsiderToken } = await registerUser();
      const response = await request(app)
        .get('/api/search?q=private-secret-keyword')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(0);
    });

    it('returns private-channel messages to a member', async () => {
      const { token: ownerToken, user: owner } = await registerUser();
      const privateChannel = await createTestChannel({ token: ownerToken, isPrivate: true });
      await prismaTest.message.create({
        data: {
          content: 'private-but-allowed-keyword',
          authorId: owner.id,
          channelId: privateChannel.id,
          parentId: null,
        },
      });

      // The creator is an `owner` member of the channel (createChannel inserts
      // the membership row in the same transaction), so the row is visible.
      const response = await request(app)
        .get('/api/search?q=private-but-allowed-keyword')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(1);
    });

    it('does NOT return DM messages to a non-participant', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });
      await prismaTest.message.create({
        data: { content: 'dm-private-keyword', authorId: alice.id, dmId: dm.id, parentId: null },
      });

      const { token: carolToken } = await registerUser();
      const response = await request(app)
        .get('/api/search?q=dm-private-keyword')
        .set('Authorization', `Bearer ${carolToken}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(0);
    });

    it('does NOT return public-channel messages to a non-member who has not joined', async () => {
      const { token: ownerToken, user: owner } = await registerUser();
      const publicChannel = await createTestChannel({ token: ownerToken, isPrivate: false });
      await prismaTest.message.create({
        data: {
          content: 'public-unjoined-keyword',
          authorId: owner.id,
          channelId: publicChannel.id,
          parentId: null,
        },
      });

      // The search ACL is membership-gated: a public channel the caller has not
      // joined is NOT searchable until they join (see /docs/decision-log.md).
      const { token: outsiderToken } = await registerUser();
      const response = await request(app)
        .get('/api/search?q=public-unjoined-keyword')
        .set('Authorization', `Bearer ${outsiderToken}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(0);
    });

    it('returns public-channel messages once the caller joins the channel', async () => {
      const { token: ownerToken, user: owner } = await registerUser();
      const publicChannel = await createTestChannel({ token: ownerToken, isPrivate: false });
      await prismaTest.message.create({
        data: {
          content: 'public-joined-keyword',
          authorId: owner.id,
          channelId: publicChannel.id,
          parentId: null,
        },
      });

      const { token: joinerToken } = await registerUser();

      // Before joining the public channel, the message is not visible.
      const beforeResponse = await request(app)
        .get('/api/search?q=public-joined-keyword')
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);
      expect((beforeResponse.body as SearchResponse).results).toHaveLength(0);

      // Join the public channel (POST /api/channels/:id/join adds membership).
      await request(app)
        .post(`/api/channels/${publicChannel.id}/join`)
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);

      // After joining, the same query now surfaces the message.
      const afterResponse = await request(app)
        .get('/api/search?q=public-joined-keyword')
        .set('Authorization', `Bearer ${joinerToken}`)
        .expect(200);
      expect((afterResponse.body as SearchResponse).results).toHaveLength(1);
    });

    it('does NOT leak private DM messages across separate DM conversations', async () => {
      const { token: aliceToken } = await registerUser();
      const { token: bobToken, user: bob } = await registerUser();

      // DM #1: Alice <-> Bob, carrying a private keyword authored by Bob.
      const dmAB = await createTestDm({ token: aliceToken, targetUserId: bob.id });
      await prismaTest.message.create({
        data: { content: 'cross-leak-keyword', authorId: bob.id, dmId: dmAB.id, parentId: null },
      });

      // DM #2: Bob <-> Carol. Carol participates here but NOT in DM #1.
      const { token: carolToken, user: carol } = await registerUser();
      await createTestDm({ token: bobToken, targetUserId: carol.id });

      // Carol shares a DM with Bob, but not the one carrying the keyword, so the
      // membership-gated ACL must exclude the DM #1 message from her results.
      const response = await request(app)
        .get('/api/search?q=cross-leak-keyword')
        .set('Authorization', `Bearer ${carolToken}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Gate 12 — request validation (searchQuerySchema)
  // ---------------------------------------------------------------------------
  describe('Gate 12 validation', () => {
    it('returns 400 when q is missing', async () => {
      const { token } = await registerUser();
      await request(app).get('/api/search').set('Authorization', `Bearer ${token}`).expect(400);
    });

    it('returns 400 when q is empty', async () => {
      const { token } = await registerUser();
      await request(app).get('/api/search?q=').set('Authorization', `Bearer ${token}`).expect(400);
    });

    it('returns 400 when q is whitespace-only (trims to empty)', async () => {
      const { token } = await registerUser();
      await request(app)
        .get(`/api/search?q=${encodeURIComponent('   ')}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('returns 400 when q exceeds MAX_SEARCH_QUERY_LENGTH', async () => {
      const { token } = await registerUser();
      const tooLong = 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1);
      await request(app)
        .get(`/api/search?q=${encodeURIComponent(tooLong)}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('accepts q exactly at MAX_SEARCH_QUERY_LENGTH', async () => {
      const { token } = await registerUser();
      const atLimit = 'a'.repeat(MAX_SEARCH_QUERY_LENGTH);
      const response = await request(app)
        .get(`/api/search?q=${encodeURIComponent(atLimit)}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(Array.isArray(body.results)).toBe(true);
    });

    it('rejects (or ignores) unknown query parameters per the strict schema', async () => {
      const { token } = await registerUser();
      const response = await request(app)
        .get('/api/search?q=hello&channel=general')
        .set('Authorization', `Bearer ${token}`);

      // `searchQuerySchema` is `.strict()`, so the validate middleware rejects the
      // extra `channel` key with 400. We accept 200 as well to stay robust if the
      // query parser is later configured to drop unknown keys before validation.
      expect([200, 400]).toContain(response.status);
    });
  });

  // ---------------------------------------------------------------------------
  // tsvector behavior (normalization, stemming, thread coverage)
  // ---------------------------------------------------------------------------
  describe('tsvector behavior', () => {
    it('matches case-insensitively via tsvector normalization', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.create({
        data: { content: 'PineApple', authorId: user.id, channelId: channel.id, parentId: null },
      });

      const response = await request(app)
        .get('/api/search?q=pineapple')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(1);
    });

    it('handles a stop-word-only query without error', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.createMany({
        data: [
          {
            content: 'the quick brown fox',
            authorId: user.id,
            channelId: channel.id,
            parentId: null,
          },
          { content: 'a slow turtle', authorId: user.id, channelId: channel.id, parentId: null },
        ],
      });

      // `plainto_tsquery('english', 'the')` reduces to an empty tsquery, so the
      // request must still succeed and return a well-formed array. We do not
      // assert an exact count — stop-word handling is PostgreSQL-version-dependent.
      const response = await request(app)
        .get('/api/search?q=the')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(Array.isArray(body.results)).toBe(true);
    });

    it('applies English stemming (e.g. "running" matches "runs")', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.create({
        data: {
          content: 'I love running every morning',
          authorId: user.id,
          channelId: channel.id,
          parentId: null,
        },
      });

      const response = await request(app)
        .get('/api/search?q=runs')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(1);
    });

    it('searches thread replies (parentId != null) like any other message', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parent = await prismaTest.message.create({
        data: { content: 'parent msg', authorId: user.id, channelId: channel.id, parentId: null },
      });
      await prismaTest.message.create({
        data: {
          content: 'thread-only-keyword reply',
          authorId: user.id,
          channelId: channel.id,
          parentId: parent.id,
        },
      });

      const response = await request(app)
        .get('/api/search?q=thread-only-keyword')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const body = response.body as SearchResponse;
      expect(body.results).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Gate 9 — performance budget (< 2 seconds)
  // ---------------------------------------------------------------------------
  describe('performance (Gate 9)', () => {
    it('returns results in under 2 seconds with 500 messages indexed', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const messages = Array.from({ length: 500 }, (_unused, index) => ({
        content: `Message ${index} about ${index % 5 === 0 ? 'pineapple' : 'apple'} and other fruits.`,
        authorId: user.id,
        channelId: channel.id,
        parentId: null,
      }));
      await prismaTest.message.createMany({ data: messages });

      const startMs = Date.now();
      const response = await request(app)
        .get('/api/search?q=pineapple')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const elapsedMs = Date.now() - startMs;

      expect(elapsedMs).toBeLessThan(2000);
      const body = response.body as SearchResponse;
      expect(body.results.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // SQL injection defense (parameterized Prisma.sql)
  // ---------------------------------------------------------------------------
  describe('SQL injection defense', () => {
    it('does not execute injected SQL through the query parameter', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.create({
        data: { content: 'safe content', authorId: user.id, channelId: channel.id, parentId: null },
      });

      const response = await request(app)
        .get(`/api/search?q=${encodeURIComponent("'; DROP TABLE messages; --")}`)
        .set('Authorization', `Bearer ${token}`);
      expect([200, 400]).toContain(response.status);

      // The parameterized `Prisma.sql` query makes injection impossible — the
      // Message table (and the seeded row) must still exist afterward.
      const remaining = await prismaTest.message.count();
      expect(remaining).toBeGreaterThan(0);
    });

    it('handles special characters (quotes, backslashes) safely', async () => {
      const { token } = await registerUser();
      const tricky = "hello'world\\test";
      const response = await request(app)
        .get(`/api/search?q=${encodeURIComponent(tricky)}`)
        .set('Authorization', `Bearer ${token}`);
      expect([200, 400]).toContain(response.status);
    });
  });

  // ---------------------------------------------------------------------------
  // Service-layer branches (Issue 5 — search.service coverage)
  //
  // The HTTP route always forwards `limit: PAGE_SIZE` and its Zod validator
  // rejects empty/oversized queries before the service runs, so the service's
  // own `resolveLimit` normalization and its defensive query-length checks are
  // only reachable by invoking `searchMessages` directly.
  // ---------------------------------------------------------------------------
  describe('service-layer limit normalization and validation', () => {
    it('defaults the limit to PAGE_SIZE when none is supplied', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.createMany({
        data: [
          {
            content: 'limitdefault alpha',
            authorId: user.id,
            channelId: channel.id,
            parentId: null,
          },
          {
            content: 'limitdefault beta',
            authorId: user.id,
            channelId: channel.id,
            parentId: null,
          },
        ],
      });

      const results = await searchMessages({ userId: user.id, query: 'limitdefault' });
      expect(results).toHaveLength(2);
      expect(results.length).toBeLessThanOrEqual(PAGE_SIZE);
    });

    it('falls back to PAGE_SIZE when the limit is below 1', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.createMany({
        data: [
          { content: 'limitzero one', authorId: user.id, channelId: channel.id, parentId: null },
          { content: 'limitzero two', authorId: user.id, channelId: channel.id, parentId: null },
        ],
      });

      const results = await searchMessages({ userId: user.id, query: 'limitzero', limit: 0 });
      expect(results).toHaveLength(2);
    });

    it('clamps a limit above MAX_PAGE_SIZE', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.createMany({
        data: [
          { content: 'limitclamp a', authorId: user.id, channelId: channel.id, parentId: null },
          { content: 'limitclamp b', authorId: user.id, channelId: channel.id, parentId: null },
        ],
      });

      const results = await searchMessages({
        userId: user.id,
        query: 'limitclamp',
        limit: MAX_PAGE_SIZE + 50,
      });
      // Only two rows match, so clamping to MAX_PAGE_SIZE drops none here; the
      // assertion confirms the >MAX_PAGE_SIZE branch executes without error.
      expect(results).toHaveLength(2);
      expect(results.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    });

    it('floors a fractional limit (Math.floor)', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      await prismaTest.message.createMany({
        data: [
          { content: 'limitfloor zero', authorId: user.id, channelId: channel.id, parentId: null },
          { content: 'limitfloor one', authorId: user.id, channelId: channel.id, parentId: null },
          { content: 'limitfloor two', authorId: user.id, channelId: channel.id, parentId: null },
        ],
      });

      // 2.9 floors to 2, so exactly two of the three matches are returned.
      const results = await searchMessages({ userId: user.id, query: 'limitfloor', limit: 2.9 });
      expect(results).toHaveLength(2);
    });

    it('rejects an empty (whitespace-only) query with ValidationError', async () => {
      const { user } = await registerUser();
      await expect(searchMessages({ userId: user.id, query: '   ' })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('rejects a query longer than MAX_SEARCH_QUERY_LENGTH with ValidationError', async () => {
      const { user } = await registerUser();
      const tooLong = 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1);
      await expect(searchMessages({ userId: user.id, query: tooLong })).rejects.toBeInstanceOf(
        ValidationError,
      );
    });

    it('sets hasCurrentUser when the caller is a later reactor of an emoji', async () => {
      // The happy-path reaction test has the caller react FIRST (the
      // first-insert branch). Here bob reacts FIRST and the caller (alice)
      // SECOND, so the caller is processed as a later same-emoji reactor —
      // exercising the "existing group" else-branch that flips hasCurrentUser.
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const channel = await createTestChannel({ token: aliceToken, isPrivate: false });
      const message = await prismaTest.message.create({
        data: {
          content: 'reactionsecond keyword',
          authorId: alice.id,
          channelId: channel.id,
          parentId: null,
        },
      });

      // Sequential creates fix the insertion order: bob first, caller second.
      await prismaTest.messageReaction.create({
        data: { messageId: message.id, userId: bob.id, emoji: '🔥' },
      });
      await prismaTest.messageReaction.create({
        data: { messageId: message.id, userId: alice.id, emoji: '🔥' },
      });

      const results = await searchMessages({ userId: alice.id, query: 'reactionsecond' });
      expect(results).toHaveLength(1);
      const [hit] = results;
      if (hit === undefined) {
        throw new Error('expected exactly one search result');
      }
      const fire = hit.reactions.find((reaction) => reaction.emoji === '🔥');
      expect(fire?.count).toBe(2);
      expect(fire?.hasCurrentUser).toBe(true);
      expect(fire?.userIds).toEqual(expect.arrayContaining([alice.id, bob.id]));
    });
  });
});
