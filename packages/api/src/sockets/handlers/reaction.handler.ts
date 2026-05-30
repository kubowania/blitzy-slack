/**
 * Socket.io event handler for the message-reaction family.
 *
 * Attaches `reaction:add` and `reaction:remove` listeners to an authenticated
 * socket. On each event the handler validates the wire payload, toggles the
 * reaction through the messages service (which performs the message lookup and
 * the channel/DM access-control checks), and broadcasts `reaction:added` /
 * `reaction:removed` to the subscribers of the message's room.
 *
 * Real-time contract (AAP §0.4.5):
 *   - Listens: `reaction:add`     (client → server)
 *   - Listens: `reaction:remove`  (client → server)
 *   - Emits:   `reaction:added`   (server → subscribers of the message's room)
 *   - Emits:   `reaction:removed` (server → subscribers of the message's room)
 *   - Emits:   `error`            (server → originating socket, on failure)
 *
 * Broadcasts are addressed to the single logical room that owns the message
 * (`thread:<parentId>`, `channel:<id>`, or `dm:<id>`); the Socket.io Redis
 * adapter (AAP Rule 2) transparently fans each emit out to subscribers
 * connected to any API instance. Reactions on a thread reply broadcast ONLY to
 * the thread room (the parent channel/DM sidebar does not refresh reaction
 * counts for thread messages).
 *
 * Layering: this handler performs NO database, Redis, or JWT work directly. It
 * delegates the mutation and access control to `addReaction` / `removeReaction`
 * and relies on the server-level socket-auth middleware to populate
 * `socket.data.userId`.
 *
 * This is the SECONDARY reaction path; the primary path is the REST route in
 * `routes/messages.ts`. Both paths invoke the same service functions and emit
 * identical broadcast payloads, so a client may use either interchangeably.
 *
 * Structured logging (AAP §0.8.2 Gate 10) is emitted through the Pino `logger`
 * singleton with `component`, `event`, `socketId`, `userId`, `messageId`,
 * `emoji`, `room`, and `latency` fields. Per the Explainability rule
 * (AAP §0.8.3) design rationale lives in /docs/decision-log.md, not in these
 * comments.
 */
import type { Server, Socket } from 'socket.io';
import { ZodError } from 'zod';

import { addReaction, removeReaction } from '../../services/messages.service.js';
import {
  ForbiddenError,
  NotFoundError,
  ServiceError,
  UnauthorizedError,
  ValidationError,
} from '../../middleware/errors.js';
import { logger } from '../../config/logger.js';
import { channelRoom, dmRoom, threadRoom } from '../rooms.js';
import { reactionSchema } from '@app/shared/schemas/message';
import {
  ERROR,
  REACTION_ADD,
  REACTION_ADDED,
  REACTION_REMOVE,
  REACTION_REMOVED,
} from '@app/shared/constants/events';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';
import type { MessageWithAuthor, ReactionSummary } from '@app/shared/types/message';

/** Fully-typed Socket.io server bound to the shared event contract. */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Fully-typed Socket.io socket bound to the shared event contract. */
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Wire payload accepted by both `reaction:add` and `reaction:remove`. Mirrors
 * the payload arm of `ClientToServerEvents['reaction:add' | 'reaction:remove']`;
 * `reactionSchema` re-validates the shape (cuid `messageId`, standard-emoji
 * `emoji`) before the service is invoked.
 */
interface ReactionPayload {
  /** Database id (cuid) of the message being reacted to. */
  messageId: string;
  /** Unicode emoji to toggle. */
  emoji: string;
}

/**
 * Registers the reaction listeners on a connected, authenticated socket.
 *
 * Each listener is synchronous and delegates to its async handler with a
 * `void` prefix so the returned promise is intentionally not awaited — neither
 * `reaction:add` nor `reaction:remove` carries an acknowledgement callback, so
 * the room broadcast is the only completion signal (satisfying the
 * `no-floating-promises` rule).
 *
 * @param io - The typed Socket.io server, used to broadcast to the message's room.
 * @param socket - The connecting socket whose reaction events are handled.
 */
export function registerReactionHandlers(io: AppServer, socket: AppSocket): void {
  socket.on(REACTION_ADD, (payload) => {
    void handleReactionAdd(io, socket, payload);
  });

  socket.on(REACTION_REMOVE, (payload) => {
    void handleReactionRemove(io, socket, payload);
  });
}

/**
 * Resolves the single Socket.io room key that must receive a reaction
 * broadcast for a hydrated message.
 *
 * Routing precedence (a message belongs to exactly one of thread/channel/DM):
 *   - Thread reply (`parentId !== null`): the thread room ONLY.
 *   - Channel message (`channelId !== null`): the channel room.
 *   - DM message (`dmId !== null`): the DM room.
 *
 * Returns `null` for a routing-less (corrupt) message, which the database
 * constraints and the service guarantee should make unreachable.
 *
 * @param message - The hydrated message returned by the service (authoritative
 *   `parentId` / `channelId` / `dmId` values).
 * @returns The room key to broadcast to, or `null` when the message is unroutable.
 */
function resolveMessageRoom(message: MessageWithAuthor): string | null {
  if (message.parentId !== null) {
    return threadRoom(message.parentId);
  }
  if (message.channelId !== null) {
    return channelRoom(message.channelId);
  }
  if (message.dmId !== null) {
    return dmRoom(message.dmId);
  }
  return null;
}

/**
 * Extracts the aggregated {@link ReactionSummary} for a specific emoji from a
 * hydrated message.
 *
 * The service aggregates raw reaction rows into at most one summary per emoji,
 * so the first match is the authoritative summary. Returns `null` when the
 * emoji is absent from the message's reactions (expected after the last
 * instance of that emoji has been removed).
 *
 * @param message - The hydrated message carrying the post-mutation reactions.
 * @param emoji - The emoji whose summary to extract.
 * @returns The matching summary, or `null` when the emoji is not present.
 */
function findReactionSummary(message: MessageWithAuthor, emoji: string): ReactionSummary | null {
  return message.reactions.find((reaction) => reaction.emoji === emoji) ?? null;
}

/**
 * Validates and applies a single `reaction:add`, then broadcasts the updated
 * reaction summary to the message's room.
 *
 * Flow:
 *   1. Validate the wire payload with `reactionSchema` (Gate 12).
 *   2. Upsert the reaction via `addReaction`, which verifies the message exists
 *      and the caller has access to its channel/DM, returning the fully-hydrated
 *      post-mutation message. The upsert is idempotent on the
 *      `(messageId, userId, emoji)` composite, so re-adds are no-ops.
 *   3. Resolve the broadcast room from the AUTHORITATIVE service result.
 *   4. Extract the updated summary for this emoji and emit `reaction:added`.
 *
 * `reaction:add` carries no acknowledgement callback, so failures are reported
 * only through the private `error` event (see {@link handleError}).
 *
 * @param io - The typed Socket.io server used for the room broadcast.
 * @param socket - The originating socket (provides `socket.data.userId`).
 * @param rawPayload - The unvalidated `reaction:add` payload from the client.
 */
async function handleReactionAdd(
  io: AppServer,
  socket: AppSocket,
  rawPayload: ReactionPayload,
): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;
  let messageId = rawPayload?.messageId ?? '';
  let emoji = rawPayload?.emoji ?? '';
  try {
    const validated = reactionSchema.parse(rawPayload);
    messageId = validated.messageId;
    emoji = validated.emoji;

    const message = await addReaction({
      messageId: validated.messageId,
      userId,
      emoji: validated.emoji,
    });

    const room = resolveMessageRoom(message);
    if (room === null) {
      logger.warn(
        {
          component: 'reaction.handler',
          event: REACTION_ADD,
          socketId: socket.id,
          userId,
          messageId: validated.messageId,
          emoji: validated.emoji,
        },
        'reaction add: hydrated message has no broadcast room',
      );
      return;
    }

    const reaction = findReactionSummary(message, validated.emoji);
    if (reaction === null) {
      logger.warn(
        {
          component: 'reaction.handler',
          event: REACTION_ADD,
          socketId: socket.id,
          userId,
          messageId: validated.messageId,
          emoji: validated.emoji,
        },
        'reaction add: emoji absent from hydrated message after upsert',
      );
      return;
    }

    io.to(room).emit(REACTION_ADDED, {
      messageId: validated.messageId,
      reaction,
    });

    logger.info(
      {
        component: 'reaction.handler',
        event: REACTION_ADDED,
        socketId: socket.id,
        userId,
        messageId: validated.messageId,
        emoji: validated.emoji,
        room,
        latency: Date.now() - start,
      },
      'reaction added',
    );
  } catch (err: unknown) {
    handleError(socket, REACTION_ADD, userId, messageId, emoji, start, err);
  }
}

/**
 * Validates and applies a single `reaction:remove`, then broadcasts the removal
 * tuple to the message's room.
 *
 * Flow:
 *   1. Validate the wire payload with `reactionSchema` (Gate 12).
 *   2. Delete the reaction via `removeReaction`, which verifies access and is
 *      idempotent — removing a non-existent reaction is a no-op (the service
 *      swallows Prisma's P2025). It returns the fully-hydrated post-mutation
 *      message used only to resolve the broadcast room.
 *   3. Resolve the broadcast room from the AUTHORITATIVE service result.
 *   4. Emit `reaction:removed` as the `(messageId, emoji, userId)` tuple. Unlike
 *      `reaction:added`, no `ReactionSummary` is sent: once the last reactor for
 *      an emoji unreacts there is no summary, so subscribers decrement their
 *      local count from the tuple instead.
 *
 * `reaction:remove` carries no acknowledgement callback, so failures are
 * reported only through the private `error` event (see {@link handleError}).
 *
 * @param io - The typed Socket.io server used for the room broadcast.
 * @param socket - The originating socket (provides `socket.data.userId`).
 * @param rawPayload - The unvalidated `reaction:remove` payload from the client.
 */
async function handleReactionRemove(
  io: AppServer,
  socket: AppSocket,
  rawPayload: ReactionPayload,
): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;
  let messageId = rawPayload?.messageId ?? '';
  let emoji = rawPayload?.emoji ?? '';
  try {
    const validated = reactionSchema.parse(rawPayload);
    messageId = validated.messageId;
    emoji = validated.emoji;

    const message = await removeReaction({
      messageId: validated.messageId,
      userId,
      emoji: validated.emoji,
    });

    const room = resolveMessageRoom(message);
    if (room === null) {
      logger.warn(
        {
          component: 'reaction.handler',
          event: REACTION_REMOVE,
          socketId: socket.id,
          userId,
          messageId: validated.messageId,
          emoji: validated.emoji,
        },
        'reaction remove: hydrated message has no broadcast room',
      );
      return;
    }

    io.to(room).emit(REACTION_REMOVED, {
      messageId: validated.messageId,
      emoji: validated.emoji,
      userId,
    });

    logger.info(
      {
        component: 'reaction.handler',
        event: REACTION_REMOVED,
        socketId: socket.id,
        userId,
        messageId: validated.messageId,
        emoji: validated.emoji,
        room,
        latency: Date.now() - start,
      },
      'reaction removed',
    );
  } catch (err: unknown) {
    handleError(socket, REACTION_REMOVE, userId, messageId, emoji, start, err);
  }
}

/**
 * Translates a thrown error into client feedback for a failed reaction event.
 *
 * Emits a structured `logger.error` line carrying the reaction context, then
 * sends a private `error` event to the originating socket (so a global client
 * error handler can surface a toast). Neither reaction event has an
 * acknowledgement callback, so the private `error` event is the sole failure
 * channel.
 *
 * @param socket - The originating socket to notify.
 * @param event - The inbound event name that failed (`reaction:add` / `reaction:remove`).
 * @param userId - The authenticated user id (for the log line).
 * @param messageId - The target message id (validated value, or the raw value on early failure).
 * @param emoji - The target emoji (validated value, or the raw value on early failure).
 * @param start - The `Date.now()` captured at handler entry (for latency).
 * @param err - The thrown error (Zod, ServiceError subclass, or unknown).
 */
function handleError(
  socket: AppSocket,
  event: string,
  userId: string,
  messageId: string,
  emoji: string,
  start: number,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : 'Internal error';
  const code = resolveErrorCode(err);

  logger.error(
    {
      component: 'reaction.handler',
      event,
      socketId: socket.id,
      userId,
      messageId,
      emoji,
      code,
      err: message,
      latency: Date.now() - start,
    },
    `${event} failed`,
  );

  socket.emit(ERROR, { code, message });
}

/**
 * Maps a thrown error to a stable Socket.io error code string.
 *
 * Concrete `ServiceError` subclasses are checked before the abstract base so
 * each receives its specific code; any other `ServiceError` falls back to a
 * name-derived code. `ZodError` (schema validation) maps to `VALIDATION_ERROR`.
 *
 * @param err - The thrown error to classify.
 * @returns The error code string surfaced to the client.
 */
function resolveErrorCode(err: unknown): string {
  if (err instanceof ZodError) {
    return 'VALIDATION_ERROR';
  }
  if (err instanceof ValidationError) {
    return 'VALIDATION_ERROR';
  }
  if (err instanceof UnauthorizedError) {
    return 'UNAUTHORIZED';
  }
  if (err instanceof ForbiddenError) {
    return 'FORBIDDEN';
  }
  if (err instanceof NotFoundError) {
    return 'NOT_FOUND';
  }
  if (err instanceof ServiceError) {
    return err.name.replace(/Error$/, '').toUpperCase() || 'SERVICE_ERROR';
  }
  return 'INTERNAL_ERROR';
}
