/**
 * Socket.io event handler for the channel room-subscription family.
 *
 * Attaches `channel:join` and `channel:leave` listeners to an authenticated
 * socket. These events govern the socket's LIVE subscription to a channel's
 * Socket.io room (`channel:<id>`) — the room through which `message:new`,
 * `reaction:added`, `typing:start`, and the other channel-scoped broadcasts
 * reach the client.
 *
 * Real-time contract (AAP §0.4.5):
 *   - Listens: `channel:join`  (client → server) — acked `(ok: boolean)`
 *   - Listens: `channel:leave` (client → server) — acked `(ok: boolean)`
 *   - Emits:   `error`         (server → originating socket, on failure)
 *
 * Two distinct concerns are kept separate:
 *
 *   - `channel:join` performs BOTH a persistent and an ephemeral action. It
 *     calls `joinChannel` to create the durable `ChannelMember` row (idempotent
 *     on re-join; rejected with `ForbiddenError` for a private channel the user
 *     was not invited to, `NotFoundError` for an unknown channel), then calls
 *     `socket.join(channelRoom(id))` to subscribe this live connection to the
 *     broadcast room.
 *   - `channel:leave` performs ONLY the ephemeral action — `socket.leave(...)`.
 *     Durable membership is intentionally untouched here; it is revoked through
 *     the HTTP `DELETE /api/channels/:id/members` route. Closing a tab therefore
 *     drops the live subscription without removing the user from the channel.
 *
 * Broadcast rooms are addressed via the `channelRoom` helper from `../rooms.js`;
 * the Socket.io Redis adapter (AAP Rule 2) transparently fans every emit out to
 * subscribers connected to any API instance.
 *
 * Layering: this handler performs NO database, Redis, or JWT work directly. It
 * delegates persistence and access control to `joinChannel` and relies on the
 * server-level socket-auth middleware to populate `socket.data.userId`.
 *
 * Structured logging (AAP §0.8.2 Gate 10) is emitted through the Pino `logger`
 * singleton with `component`, `event`, `socketId`, `userId`, `channelId`, and
 * `latency` fields. Per the Explainability rule (AAP §0.8.3) design rationale
 * lives in /docs/decision-log.md, not in these comments.
 */
import type { Server, Socket } from 'socket.io';
import { ZodError } from 'zod';

import { joinChannel } from '../../services/channels.service.js';
import {
  ForbiddenError,
  NotFoundError,
  ServiceError,
  UnauthorizedError,
  ValidationError,
} from '../../middleware/errors.js';
import { logger } from '../../config/logger.js';
import { channelRoom } from '../rooms.js';
import { joinChannelSchema } from '@app/shared/schemas/channel';
import { CHANNEL_JOIN, CHANNEL_LEAVE, ERROR } from '@app/shared/constants/events';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';

/** Fully-typed Socket.io server bound to the shared event contract. */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Fully-typed Socket.io socket bound to the shared event contract. */
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Acknowledgement callback shape shared by `channel:join` and `channel:leave`.
 * Mirrors the ack arm of both events in `ClientToServerEvents`: `true` signals
 * success, `false` signals failure (the accompanying private `error` event
 * carries the diagnostic `{ code, message }`).
 */
type ChannelAck = (ok: boolean) => void;

/**
 * Registers the channel room-subscription listeners on a connected,
 * authenticated socket.
 *
 * Each listener is synchronous and delegates to its async handler with a `void`
 * prefix so the returned promise is intentionally not awaited (the ack callback
 * is the completion signal, satisfying the `no-floating-promises` rule).
 *
 * @param io - The typed Socket.io server (passed through for handler-signature
 *   symmetry with the broadcasting handlers; not used for join/leave, which act
 *   only on the originating socket).
 * @param socket - The connecting socket whose channel events are handled.
 */
export function registerChannelHandlers(io: AppServer, socket: AppSocket): void {
  socket.on(CHANNEL_JOIN, (channelId, ack) => {
    handleChannelJoin(io, socket, channelId, ack).catch((err: unknown) => {
      logUnhandledRejection(socket, CHANNEL_JOIN, err);
    });
  });

  socket.on(CHANNEL_LEAVE, (channelId, ack) => {
    handleChannelLeave(io, socket, channelId, ack).catch((err: unknown) => {
      logUnhandledRejection(socket, CHANNEL_LEAVE, err);
    });
  });
}

/**
 * Last-resort logger for a rejection that escapes a channel handler's own
 * try/catch.
 *
 * Each handler acknowledges and catches on every path, so a rejection reaching
 * here is not expected; attaching this to the delegated promise guarantees any
 * stray rejection is logged on the originating socket's context instead of
 * escalating to a process-level `unhandledRejection` that would terminate the
 * API and sever every other connected socket.
 *
 * @param socket - The originating socket (for `socketId` / `userId` context).
 * @param event - The inbound event name whose delegate rejected.
 * @param err - The rejection value.
 */
function logUnhandledRejection(socket: AppSocket, event: string, err: unknown): void {
  logger.error(
    {
      component: 'channel.handler',
      event,
      socketId: socket.id,
      userId: socket.data.userId,
      err: err instanceof Error ? err.message : String(err),
    },
    `${event} delegate rejected`,
  );
}

/**
 * Validates, persists membership, subscribes, and acknowledges a single
 * `channel:join`.
 *
 * Flow:
 *   1. Validate the wire value with `joinChannelSchema` (Gate 12). The schema
 *      validates an object `{ channelId }`, so the bare wire string is wrapped
 *      before `.parse(...)`.
 *   2. Persist membership via `joinChannel`, which enforces the private-channel
 *      ACL and is idempotent on re-join.
 *   3. Subscribe this live socket to the channel's broadcast room (ephemeral).
 *   4. Acknowledge the originating socket with `true`.
 *   5. Emit a structured success log line.
 *
 * The ack is invoked exactly once on every path — here on success, or with
 * `false` after {@link handleError} on failure.
 *
 * @param _io - The typed Socket.io server (unused; broadcasts are not emitted
 *   for join, only the originating socket subscribes).
 * @param socket - The originating socket (provides `socket.data.userId`).
 * @param channelId - The unvalidated channel id from the `channel:join` wire event.
 * @param ack - The client acknowledgement callback.
 */
async function handleChannelJoin(
  _io: AppServer,
  socket: AppSocket,
  channelId: string,
  ack: ChannelAck,
): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;
  // A non-conforming client may emit `channel:join` without an acknowledgement
  // callback, in which case `ack` is `undefined`. Normalize to a no-op so
  // neither the success nor the error path below throws "ack is not a function".
  const safeAck: ChannelAck = typeof ack === 'function' ? ack : () => undefined;
  try {
    const validated = joinChannelSchema.parse({ channelId });

    await joinChannel({ channelId: validated.channelId, userId });

    await socket.join(channelRoom(validated.channelId));

    safeAck(true);

    logger.info(
      {
        component: 'channel.handler',
        event: CHANNEL_JOIN,
        socketId: socket.id,
        userId,
        channelId: validated.channelId,
        latency: Date.now() - start,
      },
      'channel join handled',
    );
  } catch (err: unknown) {
    handleError(socket, CHANNEL_JOIN, userId, channelId, start, err);
    safeAck(false);
  }
}

/**
 * Validates, unsubscribes, and acknowledges a single `channel:leave`.
 *
 * Flow:
 *   1. Validate the wire value with `joinChannelSchema` (Gate 12), wrapping the
 *      bare wire string into the `{ channelId }` object the schema expects.
 *   2. Unsubscribe this live socket from the channel's broadcast room. Durable
 *      `ChannelMember` state is NOT modified — persistent leave is performed by
 *      the HTTP `DELETE /api/channels/:id/members` route.
 *   3. Acknowledge the originating socket with `true`.
 *   4. Emit a structured success log line.
 *
 * The ack is invoked exactly once on every path — here on success, or with
 * `false` after {@link handleError} on failure.
 *
 * @param _io - The typed Socket.io server (unused; leave acts only on the
 *   originating socket's subscriptions).
 * @param socket - The originating socket (provides `socket.data.userId`).
 * @param channelId - The unvalidated channel id from the `channel:leave` wire event.
 * @param ack - The client acknowledgement callback.
 */
async function handleChannelLeave(
  _io: AppServer,
  socket: AppSocket,
  channelId: string,
  ack: ChannelAck,
): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;
  // A non-conforming client may emit `channel:leave` without an acknowledgement
  // callback, in which case `ack` is `undefined`. Normalize to a no-op so
  // neither the success nor the error path below throws "ack is not a function".
  const safeAck: ChannelAck = typeof ack === 'function' ? ack : () => undefined;
  try {
    const validated = joinChannelSchema.parse({ channelId });

    await socket.leave(channelRoom(validated.channelId));

    safeAck(true);

    logger.info(
      {
        component: 'channel.handler',
        event: CHANNEL_LEAVE,
        socketId: socket.id,
        userId,
        channelId: validated.channelId,
        latency: Date.now() - start,
      },
      'channel leave handled',
    );
  } catch (err: unknown) {
    handleError(socket, CHANNEL_LEAVE, userId, channelId, start, err);
    safeAck(false);
  }
}

/**
 * Translates a thrown error into client feedback for a failed channel event.
 *
 * Emits a structured `logger.error` line carrying the channel context, then
 * sends a private `error` event to the ORIGINATING socket (never a broadcast)
 * so a global client error handler can surface a toast. The boolean ack is
 * handled by the calling handler; this helper owns the diagnostic `error`
 * event and the error log line.
 *
 * @param socket - The originating socket to notify.
 * @param event - The inbound event name that failed (`channel:join` / `channel:leave`).
 * @param userId - The authenticated user id (for the log line).
 * @param channelId - The target channel id (the raw wire value, used for the log line).
 * @param start - The `Date.now()` captured at handler entry (for latency).
 * @param err - The thrown error (Zod, ServiceError subclass, or unknown).
 */
function handleError(
  socket: AppSocket,
  event: string,
  userId: string,
  channelId: string,
  start: number,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : 'Internal error';
  const code = resolveErrorCode(err);

  logger.error(
    {
      component: 'channel.handler',
      event,
      socketId: socket.id,
      userId,
      channelId,
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
 * name-derived code (e.g., `ConflictError` → `CONFLICT`). `ZodError` (schema
 * validation) maps to `VALIDATION_ERROR`.
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
