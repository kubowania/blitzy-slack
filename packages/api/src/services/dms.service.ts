/**
 * Direct-message service — DM conversation management and DM message listing.
 *
 * Public surface:
 *   listDms(userId)                                 → DMWithParticipants[]
 *   startDm({ initiatorId, otherUserId })           → DMWithParticipants
 *   listDmMessages({ dmId, userId, cursor?, limit?})→ { messages, nextCursor }
 *
 * Layering and behavioral contract:
 *  - This service is the only layer permitted to touch Prisma for DM data.
 *    Routes and socket handlers call it and then emit any Socket.io events
 *    using the returned DTOs; this service NEVER touches Socket.io itself.
 *  - `listDms` returns only DMs the caller participates in, each hydrated with
 *    both participants and the timestamp of the most-recent message so the
 *    sidebar can order conversations and render the "other person" without an
 *    extra fetch.
 *  - `startDm` is idempotent: a DM is uniquely identified by the canonical
 *    (lower-id, higher-id) participant pair, so initiating a DM that already
 *    exists returns the existing conversation. It blocks self-DMs and verifies
 *    the target user exists before creating.
 *  - `listDmMessages` enforces participant access control, then paginates the
 *    DM timeline with the same opaque (createdAt, id) cursor contract used by
 *    the channel message timeline.
 */

import { prisma, Prisma } from '@app/db';
import type {
  DirectMessage as PrismaDirectMessage,
  DMParticipant as PrismaDMParticipant,
  Message as PrismaMessage,
  User as PrismaUser,
  MessageReaction as PrismaMessageReaction,
  File as PrismaFile,
} from '@app/db';

import { logger } from '../config/logger.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../middleware/errors.js';

import { PAGE_SIZE, MAX_PAGE_SIZE } from '@app/shared/constants/limits';
import type { DMWithParticipants, DMParticipantSummary } from '@app/shared/types/dm';
import type { MessageWithAuthor } from '@app/shared/types/message';
import type { StartDmInput } from '@app/shared/schemas/dm';

/**
 * Input contract for {@link startDm}. Routes construct this after Zod
 * validation, populating `initiatorId` from the authenticated principal and
 * `otherUserId` from the validated request body.
 *
 * `otherUserId` is anchored to the route validator's inferred
 * {@link StartDmInput} `targetUserId` field so the service signature and the
 * `POST /dms` Zod schema stay aligned on a single source of truth.
 */
export interface CreateOrFindDmInput {
  /** The user initiating the DM (the authenticated caller). */
  initiatorId: string;
  /** The target user; must differ from `initiatorId`. */
  otherUserId: StartDmInput['targetUserId'];
}

/**
 * Input contract for {@link listDmMessages}. `cursor` is the opaque token
 * returned as `nextCursor` by a previous page; `limit` defaults to
 * {@link PAGE_SIZE} and is capped server-side at {@link MAX_PAGE_SIZE}.
 */
export interface ListDmMessagesInput {
  /** Id of the direct-message conversation to read. */
  dmId: string;
  /** Id of the requesting user (must be a DM participant). */
  userId: string;
  /** Opaque pagination cursor from a previous page; omit for the first page. */
  cursor?: string;
  /** Page size; defaults to PAGE_SIZE, capped at MAX_PAGE_SIZE. */
  limit?: number;
}

/**
 * Result of {@link listDmMessages}: one page of messages (newest-first) plus
 * the cursor for the next (older) page, or `null` when no more pages exist.
 */
export interface ListDmMessagesResult {
  /** One page of DM messages, ordered newest-first. */
  messages: MessageWithAuthor[];
  /** Opaque cursor for the next (older) page, or `null` when exhausted. */
  nextCursor: string | null;
}

/**
 * Decoded form of an opaque pagination cursor: the `(createdAt, id)` of the
 * oldest message already returned to the caller.
 */
interface CursorPayload {
  /** ISO 8601 creation timestamp of the boundary message. */
  createdAt: string;
  /** Database id of the boundary message (tie-breaker for equal timestamps). */
  id: string;
}

/**
 * Encode a {@link CursorPayload} as a URL-safe base64 token. The token is
 * opaque to clients — they pass it back verbatim to fetch the next page.
 */
function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode an opaque pagination token back into a {@link CursorPayload}.
 * Returns `null` for any malformed token (bad base64, invalid JSON, or a
 * shape that lacks the required string `createdAt` / `id` fields) so the
 * caller can surface a validation error rather than throwing here.
 */
function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'createdAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).createdAt === 'string' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize a requested page size into the permitted range: an absent or
 * non-positive value falls back to {@link PAGE_SIZE}; values above
 * {@link MAX_PAGE_SIZE} are clamped; fractional values are floored.
 */
function resolveLimit(input?: number): number {
  if (input === undefined) {
    return PAGE_SIZE;
  }
  if (input < 1) {
    return PAGE_SIZE;
  }
  if (input > MAX_PAGE_SIZE) {
    return MAX_PAGE_SIZE;
  }
  return Math.floor(input);
}

/**
 * Project a Prisma `User` record onto the compact participant summary embedded
 * in a DM DTO. The shape (`id`, `displayName`, `avatarUrl`) is structurally
 * identical to the shared `PublicUser`, so the result is assignable to the
 * `DMWithParticipants.participants` array.
 */
function toParticipantSummary(user: PrismaUser): DMParticipantSummary {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

/**
 * Map a fully-hydrated Prisma `DirectMessage` record (with its participants
 * joined to their users and the single most-recent message) onto the
 * `DMWithParticipants` DTO sent over the wire. `lastMessageAt` is the ISO
 * timestamp of the latest message, or `null` for an empty conversation.
 */
function toDmDto(
  record: PrismaDirectMessage & {
    participants: (PrismaDMParticipant & { user: PrismaUser })[];
    messages: { createdAt: Date }[];
  },
): DMWithParticipants {
  const latestMessage = record.messages[0];
  return {
    id: record.id,
    createdAt: record.createdAt.toISOString(),
    participants: record.participants.map((participant) =>
      toParticipantSummary(participant.user),
    ),
    lastMessageAt:
      latestMessage === undefined ? null : latestMessage.createdAt.toISOString(),
  };
}

/**
 * Project a Prisma `User` record onto the public author shape embedded in a
 * message DTO. Excludes `passwordHash`, `email`, and timestamps so the author
 * projection never leaks private fields to peers.
 */
function toAuthorDto(user: PrismaUser): {
  id: string;
  displayName: string;
  avatarUrl: string | null;
} {
  return {
    id: user.id,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

/**
 * Aggregate raw `MessageReaction` rows into the reaction summaries the client
 * renders as chips. Reactions are grouped by emoji; `count` is the number of
 * distinct reactors, `userIds` lists them, and `hasCurrentUser` is true when
 * the calling user is among them.
 */
function toReactionSummaries(
  reactions: PrismaMessageReaction[],
  callerUserId: string,
): { emoji: string; count: number; userIds: string[]; hasCurrentUser: boolean }[] {
  const grouped = new Map<
    string,
    { emoji: string; count: number; userIds: string[]; hasCurrentUser: boolean }
  >();

  for (const reaction of reactions) {
    const existing = grouped.get(reaction.emoji);
    if (existing === undefined) {
      grouped.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        userIds: [reaction.userId],
        hasCurrentUser: reaction.userId === callerUserId,
      });
    } else {
      existing.count += 1;
      existing.userIds.push(reaction.userId);
      if (reaction.userId === callerUserId) {
        existing.hasCurrentUser = true;
      }
    }
  }

  return Array.from(grouped.values());
}

/**
 * Map a fully-hydrated Prisma `Message` record (with its author, reactions,
 * optional file, and reply count) onto the `MessageWithAuthor` DTO sent over
 * the wire. Date fields are serialized to ISO 8601 strings and the file
 * attachment is augmented with its public download URL.
 */
function toMessageDto(
  record: PrismaMessage & {
    author: PrismaUser;
    reactions: PrismaMessageReaction[];
    file: PrismaFile | null;
    _count?: { replies: number };
  },
  callerUserId: string,
): MessageWithAuthor {
  return {
    id: record.id,
    content: record.content,
    authorId: record.authorId,
    author: toAuthorDto(record.author),
    channelId: record.channelId,
    dmId: record.dmId,
    parentId: record.parentId,
    fileId: record.fileId,
    file:
      record.file === null
        ? null
        : {
            id: record.file.id,
            originalName: record.file.originalName,
            storedName: record.file.storedName,
            mimeType: record.file.mimeType,
            sizeBytes: record.file.sizeBytes,
            uploadedById: record.file.uploadedById,
            url: `/api/files/${record.file.id}`,
            createdAt: record.file.createdAt.toISOString(),
          },
    reactions: toReactionSummaries(record.reactions, callerUserId),
    replyCount: record._count?.replies ?? 0,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * List every direct-message conversation the user participates in.
 *
 * Each conversation is hydrated with both participants and the timestamp of
 * its most-recent message. Results are ordered most-recently-active first
 * (latest message timestamp, falling back to the conversation creation time
 * for empty conversations). The result set is capped at `MAX_PAGE_SIZE`
 * conversations so the method can never return an unbounded list at PoC scale.
 *
 * @param userId - the requesting user's id.
 * @returns the user's DM conversations, newest-activity first.
 */
export async function listDms(userId: string): Promise<DMWithParticipants[]> {
  const dms = await prisma.directMessage.findMany({
    where: {
      participants: {
        some: { userId },
      },
    },
    include: {
      participants: {
        include: { user: true },
      },
      messages: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { createdAt: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_PAGE_SIZE,
  });

  const conversations = dms.map(toDmDto);

  // Order by effective activity (latest message, else creation time). ISO 8601
  // strings sort lexicographically in chronological order, so a string compare
  // yields a correct most-recent-first ordering.
  conversations.sort((a, b) => {
    const aKey = a.lastMessageAt ?? a.createdAt;
    const bKey = b.lastMessageAt ?? b.createdAt;
    if (aKey < bKey) {
      return 1;
    }
    if (aKey > bKey) {
      return -1;
    }
    return 0;
  });

  logger.debug({ userId, count: conversations.length }, 'dms.list.success');
  return conversations;
}

/**
 * Create or find the 1:1 direct-message conversation between two users.
 *
 * Idempotency is anchored on the canonical (lower-id, higher-id) participant
 * pair, which the database enforces with a unique constraint: initiating a DM
 * that already exists returns the existing conversation rather than creating a
 * duplicate. A concurrent creation that loses the unique-constraint race is
 * recovered by re-reading the conversation.
 *
 * @param input - the initiating user and the target user.
 * @returns the existing or newly-created conversation as a DTO.
 * @throws {ForbiddenError} when `initiatorId === otherUserId` (no self-DMs).
 * @throws {NotFoundError} when the target user does not exist.
 */
export async function startDm(
  input: CreateOrFindDmInput,
): Promise<DMWithParticipants> {
  const { initiatorId, otherUserId } = input;

  if (initiatorId === otherUserId) {
    throw new ForbiddenError('Cannot start a direct message with yourself');
  }

  const otherUser = await prisma.user.findUnique({
    where: { id: otherUserId },
    select: { id: true },
  });
  if (otherUser === null) {
    throw new NotFoundError('User not found');
  }

  // Canonical ordering: (A, B) and (B, A) collapse onto the same unique pair.
  const [participantOneId, participantTwoId] =
    initiatorId < otherUserId
      ? [initiatorId, otherUserId]
      : [otherUserId, initiatorId];

  const existing = await prisma.directMessage.findUnique({
    where: {
      participantOneId_participantTwoId: { participantOneId, participantTwoId },
    },
    include: {
      participants: {
        include: { user: true },
      },
      messages: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  if (existing !== null) {
    logger.debug(
      { dmId: existing.id, initiatorId, otherUserId },
      'dms.startDm.found',
    );
    return toDmDto(existing);
  }

  try {
    const created = await prisma.directMessage.create({
      data: {
        participantOneId,
        participantTwoId,
        participants: {
          create: [{ userId: participantOneId }, { userId: participantTwoId }],
        },
      },
      include: {
        participants: {
          include: { user: true },
        },
        messages: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { createdAt: true },
        },
      },
    });

    logger.info(
      { dmId: created.id, initiatorId, otherUserId },
      'dms.startDm.created',
    );
    return toDmDto(created);
  } catch (err) {
    // A concurrent caller may have created the same canonical pair between our
    // find and our create, tripping the unique constraint (P2002). Recover by
    // re-reading the now-existing conversation instead of surfacing the error.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    ) {
      const raced = await prisma.directMessage.findUnique({
        where: {
          participantOneId_participantTwoId: { participantOneId, participantTwoId },
        },
        include: {
          participants: {
            include: { user: true },
          },
          messages: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { createdAt: true },
          },
        },
      });
      if (raced !== null) {
        logger.debug(
          { dmId: raced.id, initiatorId, otherUserId },
          'dms.startDm.found',
        );
        return toDmDto(raced);
      }
    }
    throw err;
  }
}

/**
 * List messages in a direct-message conversation, paginated by opaque cursor.
 *
 * Access control: the caller must be a participant of the conversation. The
 * pagination contract is identical to the channel message timeline — an opaque
 * `(createdAt, id)` cursor, newest-first ordering, a peek of `limit + 1` rows
 * to compute `nextCursor`, and a `parentId: null` filter that excludes thread
 * replies from the main timeline.
 *
 * @param input - the DM id, requesting user id, and optional cursor / limit.
 * @returns one page of messages (newest-first) and the next-page cursor.
 * @throws {NotFoundError} when the conversation does not exist.
 * @throws {ForbiddenError} when the caller is not a participant.
 * @throws {ValidationError} when a supplied cursor is malformed.
 */
export async function listDmMessages(
  input: ListDmMessagesInput,
): Promise<ListDmMessagesResult> {
  const { dmId, userId, cursor } = input;
  const limit = resolveLimit(input.limit);

  const dm = await prisma.directMessage.findUnique({
    where: { id: dmId },
    select: { id: true },
  });
  if (dm === null) {
    throw new NotFoundError('Direct message not found');
  }

  const membership = await prisma.dMParticipant.findUnique({
    where: {
      dmId_userId: { dmId, userId },
    },
    select: { dmId: true },
  });
  if (membership === null) {
    throw new ForbiddenError('You do not have access to this DM');
  }

  const decodedCursor = cursor === undefined ? null : decodeCursor(cursor);
  if (cursor !== undefined && decodedCursor === null) {
    throw new ValidationError('Invalid cursor');
  }

  const cursorWhere: Prisma.MessageWhereInput =
    decodedCursor === null
      ? {}
      : {
          OR: [
            { createdAt: { lt: new Date(decodedCursor.createdAt) } },
            {
              createdAt: new Date(decodedCursor.createdAt),
              id: { lt: decodedCursor.id },
            },
          ],
        };

  const rows = await prisma.message.findMany({
    where: {
      dmId,
      parentId: null,
      ...cursorWhere,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    include: {
      author: true,
      reactions: true,
      file: true,
      _count: { select: { replies: true } },
    },
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const oldest = pageRows[pageRows.length - 1];

  const messages = pageRows.map((message) => toMessageDto(message, userId));
  const nextCursor =
    hasMore && oldest !== undefined
      ? encodeCursor({
          createdAt: oldest.createdAt.toISOString(),
          id: oldest.id,
        })
      : null;

  logger.debug(
    { dmId, userId, count: messages.length, hasMore },
    'dms.listMessages.success',
  );

  return { messages, nextCursor };
}
