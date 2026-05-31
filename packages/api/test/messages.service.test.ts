/**
 * @file packages/api/test/messages.service.test.ts
 *
 * Jest service-level (unit) tests for the message service:
 *   - createMessage(input)        → MessageWithAuthor
 *   - listThreadReplies(input)    → { messages, nextCursor }
 *   - addReaction(input)          → MessageWithAuthor
 *   - removeReaction(input)       → MessageWithAuthor
 *
 * These tests drive the message functions DIRECTLY (not through the HTTP routes
 * exercised by messages.test.ts). Two classes of behavior are unreachable from
 * the route layer and are covered here:
 *   1. Service-layer defensive guards that the route's Zod schema would reject
 *      first (channel/DM XOR violation, oversized/empty content, a parent in a
 *      different channel/DM, a corrupted contextless message).
 *   2. The thread-reply CURSOR pagination — `GET /api/messages/:id/replies`
 *      intentionally returns the first page only (thread sizes are bounded in
 *      the PoC), so `encodeReplyCursor` / `decodeReplyCursor` / `resolveReplyLimit`
 *      and the DM-message reaction paths are only reachable by calling the
 *      service with an explicit cursor / limit / DM-scoped message.
 *
 * Compliance:
 *   Rule 3  — Zero-warning strict TypeScript (no `@ts-ignore`/`@ts-expect-error`;
 *             every promise is awaited; no unused bindings).
 *   Rule 4  — Every test user is created through `registerUser()`
 *             (`POST /api/auth/register`); only NON-user fixtures (Message,
 *             MessageReaction) are seeded via Prisma, which Rule 4 permits.
 *   Gate 13 — Lifts `services/messages.service.ts` line coverage past the ≥80%
 *             per-file floor (QA Checkpoint #2 finding C1).
 *
 * AAP refs: §0.1.1 (threads, reactions), §0.4.4 (Message/MessageReaction models),
 *           §0.6.2 (routes → services → Prisma), §0.8.2 Gate 13, §0.8.4
 *           (pagination contract: cursor, limit defaults 50 / caps 100).
 *
 * Behavioral contract (verified against services/messages.service.ts):
 *   - createMessage enforces channel/DM XOR, MAX_MESSAGE_LENGTH, content-or-file,
 *     single-level threads with a matching channel/DM context, and self-owned
 *     file attachments — each as a defense-in-depth guard behind the route Zod.
 *   - listThreadReplies reads replies oldest-first, fetches `limit + 1` rows to
 *     compute `nextCursor`, defaults an absent/<1 limit to 50, caps it at 100,
 *     and rejects a malformed cursor with a ValidationError.
 *   - add/removeReaction gate on channel/DM access, are idempotent, and surface
 *     a non-P2025 delete failure unchanged.
 *
 * Rationale for the non-trivial test decisions (driving the service directly to
 * reach the cursor/limit branches, seeding replies with explicit `createdAt` for
 * deterministic ordering, the spy-forced non-P2025 re-throw) lives in
 * /docs/decision-log.md per the Explainability rule, not in these comments.
 */

import {
  createMessage,
  listThreadReplies,
  addReaction,
  removeReaction,
} from '../src/services/messages.service.js';
import { ValidationError, NotFoundError } from '../src/middleware/errors.js';
import { MAX_MESSAGE_LENGTH, MAX_PAGE_SIZE } from '@app/shared/constants/limits';
import {
  cleanDatabase,
  closeTestResources,
  registerUser,
  createTestChannel,
  createTestDm,
  prismaTest,
} from './setup.js';

/** A standard Unicode emoji used across the reaction tests. */
const THUMBS_UP = '👍';

/** A well-formed cuid shape that resolves to no row (404 fixtures). */
const MISSING_CUID = 'clxnonexistent00000000000';

/** A second well-formed cuid placeholder for the XOR "both targets" fixture. */
const PLACEHOLDER_CUID = 'clx0000000000000000000000';

/**
 * Seed a channel + a top-level parent message + `replyCount` thread replies with
 * strictly increasing `createdAt` values (1s apart) so the oldest-first cursor
 * order is deterministic. Returns the caller id, channel id, and parent id.
 */
async function seedChannelThread(replyCount: number): Promise<{
  userId: string;
  channelId: string;
  parentId: string;
}> {
  const author = await registerUser();
  const channel = await createTestChannel({ token: author.token, isPrivate: false });
  const parent = await prismaTest.message.create({
    data: { content: 'thread parent', authorId: author.user.id, channelId: channel.id },
  });
  const base = Date.now();
  for (let i = 0; i < replyCount; i += 1) {
    await prismaTest.message.create({
      data: {
        content: `r${i + 1}`,
        authorId: author.user.id,
        channelId: channel.id,
        parentId: parent.id,
        createdAt: new Date(base + (i + 1) * 1_000),
      },
    });
  }
  return { userId: author.user.id, channelId: channel.id, parentId: parent.id };
}

/** Seed a message with NEITHER a channel nor a DM context (a corrupted row). */
async function createContextlessMessage(authorId: string): Promise<string> {
  const message = await prismaTest.message.create({
    data: { content: 'orphan', authorId, channelId: null, dmId: null, parentId: null },
  });
  return message.id;
}

beforeEach(async () => {
  await cleanDatabase();
});

afterAll(async () => {
  await closeTestResources();
});

describe('messages.service — createMessage validation guards', () => {
  it('rejects when NEITHER channelId nor dmId is set (XOR violation)', async () => {
    const author = await registerUser();

    await expect(
      createMessage({ authorId: author.user.id, content: 'no target' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects when BOTH channelId and dmId are set (XOR violation)', async () => {
    const author = await registerUser();

    await expect(
      createMessage({
        authorId: author.user.id,
        content: 'both targets',
        channelId: PLACEHOLDER_CUID,
        dmId: MISSING_CUID,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects content longer than MAX_MESSAGE_LENGTH', async () => {
    const author = await registerUser();
    const channel = await createTestChannel({ token: author.token, isPrivate: false });

    await expect(
      createMessage({
        authorId: author.user.id,
        content: 'a'.repeat(MAX_MESSAGE_LENGTH + 1),
        channelId: channel.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects empty content with no file attachment', async () => {
    const author = await registerUser();
    const channel = await createTestChannel({ token: author.token, isPrivate: false });

    await expect(
      createMessage({ authorId: author.user.id, content: '', channelId: channel.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('messages.service — createMessage thread + file guards', () => {
  it('rejects a reply whose parent lives in a DIFFERENT channel', async () => {
    const author = await registerUser();
    const channelA = await createTestChannel({ token: author.token, isPrivate: false });
    const channelB = await createTestChannel({ token: author.token, isPrivate: false });
    const parent = await prismaTest.message.create({
      data: { content: 'parent in A', authorId: author.user.id, channelId: channelA.id },
    });

    await expect(
      createMessage({
        authorId: author.user.id,
        content: 'reply targeting B',
        channelId: channelB.id,
        parentId: parent.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a reply whose parent lives in a DIFFERENT DM', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const carol = await registerUser();
    const dmX = await createTestDm({ token: alice.token, targetUserId: bob.user.id });
    const dmY = await createTestDm({ token: alice.token, targetUserId: carol.user.id });
    const parent = await prismaTest.message.create({
      data: { content: 'parent in X', authorId: alice.user.id, dmId: dmX.id },
    });

    await expect(
      createMessage({
        authorId: alice.user.id,
        content: 'reply targeting Y',
        dmId: dmY.id,
        parentId: parent.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an attachment whose fileId does not exist (404)', async () => {
    const author = await registerUser();
    const channel = await createTestChannel({ token: author.token, isPrivate: false });

    await expect(
      createMessage({
        authorId: author.user.id,
        content: 'with missing file',
        channelId: channel.id,
        fileId: MISSING_CUID,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('messages.service — listThreadReplies pagination', () => {
  it('paginates replies across pages using the opaque cursor', async () => {
    const { userId, parentId } = await seedChannelThread(3);

    const page1 = await listThreadReplies({ parentId, userId, limit: 2 });
    expect(page1.messages.map((m) => m.content)).toEqual(['r1', 'r2']);
    expect(page1.nextCursor).not.toBeNull();

    const cursor = page1.nextCursor;
    if (cursor === null) {
      throw new Error('expected a non-null cursor for the second page');
    }

    const page2 = await listThreadReplies({ parentId, userId, cursor, limit: 2 });
    expect(page2.messages.map((m) => m.content)).toEqual(['r3']);
    expect(page2.nextCursor).toBeNull();
  });

  it('clamps a limit above MAX_PAGE_SIZE and returns all available replies', async () => {
    const { userId, parentId } = await seedChannelThread(3);

    const result = await listThreadReplies({ parentId, userId, limit: MAX_PAGE_SIZE + 50 });

    expect(result.messages).toHaveLength(3);
    expect(result.nextCursor).toBeNull();
  });

  it('falls back to the default page size when limit is below 1', async () => {
    const { userId, parentId } = await seedChannelThread(3);

    const result = await listThreadReplies({ parentId, userId, limit: 0 });

    expect(result.messages.map((m) => m.content)).toEqual(['r1', 'r2', 'r3']);
    expect(result.nextCursor).toBeNull();
  });

  it('rejects a malformed pagination cursor', async () => {
    const { userId, parentId } = await seedChannelThread(1);

    await expect(
      listThreadReplies({ parentId, userId, cursor: 'not-a-valid-cursor!!!' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('messages.service — listThreadReplies access + context', () => {
  it('lists replies for a DM-scoped parent thread', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const dm = await createTestDm({ token: alice.token, targetUserId: bob.user.id });
    const parent = await prismaTest.message.create({
      data: { content: 'dm parent', authorId: alice.user.id, dmId: dm.id },
    });
    await prismaTest.message.create({
      data: { content: 'dm reply', authorId: alice.user.id, dmId: dm.id, parentId: parent.id },
    });

    const result = await listThreadReplies({ parentId: parent.id, userId: alice.user.id });

    expect(result.messages.map((m) => m.content)).toEqual(['dm reply']);
  });

  it('rejects a parent that has neither a channel nor a DM context', async () => {
    const author = await registerUser();
    const orphanId = await createContextlessMessage(author.user.id);

    await expect(
      listThreadReplies({ parentId: orphanId, userId: author.user.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('messages.service — addReaction', () => {
  it('adds a reaction to a DM-scoped message', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const dm = await createTestDm({ token: alice.token, targetUserId: bob.user.id });
    const message = await prismaTest.message.create({
      data: { content: 'dm hi', authorId: alice.user.id, dmId: dm.id },
    });

    const result = await addReaction({
      messageId: message.id,
      userId: alice.user.id,
      emoji: THUMBS_UP,
    });

    const reaction = result.reactions.find((r) => r.emoji === THUMBS_UP);
    expect(reaction).toBeDefined();
    expect(reaction?.count).toBe(1);
    expect(reaction?.hasCurrentUser).toBe(true);
  });

  it('rejects adding a reaction to a contextless message', async () => {
    const author = await registerUser();
    const orphanId = await createContextlessMessage(author.user.id);

    await expect(
      addReaction({ messageId: orphanId, userId: author.user.id, emoji: THUMBS_UP }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('messages.service — removeReaction', () => {
  it('rejects removing a reaction from a non-existent message (404)', async () => {
    const author = await registerUser();

    await expect(
      removeReaction({ messageId: MISSING_CUID, userId: author.user.id, emoji: THUMBS_UP }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('removes a reaction from a DM-scoped message', async () => {
    const alice = await registerUser();
    const bob = await registerUser();
    const dm = await createTestDm({ token: alice.token, targetUserId: bob.user.id });
    const message = await prismaTest.message.create({
      data: { content: 'dm reactable', authorId: alice.user.id, dmId: dm.id },
    });
    await addReaction({ messageId: message.id, userId: alice.user.id, emoji: THUMBS_UP });

    const result = await removeReaction({
      messageId: message.id,
      userId: alice.user.id,
      emoji: THUMBS_UP,
    });

    expect(result.reactions.find((r) => r.emoji === THUMBS_UP)).toBeUndefined();
  });

  it('rejects removing a reaction from a contextless message', async () => {
    const author = await registerUser();
    const orphanId = await createContextlessMessage(author.user.id);

    await expect(
      removeReaction({ messageId: orphanId, userId: author.user.id, emoji: THUMBS_UP }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('re-throws a non-P2025 failure from the underlying delete', async () => {
    const author = await registerUser();
    const channel = await createTestChannel({ token: author.token, isPrivate: false });
    const message = await prismaTest.message.create({
      data: { content: 'reactable', authorId: author.user.id, channelId: channel.id },
    });
    await addReaction({ messageId: message.id, userId: author.user.id, emoji: THUMBS_UP });

    // Force a NON-P2025 failure from the underlying delete so the catch block's
    // re-throw branch (messages.service.ts:666) executes. The service shares this
    // exact PrismaClient instance — setup.ts re-exports the @app/db singleton as
    // `prismaTest` — so replacing the delegate method here intercepts the call the
    // service makes. The `jest` mock object is not a runtime global under the ESM
    // (experimental-vm-modules) runner, so the delegate method is swapped directly
    // via Object.defineProperty and restored in `finally` to isolate this test.
    // `.bind` keeps the delegate as `this` (identical to a normal call) and
    // satisfies @typescript-eslint/unbound-method when capturing the method.
    const originalDelete = prismaTest.messageReaction.delete.bind(prismaTest.messageReaction);
    let deleteCalls = 0;
    Object.defineProperty(prismaTest.messageReaction, 'delete', {
      configurable: true,
      writable: true,
      value: () => {
        deleteCalls += 1;
        throw new Error('db down');
      },
    });

    try {
      await expect(
        removeReaction({ messageId: message.id, userId: author.user.id, emoji: THUMBS_UP }),
      ).rejects.toThrow('db down');
      expect(deleteCalls).toBe(1);
    } finally {
      Object.defineProperty(prismaTest.messageReaction, 'delete', {
        configurable: true,
        writable: true,
        value: originalDelete,
      });
    }
  });
});
