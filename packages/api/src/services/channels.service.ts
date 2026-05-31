/**
 * Channel service — channel CRUD and cursor-paginated channel message listing.
 *
 * Public surface:
 *   listChannels(userId)                                          → ChannelSummary[]
 *   createChannel({ name, description?, isPrivate, createdById }) → Channel
 *   joinChannel({ channelId, userId })                            → Channel
 *   leaveChannel({ channelId, userId })                           → void
 *   listChannelMessages({ channelId, userId, cursor?, limit? })  → { messages, nextCursor }
 *
 * Layering and behavioral contract:
 *  - This service is the only layer permitted to touch Prisma for channel data.
 *    Routes and socket handlers call it and then emit any Socket.io events
 *    (`channel:join`, `channel:leave`, `message:new`) using the returned DTOs;
 *    this service NEVER touches Socket.io itself and NEVER writes HTTP responses.
 *  - `listChannels` returns every public channel plus the private channels the
 *    caller belongs to, ordered by name; private channels are invisible to
 *    non-members.
 *  - `createChannel` inserts the channel and the creator's membership row in a
 *    single transaction so the creator is always an `owner` of the channel they
 *    create.
 *  - `joinChannel` adds the caller as a `member` of a PUBLIC channel; private
 *    channels are not self-joinable (the PoC has no invite flow). Re-joining a
 *    channel the caller already belongs to is idempotent and returns the
 *    existing channel.
 *  - `leaveChannel` removes the caller's membership and is idempotent from the
 *    client's perspective — leaving a channel the caller is not in is a 404.
 *  - `listChannelMessages` enforces channel access control, then paginates the
 *    channel timeline with an opaque (createdAt, id) cursor, returning only
 *    top-level messages (thread replies are read through the messages service).
 */

import { prisma, Prisma } from '@app/db';
import type {
  Channel as PrismaChannel,
  Message as PrismaMessage,
  User as PrismaUser,
  MessageReaction as PrismaMessageReaction,
  File as PrismaFile,
} from '@app/db';

import { logger } from '../config/logger.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../middleware/errors.js';

import { PAGE_SIZE, MAX_PAGE_SIZE } from '@app/shared/constants/limits';
import type { Channel, ChannelSummary } from '@app/shared/types/channel';
import type { MessageWithAuthor, ReactionSummary } from '@app/shared/types/message';
import type { CreateChannelInput, JoinChannelInput } from '@app/shared/schemas/channel';

/**
 * Input contract for {@link createChannel}. Routes construct this after Zod
 * validation, spreading the validated {@link CreateChannelInput} body and
 * populating `createdById` from the authenticated principal (never from the
 * request body) so the creator identity cannot be spoofed.
 */
export interface CreateChannelInputWithCreator extends CreateChannelInput {
  /** Database id of the authenticated user creating the channel. */
  createdById: string;
}

/**
 * Input contract for {@link joinChannel} and {@link leaveChannel}. The wire
 * shape is identical for join and leave; the calling route/handler discriminates
 * the operation. `channelId` is anchored to the route validator's
 * {@link JoinChannelInput} so the service signature and the
 * `POST /api/channels/:id/join` Zod schema stay aligned on a single source of
 * truth.
 */
export interface JoinLeaveInput {
  /** Database id of the channel to join or leave. */
  channelId: JoinChannelInput['channelId'];
  /** Database id of the authenticated user (must be a member to leave). */
  userId: string;
}

/**
 * Input contract for {@link listChannelMessages}. `cursor` is the opaque token returned
 * as `nextCursor` by a previous page; `limit` defaults to {@link PAGE_SIZE} and
 * is capped server-side at {@link MAX_PAGE_SIZE}.
 */
export interface ListMessagesInput {
  /** Id of the channel whose timeline is being read. */
  channelId: string;
  /** Id of the requesting user (drives the private-channel ACL check). */
  userId: string;
  /** Opaque pagination cursor from a previous page; omit for the first page. */
  cursor?: string;
  /** Page size; defaults to PAGE_SIZE, capped at MAX_PAGE_SIZE. */
  limit?: number;
}

/**
 * Result of {@link listChannelMessages}: the page of messages (newest-first) and the
 * cursor to fetch the next, older page.
 */
export interface ListMessagesResult {
  /** The page of top-level messages, ordered newest-first. */
  messages: MessageWithAuthor[];
  /** Opaque cursor for the next (older) page, or `null` when none remain. */
  nextCursor: string | null;
}

/**
 * Internal decoded cursor payload. The wire form is a base64url-encoded JSON
 * string of this shape; it identifies the boundary (oldest already-returned)
 * message so the next page can fetch everything strictly older.
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
 * Map a Prisma `Channel` record onto the canonical `Channel` DTO sent over the
 * wire. The `createdAt` date is serialized to an ISO 8601 string.
 */
function toChannelDto(record: PrismaChannel): Channel {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    isPrivate: record.isPrivate,
    createdById: record.createdById,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * Project a Prisma `Channel` record onto the compact `ChannelSummary` rendered
 * in the sidebar channel list. Unread tracking is out of scope for the PoC, so
 * the optional `unreadCount` field is omitted.
 */
function toChannelSummary(record: PrismaChannel): ChannelSummary {
  return {
    id: record.id,
    name: record.name,
    isPrivate: record.isPrivate,
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
): ReactionSummary[] {
  const grouped = new Map<string, ReactionSummary>();

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
 * List the channels visible to a user: every public channel plus the private
 * channels the user is a member of. Private channels the user does not belong
 * to are omitted entirely, so the listing itself is the first ACL boundary.
 *
 * Results are ordered by `name` ascending (the Slack sidebar convention) and
 * capped at `MAX_PAGE_SIZE` rows so the method can never return an unbounded
 * list at PoC scale.
 *
 * @param userId - the requesting user's id.
 * @returns the visible channels as `ChannelSummary` DTOs, name-ascending.
 */
export async function listChannels(userId: string): Promise<ChannelSummary[]> {
  const records = await prisma.channel.findMany({
    where: {
      OR: [{ isPrivate: false }, { isPrivate: true, members: { some: { userId } } }],
    },
    orderBy: { name: 'asc' },
    take: MAX_PAGE_SIZE,
  });

  logger.debug({ userId, count: records.length }, 'channels.list.success');

  return records.map(toChannelSummary);
}

/**
 * List the ids of every channel the user is an actual MEMBER of (a
 * `ChannelMember` row exists), regardless of the channel's privacy.
 *
 * This differs from {@link listChannels}, which also returns public channels
 * the user has NOT joined: room subscription and presence fan-out must target
 * only the rooms whose membership the caller can post to / read from (matching
 * the `assertChannelAccess` membership rule), so this lean query reads the
 * membership join table directly and returns just the channel ids.
 *
 * @param userId - the user whose channel memberships to resolve.
 * @returns the channel ids the user belongs to (unbounded by privacy, capped
 *          at `MAX_PAGE_SIZE` so the result can never grow without limit).
 */
export async function listMemberChannelIds(userId: string): Promise<string[]> {
  const memberships = await prisma.channelMember.findMany({
    where: { userId },
    select: { channelId: true },
    take: MAX_PAGE_SIZE,
  });
  return memberships.map((membership) => membership.channelId);
}

/**
 * Create a channel and make the creator its `owner` in a single transaction so
 * the two writes commit together: the `Channel` row and the creator's
 * `ChannelMember` row with `role: 'owner'` (overriding the schema's `'member'`
 * default).
 *
 * The unique constraint on `Channel.name` is intentionally NOT caught here: a
 * duplicate-name insert raises Prisma's `P2002`, which propagates to the error
 * handler and maps to HTTP 409 (preserving a single mapping point for unique
 * violations across the service layer).
 *
 * @param input - the validated channel fields plus the authenticated creator id.
 * @returns the created channel as a `Channel` DTO.
 */
export async function createChannel(input: CreateChannelInputWithCreator): Promise<Channel> {
  const { name, description, isPrivate, createdById } = input;

  const created = await prisma.$transaction(async (tx) => {
    const channel = await tx.channel.create({
      data: {
        name,
        description: description ?? null,
        isPrivate,
        createdById,
      },
    });
    await tx.channelMember.create({
      data: {
        channelId: channel.id,
        userId: createdById,
        role: 'owner',
      },
    });
    return channel;
  });

  logger.info(
    { channelId: created.id, createdById, isPrivate: created.isPrivate },
    'channels.create.success',
  );

  return toChannelDto(created);
}

/**
 * Add the caller as a `member` of a PUBLIC channel.
 *
 * Private channels are not self-joinable in the PoC (there is no invite flow);
 * an attempt raises `ForbiddenError`. The join is idempotent: a duplicate
 * membership (the caller is already a member) raises Prisma's `P2002` on the
 * `(channelId, userId)` unique constraint, which is caught here and resolved to
 * the already-joined channel DTO instead of surfacing as a 409.
 *
 * @param input - the target channel id and the authenticated caller id.
 * @returns the joined channel as a `Channel` DTO.
 * @throws {NotFoundError} when the channel does not exist.
 * @throws {ForbiddenError} when the channel is private.
 */
export async function joinChannel(input: JoinLeaveInput): Promise<Channel> {
  const { channelId, userId } = input;

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
  });
  if (channel === null) {
    throw new NotFoundError('Channel not found');
  }
  if (channel.isPrivate) {
    throw new ForbiddenError('Private channels cannot be joined directly');
  }

  try {
    await prisma.channelMember.create({
      data: {
        channelId,
        userId,
        role: 'member',
      },
    });
    logger.info({ channelId, userId }, 'channels.join.success');
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      logger.debug({ channelId, userId }, 'channels.join.idempotent');
      return toChannelDto(channel);
    }
    throw err;
  }

  return toChannelDto(channel);
}

/**
 * Remove the caller's membership from a channel.
 *
 * Idempotent from the client's perspective: deleting a membership that does not
 * exist raises Prisma's `P2025` ("record to delete does not exist"), which is
 * translated to `NotFoundError` so "leave a channel you are not in" surfaces as
 * a 404. The last member leaving is permitted; orphaned-channel cleanup is out
 * of scope for the PoC.
 *
 * @param input - the target channel id and the authenticated caller id.
 * @throws {NotFoundError} when the caller is not a member of the channel.
 */
export async function leaveChannel(input: JoinLeaveInput): Promise<void> {
  const { channelId, userId } = input;

  try {
    await prisma.channelMember.delete({
      where: {
        channelId_userId: { channelId, userId },
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      throw new NotFoundError('Membership not found');
    }
    throw err;
  }

  logger.info({ channelId, userId }, 'channels.leave.success');
}

/**
 * List a channel's top-level messages, paginated by an opaque cursor.
 *
 * Access control: a public channel is readable by any authenticated user
 * (Slack semantics — public channels are discoverable), while a private channel
 * requires the caller to be a member. The channel must exist either way.
 *
 * Pagination: the cursor encodes the (createdAt, id) of the oldest message the
 * caller has already loaded; the query fetches the rows strictly older than
 * that boundary, ordered `createdAt DESC, id DESC`, taking `limit + 1` rows so
 * the extra "peek" row reveals whether a further page exists without a separate
 * COUNT. Only top-level messages are returned (`parentId: null`); thread replies
 * are read through the messages service.
 *
 * @param input - the channel id, caller id, optional cursor, and optional limit.
 * @returns the page of messages (newest-first) and the `nextCursor` (or `null`).
 * @throws {NotFoundError} when the channel does not exist.
 * @throws {ForbiddenError} when the channel is private and the caller is not a member.
 * @throws {ValidationError} when a supplied cursor is malformed.
 */
export async function listChannelMessages(
  input: ListMessagesInput,
): Promise<ListMessagesResult> {
  const { channelId, userId, cursor } = input;
  const limit = resolveLimit(input.limit);

  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, isPrivate: true },
  });
  if (channel === null) {
    throw new NotFoundError('Channel not found');
  }

  if (channel.isPrivate) {
    const membership = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { id: true },
    });
    if (membership === null) {
      throw new ForbiddenError('You do not have access to this channel');
    }
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
      channelId,
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

  const messages = pageRows.map((row) => toMessageDto(row, userId));
  const nextCursor =
    hasMore && oldest !== undefined
      ? encodeCursor({ createdAt: oldest.createdAt.toISOString(), id: oldest.id })
      : null;

  logger.debug(
    { channelId, userId, count: messages.length, hasMore },
    'channels.listChannelMessages.success',
  );

  return { messages, nextCursor };
}
