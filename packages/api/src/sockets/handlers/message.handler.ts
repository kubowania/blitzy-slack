/**
 * Socket.io event handler for the message-send family.
 *
 * Attaches a `message:send` listener to an authenticated socket. On each event
 * the handler validates the wire payload, persists the message through the
 * messages service (which performs all ACL, thread, and file-ownership checks),
 * broadcasts the fully-hydrated `message:new` to the destination room(s), and
 * acknowledges the originating socket.
 *
 * Real-time contract (AAP §0.4.5):
 *   - Listens: `message:send`  (client → server)
 *   - Emits:   `message:new`   (server → subscribers of the target room[s])
 *   - Emits:   `error`         (server → originating socket, on failure)
 *
 * Broadcasts are addressed to logical rooms (`channel:<id>`, `dm:<id>`,
 * `thread:<parentId>`); the Socket.io Redis adapter (AAP Rule 2) transparently
 * fans each emit out to subscribers connected to any API instance.
 *
 * Layering: this handler performs NO database, Redis, or JWT work directly. It
 * delegates persistence and access control to `createMessage` and relies on the
 * server-level `socketAuth` middleware to populate `socket.data.userId`.
 *
 * Structured logging (AAP §0.8.2 Gate 10) is emitted through the Pino `logger`
 * singleton with `component`, `event`, `socketId`, `userId`, and `latency`
 * fields. Per the Explainability rule (AAP §0.8.3) design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import type { Server, Socket } from 'socket.io';
import { ZodError } from 'zod';

import { createMessage } from '../../services/messages.service.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceError,
  UnauthorizedError,
  ValidationError,
} from '../../middleware/errors.js';
import { logger } from '../../config/logger.js';
import { channelRoom, dmRoom, threadRoom } from '../rooms.js';
import { sendMessageSchema } from '@app/shared/schemas/message';
import { ERROR, MESSAGE_NEW, MESSAGE_SEND } from '@app/shared/constants/events';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';
import type { MessageWithAuthor } from '@app/shared/types/message';

/** Fully-typed Socket.io server bound to the shared event contract. */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Fully-typed Socket.io socket bound to the shared event contract. */
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Wire payload accepted by `message:send`. Mirrors the payload arm of
 * `ClientToServerEvents['message:send']`; the schema enforces that exactly one
 * of `channelId` / `dmId` is present.
 */
interface MessageSendPayload {
  /** Plain-text message body (1..MAX_MESSAGE_LENGTH after trim). */
  content: string;
  /** Target channel id; mutually exclusive with `dmId`. */
  channelId?: string;
  /** Target DM id; mutually exclusive with `channelId`. */
  dmId?: string;
  /** Parent message id when this message is a thread reply. */
  parentId?: string;
  /** Attached file id when this message carries an attachment. */
  fileId?: string;
}

/**
 * Acknowledgement callback shape for `message:send`. Resolves with the hydrated
 * message on success or a string-keyed error envelope on failure. Matches the
 * ack arm of `ClientToServerEvents['message:send']`.
 */
type MessageSendAck = (response: MessageWithAuthor | { error: string }) => void;

/**
 * Registers the `message:send` listener on a connected, authenticated socket.
 *
 * The listener is synchronous and delegates to the async {@link handleMessageSend}
 * with a `void` prefix so the returned promise is intentionally not awaited
 * (the ack callback is the completion signal, satisfying `no-floating-promises`).
 *
 * @param io - The typed Socket.io server, used to broadcast to rooms.
 * @param socket - The connecting socket whose `message:send` events are handled.
 */
export function registerMessageHandlers(io: AppServer, socket: AppSocket): void {
  socket.on(MESSAGE_SEND, (payload, ack) => {
    void handleMessageSend(io, socket, payload, ack);
  });
}

/**
 * Resolves the set of Socket.io room keys that must receive the `message:new`
 * broadcast for a hydrated message.
 *
 * Routing rules (channelId/dmId are mutually exclusive — enforced by the schema
 * and by the service):
 *
 *   - Thread reply (`parentId !== null`): broadcast to BOTH the thread room
 *     (feeds an open thread panel) AND the parent's channel or DM room (feeds
 *     sidebar reply-count badges and the parent's "X replies" indicator).
 *   - Channel message (`channelId !== null`): the channel room only.
 *   - DM message (`dmId !== null`): the DM room only.
 *
 * Returns an empty array only for a routing-less (corrupt) message, which the
 * schema and service guarantees should make unreachable.
 *
 * @param message - The hydrated message returned by the service (authoritative
 *   `channelId` / `dmId` / `parentId` values).
 * @returns The room keys to broadcast to (1 or 2 entries; `[]` if unroutable).
 */
function resolveBroadcastRooms(message: MessageWithAuthor): string[] {
  const rooms: string[] = [];

  if (message.parentId !== null) {
    rooms.push(threadRoom(message.parentId));
    if (message.channelId !== null) {
      rooms.push(channelRoom(message.channelId));
    } else if (message.dmId !== null) {
      rooms.push(dmRoom(message.dmId));
    }
    return rooms;
  }

  if (message.channelId !== null) {
    rooms.push(channelRoom(message.channelId));
    return rooms;
  }

  if (message.dmId !== null) {
    rooms.push(dmRoom(message.dmId));
    return rooms;
  }

  return rooms;
}

/**
 * Validates, persists, broadcasts, and acknowledges a single `message:send`.
 *
 * Flow:
 *   1. Validate the wire payload with `sendMessageSchema` (Gate 12).
 *   2. Persist via `createMessage`, which enforces the channel/DM XOR invariant,
 *      channel-membership / DM-participation ACL, thread parentage, and
 *      file-attachment ownership, returning a fully-hydrated MessageWithAuthor.
 *   3. Resolve the broadcast room(s) from the AUTHORITATIVE service result.
 *   4. Emit `message:new` (identical payload) to every resolved room.
 *   5. Acknowledge the originating socket with the hydrated message.
 *
 * The ack is invoked exactly once on every path — here on success, or via
 * {@link handleError} on failure.
 *
 * @param io - The typed Socket.io server used for room broadcasts.
 * @param socket - The originating socket (provides `socket.data.userId`).
 * @param rawPayload - The unvalidated `message:send` payload from the client.
 * @param ack - The client acknowledgement callback.
 */
async function handleMessageSend(
  io: AppServer,
  socket: AppSocket,
  rawPayload: MessageSendPayload,
  ack: MessageSendAck,
): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;
  try {
    const validated = sendMessageSchema.parse(rawPayload);

    const message = await createMessage({
      authorId: userId,
      content: validated.content,
      channelId: validated.channelId,
      dmId: validated.dmId,
      parentId: validated.parentId,
      fileId: validated.fileId,
    });

    const rooms = resolveBroadcastRooms(message);
    if (rooms.length === 0) {
      logger.warn(
        {
          component: 'message.handler',
          event: MESSAGE_SEND,
          socketId: socket.id,
          userId,
          messageId: message.id,
        },
        'message send: hydrated message has no routing fields',
      );
    } else {
      for (const room of rooms) {
        io.to(room).emit(MESSAGE_NEW, message);
      }
    }

    ack(message);

    logger.info(
      {
        component: 'message.handler',
        event: MESSAGE_NEW,
        socketId: socket.id,
        userId,
        messageId: message.id,
        channelId: message.channelId,
        dmId: message.dmId,
        parentId: message.parentId,
        rooms,
        latency: Date.now() - start,
      },
      'message sent',
    );
  } catch (err: unknown) {
    handleError(socket, userId, ack, start, err);
  }
}

/**
 * Translates a thrown error into client feedback for a failed `message:send`.
 *
 * Emits a structured `logger.error` line, sends a private `error` event to the
 * originating socket (so a global client error handler can surface a toast),
 * and acknowledges the in-flight send with an `{ error }` envelope so the
 * client's optimistic message can be rolled back.
 *
 * @param socket - The originating socket to notify.
 * @param userId - The authenticated user id (for the log line).
 * @param ack - The client acknowledgement callback.
 * @param start - The `Date.now()` captured at handler entry (for latency).
 * @param err - The thrown error (Zod, ServiceError subclass, or unknown).
 */
function handleError(
  socket: AppSocket,
  userId: string,
  ack: MessageSendAck,
  start: number,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : 'Internal error';
  const code = resolveErrorCode(err);

  logger.error(
    {
      component: 'message.handler',
      event: MESSAGE_SEND,
      socketId: socket.id,
      userId,
      code,
      err: message,
      latency: Date.now() - start,
    },
    'message send failed',
  );

  socket.emit(ERROR, { code, message });

  ack({ error: message });
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
  if (err instanceof ConflictError) {
    return 'CONFLICT';
  }
  if (err instanceof ServiceError) {
    return err.name.replace(/Error$/, '').toUpperCase() || 'SERVICE_ERROR';
  }
  return 'INTERNAL_ERROR';
}
