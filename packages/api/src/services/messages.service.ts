/**
 * Message service — message persistence, thread replies, and emoji reactions.
 *
 * Public surface:
 *   sendMessage(input)                          → MessageWithAuthor
 *   getReplies({ parentId, userId })            → MessageWithAuthor[]   (thread view)
 *   addReaction({ messageId, userId, emoji })   → MessageWithAuthor     (full message, post-mutation reactions)
 *   removeReaction({ messageId, userId, emoji}) → MessageWithAuthor     (full message, post-mutation reactions)
 *
 * Layering and behavioral contract:
 *  - Routes and socket handlers call this service and then emit the Socket.io
 *    events (`message:new`, `reaction:added`, `reaction:removed`) using the
 *    returned DTOs. This service NEVER touches Socket.io itself.
 *  - `sendMessage` enforces the channel/DM XOR invariant that the Prisma schema
 *    cannot express, performs access control, validates thread parentage, and
 *    validates file-attachment ownership.
 *  - Reactions are toggled through the `(messageId, userId, emoji)` composite
 *    unique constraint: `addReaction` is an idempotent upsert and
 *    `removeReaction` is an idempotent delete.
 *  - `getReplies` returns thread replies oldest-first (chronological reading
 *    order) and is intentionally unpaginated.
 *
 * The rationale for the design choices in this file — single-level threads,
 * upsert/P2025 idempotency, the post-mutation re-fetch, file-attachment
 * authorization, the per-endpoint ordering direction, and the unpaginated
 * thread read — is recorded in /docs/decision-log.md, not in code comments
 * (Explainability rule, AAP §0.8.3).
 */

import { prisma, Prisma } from '@app/db';
import type {
  Message as PrismaMessage,
  User as PrismaUser,
  MessageReaction as PrismaMessageReaction,
  File as PrismaFile,
} from '@app/db';

import { logger } from '../config/logger.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../middleware/errors.js';

import { MAX_MESSAGE_LENGTH } from '@app/shared/constants/limits';
import type { MessageWithAuthor } from '@app/shared/types/message';
import type { SendMessageInput, ReactionInput } from '@app/shared/schemas/message';

/**
 * Input contract for {@link sendMessage}. Routes construct this after Zod
 * validation, populating `authorId` from the authenticated principal and the
 * channel/DM target from the URL path parameter.
 *
 * XOR invariant: EXACTLY ONE of `channelId` / `dmId` must be non-null. Both
 * unset or both set throws {@link ValidationError}.
 *
 * When `parentId` is set the message becomes a thread reply; the parent's
 * channel/DM context must match the supplied target (validated in the service).
 *
 * The scalar field types are anchored to the route validator's inferred
 * {@link SendMessageInput} so the service and the `POST /messages` Zod schema
 * stay aligned on a single source of truth.
 */
export interface SendMessageServiceInput {
  /** Database id of the authenticated author (from the JWT principal, not the body). */
  authorId: string;
  /** Plain-text message body. */
  content: SendMessageInput['content'];
  /** Target channel id; mutually exclusive with `dmId`. */
  channelId?: SendMessageInput['channelId'] | null;
  /** Target DM id; mutually exclusive with `channelId`. */
  dmId?: SendMessageInput['dmId'] | null;
  /** Parent message id when this message is a thread reply; otherwise unset. */
  parentId?: SendMessageInput['parentId'] | null;
  /** Attached file id when this message carries an attachment; otherwise unset. */
  fileId?: SendMessageInput['fileId'] | null;
}

/**
 * Input contract for {@link addReaction} and {@link removeReaction}. The wire
 * shape is identical for add and remove; the calling route/handler discriminates
 * the operation. Anchored to the route validator's {@link ReactionInput}.
 */
export interface ReactionServiceInput {
  /** Database id of the message being reacted to. */
  messageId: ReactionInput['messageId'];
  /** Database id of the reacting user (from the JWT principal). */
  userId: string;
  /** Unicode emoji string (validated as a standard emoji at the route layer). */
  emoji: ReactionInput['emoji'];
}

/**
 * Input contract for {@link getReplies}. `parentId` identifies the thread root;
 * `userId` is the authenticated caller, used for the ACL check on the parent's
 * channel/DM context.
 */
export interface GetRepliesInput {
  /** Database id of the parent (thread-root) message. */
  parentId: string;
  /** Database id of the authenticated caller. */
  userId: string;
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
 * Verify the caller may post to / read from the given channel.
 *  - Public channel: always allowed (Slack semantics — public channels are
 *    discoverable and postable by any authenticated user).
 *  - Private channel: the caller must be a `ChannelMember`.
 *
 * @throws {NotFoundError} when the channel does not exist.
 * @throws {ForbiddenError} when the channel is private and the caller is not a
 *   member.
 */
async function assertChannelAccess(channelId: string, userId: string): Promise<void> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: { id: true, isPrivate: true },
  });
  if (channel === null) {
    throw new NotFoundError('Channel not found');
  }
  if (channel.isPrivate) {
    const member = await prisma.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { id: true },
    });
    if (member === null) {
      throw new ForbiddenError('You do not have access to this channel');
    }
  }
}

/**
 * Verify the caller is a participant of the given direct-message conversation.
 *
 * @throws {NotFoundError} when the DM does not exist.
 * @throws {ForbiddenError} when the caller is not a participant.
 */
async function assertDmAccess(dmId: string, userId: string): Promise<void> {
  const dm = await prisma.directMessage.findUnique({
    where: { id: dmId },
    select: { id: true },
  });
  if (dm === null) {
    throw new NotFoundError('Direct message not found');
  }
  const participant = await prisma.dMParticipant.findUnique({
    where: { dmId_userId: { dmId, userId } },
    select: { dmId: true },
  });
  if (participant === null) {
    throw new ForbiddenError('You do not have access to this DM');
  }
}

/**
 * Send a new message to either a channel or a DM (XOR), optionally as a thread
 * reply (`parentId`), optionally carrying a single file attachment (`fileId`).
 *
 * Validation performed (defense-in-depth behind the route's Zod schema):
 *  - EXACTLY ONE of `channelId` / `dmId` is set.
 *  - `content` length is within MAX_MESSAGE_LENGTH.
 *  - A message must carry either non-empty content or a file attachment.
 *  - When `parentId` is set: the parent must exist, must not itself be a reply
 *    (threads are single-level), and must share the supplied channel/DM context.
 *  - When `fileId` is set: the file must exist and must have been uploaded by
 *    this same author (you can only attach your own uploads). Reusing a file id
 *    already bound to another message surfaces Prisma's P2002 (Message.fileId is
 *    unique), which propagates to the error handler.
 *
 * Access control:
 *  - Channel target: caller must be a member when the channel is private.
 *  - DM target: caller must be a participant.
 *
 * @param input - author id, content, the channel/DM target, and the optional
 *   thread parent and file attachment.
 * @returns the persisted message hydrated as a `MessageWithAuthor` DTO.
 * @throws {ValidationError} on XOR violation, empty-and-fileless content,
 *   oversized content, a nested-reply parent, or a parent/target context mismatch.
 * @throws {NotFoundError} when the target channel/DM, the parent message, or the
 *   referenced file does not exist.
 * @throws {ForbiddenError} when the caller lacks access to the target or attempts
 *   to attach a file uploaded by someone else.
 */
export async function sendMessage(
  input: SendMessageServiceInput,
): Promise<MessageWithAuthor> {
  const { authorId, content, channelId, dmId, parentId, fileId } = input;

  // XOR: `hasChannel === hasDm` is true both when neither is set and when both
  // are set; either case violates the channel/DM exclusivity invariant.
  const hasChannel = channelId !== undefined && channelId !== null;
  const hasDm = dmId !== undefined && dmId !== null;
  if (hasChannel === hasDm) {
    throw new ValidationError('Exactly one of channelId or dmId must be set');
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(
      `Message content exceeds ${MAX_MESSAGE_LENGTH} characters`,
    );
  }
  const hasFile = fileId !== undefined && fileId !== null;
  if (content.length === 0 && !hasFile) {
    throw new ValidationError('Message must have content or a file attachment');
  }

  // Access control on the target. Re-narrowing the scalar values here (rather
  // than reusing the `hasChannel`/`hasDm` booleans) lets the compiler refine
  // `channelId` / `dmId` to `string` without an assertion.
  if (channelId !== undefined && channelId !== null) {
    await assertChannelAccess(channelId, authorId);
  } else if (dmId !== undefined && dmId !== null) {
    await assertDmAccess(dmId, authorId);
  }

  // Thread validation: the parent must exist, be a top-level message, and live
  // in the same channel/DM as this reply.
  if (parentId !== undefined && parentId !== null) {
    const parent = await prisma.message.findUnique({
      where: { id: parentId },
      select: { id: true, channelId: true, dmId: true, parentId: true },
    });
    if (parent === null) {
      throw new NotFoundError('Parent message not found');
    }
    if (parent.parentId !== null) {
      throw new ValidationError('Cannot reply to a reply; threads are single-level');
    }
    if (parent.channelId !== (channelId ?? null)) {
      throw new ValidationError('Parent message belongs to a different channel');
    }
    if (parent.dmId !== (dmId ?? null)) {
      throw new ValidationError('Parent message belongs to a different DM');
    }
  }

  // File-attachment validation: the file must exist and belong to this author.
  if (fileId !== undefined && fileId !== null) {
    const file = await prisma.file.findUnique({
      where: { id: fileId },
      select: { id: true, uploadedById: true },
    });
    if (file === null) {
      throw new NotFoundError('File not found');
    }
    if (file.uploadedById !== authorId) {
      throw new ForbiddenError('You can only attach files you uploaded');
    }
  }

  // Persist with the author, reactions, file, and reply count included so the
  // full DTO is returned without a follow-up query.
  const created = await prisma.message.create({
    data: {
      content,
      authorId,
      channelId: channelId ?? null,
      dmId: dmId ?? null,
      parentId: parentId ?? null,
      fileId: fileId ?? null,
    },
    include: {
      author: true,
      reactions: true,
      file: true,
      _count: { select: { replies: true } },
    },
  });

  logger.info(
    {
      messageId: created.id,
      authorId,
      channelId: created.channelId,
      dmId: created.dmId,
      parentId: created.parentId,
      hasFile: created.fileId !== null,
    },
    'messages.send.success',
  );

  return toMessageDto(created, authorId);
}

/**
 * List all replies to a parent message, oldest-first (chronological reading
 * order for the thread panel). Intentionally unpaginated — threads are short
 * and the UI loads the whole thread when the panel opens.
 *
 * Access control mirrors the parent's channel/DM access: a caller who can see
 * the parent can read its thread.
 *
 * @param input - the parent message id and the authenticated caller id.
 * @returns the reply messages as `MessageWithAuthor` DTOs, oldest-first; an
 *   empty array when the parent has no replies.
 * @throws {NotFoundError} when the parent message does not exist.
 * @throws {ForbiddenError} when the caller lacks access to the parent's channel/DM.
 * @throws {ValidationError} when the parent message has neither a channel nor a
 *   DM context (a defensive guard against a corrupted row).
 */
export async function getReplies(
  input: GetRepliesInput,
): Promise<MessageWithAuthor[]> {
  const { parentId, userId } = input;

  const parent = await prisma.message.findUnique({
    where: { id: parentId },
    select: { id: true, channelId: true, dmId: true },
  });
  if (parent === null) {
    throw new NotFoundError('Parent message not found');
  }

  // Access control on the parent's containing channel/DM.
  if (parent.channelId !== null) {
    await assertChannelAccess(parent.channelId, userId);
  } else if (parent.dmId !== null) {
    await assertDmAccess(parent.dmId, userId);
  } else {
    throw new ValidationError('Parent message has no channel or DM context');
  }

  const replies = await prisma.message.findMany({
    where: { parentId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      author: true,
      reactions: true,
      file: true,
      _count: { select: { replies: true } },
    },
  });

  logger.debug(
    { parentId, userId, count: replies.length },
    'messages.getReplies.success',
  );

  return replies.map((reply) => toMessageDto(reply, userId));
}

/**
 * Add a reaction to a message. Idempotent: adding the same emoji twice for the
 * same user is a no-op, achieved by upserting against the
 * `(messageId, userId, emoji)` composite unique constraint.
 *
 * Access control: the caller must have access to the message's channel/DM.
 *
 * @param input - the message id, the reacting user id, and the emoji.
 * @returns the message hydrated as a `MessageWithAuthor` DTO with the
 *   post-mutation reaction list.
 * @throws {NotFoundError} when the message does not exist.
 * @throws {ForbiddenError} when the caller lacks access to the message's channel/DM.
 * @throws {ValidationError} when the message has neither a channel nor a DM
 *   context (a defensive guard against a corrupted row).
 */
export async function addReaction(
  input: ReactionServiceInput,
): Promise<MessageWithAuthor> {
  const { messageId, userId, emoji } = input;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, channelId: true, dmId: true },
  });
  if (message === null) {
    throw new NotFoundError('Message not found');
  }

  if (message.channelId !== null) {
    await assertChannelAccess(message.channelId, userId);
  } else if (message.dmId !== null) {
    await assertDmAccess(message.dmId, userId);
  } else {
    throw new ValidationError('Message has no channel or DM context');
  }

  // Idempotent upsert keyed by the composite unique. The empty `update` makes
  // the operation an "ensure exists" — a duplicate add changes nothing.
  await prisma.messageReaction.upsert({
    where: { messageId_userId_emoji: { messageId, userId, emoji } },
    create: { messageId, userId, emoji },
    update: {},
  });

  // Re-fetch the full message so the response reflects the post-mutation state.
  const updated = await prisma.message.findUniqueOrThrow({
    where: { id: messageId },
    include: {
      author: true,
      reactions: true,
      file: true,
      _count: { select: { replies: true } },
    },
  });

  logger.info({ messageId, userId, emoji }, 'messages.addReaction.success');

  return toMessageDto(updated, userId);
}

/**
 * Remove a reaction from a message. Idempotent: removing a reaction that does
 * not exist is a no-op — Prisma's P2025 ("record to delete does not exist") is
 * swallowed so the client can call remove blindly without first checking state.
 *
 * Access control: the caller must have access to the message's channel/DM.
 *
 * @param input - the message id, the reacting user id, and the emoji.
 * @returns the message hydrated as a `MessageWithAuthor` DTO with the
 *   post-mutation reaction list.
 * @throws {NotFoundError} when the message does not exist.
 * @throws {ForbiddenError} when the caller lacks access to the message's channel/DM.
 * @throws {ValidationError} when the message has neither a channel nor a DM
 *   context (a defensive guard against a corrupted row).
 */
export async function removeReaction(
  input: ReactionServiceInput,
): Promise<MessageWithAuthor> {
  const { messageId, userId, emoji } = input;

  const message = await prisma.message.findUnique({
    where: { id: messageId },
    select: { id: true, channelId: true, dmId: true },
  });
  if (message === null) {
    throw new NotFoundError('Message not found');
  }

  if (message.channelId !== null) {
    await assertChannelAccess(message.channelId, userId);
  } else if (message.dmId !== null) {
    await assertDmAccess(message.dmId, userId);
  } else {
    throw new ValidationError('Message has no channel or DM context');
  }

  // Idempotent delete: a missing reaction (Prisma P2025) is treated as success;
  // any other Prisma/runtime error propagates to the error handler.
  try {
    await prisma.messageReaction.delete({
      where: { messageId_userId_emoji: { messageId, userId, emoji } },
    });
  } catch (err) {
    if (
      !(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025')
    ) {
      throw err;
    }
  }

  const updated = await prisma.message.findUniqueOrThrow({
    where: { id: messageId },
    include: {
      author: true,
      reactions: true,
      file: true,
      _count: { select: { replies: true } },
    },
  });

  logger.info({ messageId, userId, emoji }, 'messages.removeReaction.success');

  return toMessageDto(updated, userId);
}

