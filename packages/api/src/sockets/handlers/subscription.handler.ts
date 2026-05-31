/**
 * Socket.io event handler for the on-demand room-subscription family.
 *
 * Attaches `dm:join` / `dm:leave` and `thread:join` / `thread:leave` listeners
 * to an authenticated socket. These events govern the socket's LIVE
 * subscription to a DM room (`dm:<id>`) or a thread room (`thread:<parentId>`)
 * — the rooms through which `message:new`, `reaction:added`/`reaction:removed`,
 * and `typing:*` broadcasts reach the client.
 *
 * Real-time contract (AAP §0.4.5):
 *   - Listens: `dm:join` / `dm:leave`         (client → server, fire-and-forget)
 *   - Listens: `thread:join` / `thread:leave` (client → server, fire-and-forget)
 *   - Emits:   `error`                         (server → originating socket, on failure)
 *
 * Why this handler exists, distinct from the connect-time auto-join in
 * `sockets/index.ts`:
 *   - DM rooms are auto-joined for the DMs that existed when the socket
 *     connected. A DM started MID-SESSION is not covered, so the open DM view
 *     emits `dm:join` to subscribe the live socket immediately (without a
 *     reconnect). `dm:leave` drops the live subscription only — DM
 *     participation is fixed at creation and never revoked.
 *   - Thread rooms are NEVER auto-joined: they are scoped to an OPEN thread
 *     panel. The panel emits `thread:join` on open and `thread:leave` on close,
 *     so reaction events on thread replies (which target ONLY the thread room)
 *     reach the open panel.
 *
 * Access control: `*:join` authorizes the caller through the SAME service-layer
 * ACL the HTTP routes enforce — `assertDmAccess` for a DM, `assertThreadAccess`
 * (which resolves the parent's channel/DM) for a thread — so a realtime
 * subscription can never grant access the REST path would deny. `*:leave`
 * performs no ACL: leaving a room the socket is not in is a harmless no-op.
 *
 * Layering: this handler performs NO database, Redis, or JWT work directly. It
 * delegates access control to the messages service and relies on the
 * server-level socket-auth middleware to populate `socket.data.userId`.
 * Structured logging (Gate 10) flows through the Pino `logger` with
 * `component`, `event`, `socketId`, `userId`, target id, and `latency` fields.
 * Per the Explainability rule (AAP §0.8.3) design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import type { Socket } from 'socket.io';
import { ZodError, z } from 'zod';

import { assertDmAccess, assertThreadAccess } from '../../services/messages.service.js';
import {
  ForbiddenError,
  NotFoundError,
  ServiceError,
  UnauthorizedError,
  ValidationError,
} from '../../middleware/errors.js';
import { logger } from '../../config/logger.js';
import { dmRoom, threadRoom } from '../rooms.js';
import { DM_JOIN, DM_LEAVE, THREAD_JOIN, THREAD_LEAVE, ERROR } from '@app/shared/constants/events';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';

/** Fully-typed Socket.io socket bound to the shared event contract. */
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/** Resolves an entity id to its Socket.io room key. */
type RoomKeyBuilder = (id: string) => string;

/** Authorizes the caller for the target entity; throws on denial. */
type AccessAssertion = (id: string, userId: string) => Promise<void>;

/** Validates a bare wire id as a Prisma cuid before it is used in a room key. */
const idSchema = z.string().cuid();

/**
 * Registers the DM and thread room-subscription listeners on a connected,
 * authenticated socket.
 *
 * Each listener is synchronous and delegates to its async handler with a `void`
 * prefix so the returned promise is intentionally not awaited (these events are
 * fire-and-forget: failure surfaces through the private `error` event, not an
 * acknowledgement callback), satisfying the `no-floating-promises` rule.
 *
 * @param socket - the connecting socket whose subscription events are handled.
 */
export function registerSubscriptionHandlers(socket: AppSocket): void {
  socket.on(DM_JOIN, (dmId) => {
    void handleJoin(socket, DM_JOIN, dmRoom, assertDmAccess, dmId);
  });

  socket.on(DM_LEAVE, (dmId) => {
    void handleLeave(socket, DM_LEAVE, dmRoom, dmId);
  });

  socket.on(THREAD_JOIN, (parentId) => {
    void handleJoin(socket, THREAD_JOIN, threadRoom, assertThreadAccess, parentId);
  });

  socket.on(THREAD_LEAVE, (parentId) => {
    void handleLeave(socket, THREAD_LEAVE, threadRoom, parentId);
  });
}

/**
 * Validates, authorizes, and subscribes the live socket to a room.
 *
 * Flow: validate the wire id as a cuid (Gate 12) → enforce the entity ACL via
 * `assertAccess` → `socket.join(roomKey(id))` → structured success log. On any
 * failure {@link handleError} emits a private `error` event to the originating
 * socket (fire-and-forget: there is no acknowledgement callback).
 *
 * @param socket - the originating socket (provides `socket.data.userId`).
 * @param event - the inbound event name (`dm:join` / `thread:join`).
 * @param roomKey - maps the validated id to its room key.
 * @param assertAccess - the entity ACL to enforce before subscribing.
 * @param id - the unvalidated target id from the wire event.
 */
async function handleJoin(
  socket: AppSocket,
  event: typeof DM_JOIN | typeof THREAD_JOIN,
  roomKey: RoomKeyBuilder,
  assertAccess: AccessAssertion,
  id: string,
): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;
  try {
    const validId = idSchema.parse(id);
    await assertAccess(validId, userId);
    await socket.join(roomKey(validId));

    logger.info(
      {
        component: 'subscription.handler',
        event,
        socketId: socket.id,
        userId,
        targetId: validId,
        latency: Date.now() - start,
      },
      'room subscription join handled',
    );
  } catch (err: unknown) {
    handleError(socket, event, userId, id, start, err);
  }
}

/**
 * Validates and unsubscribes the live socket from a room.
 *
 * Flow: validate the wire id as a cuid → `socket.leave(roomKey(id))` →
 * structured success log. No ACL is enforced: leaving a room the socket is not
 * in is a harmless no-op, and durable DM participation / channel membership is
 * never affected by a leave. On a malformed id {@link handleError} emits a
 * private `error` event.
 *
 * @param socket - the originating socket (provides `socket.data.userId`).
 * @param event - the inbound event name (`dm:leave` / `thread:leave`).
 * @param roomKey - maps the validated id to its room key.
 * @param id - the unvalidated target id from the wire event.
 */
async function handleLeave(
  socket: AppSocket,
  event: typeof DM_LEAVE | typeof THREAD_LEAVE,
  roomKey: RoomKeyBuilder,
  id: string,
): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;
  try {
    const validId = idSchema.parse(id);
    await socket.leave(roomKey(validId));

    logger.info(
      {
        component: 'subscription.handler',
        event,
        socketId: socket.id,
        userId,
        targetId: validId,
        latency: Date.now() - start,
      },
      'room subscription leave handled',
    );
  } catch (err: unknown) {
    handleError(socket, event, userId, id, start, err);
  }
}

/**
 * Translates a thrown error into client feedback for a failed subscription
 * event. Emits a structured `logger.error` line, then sends a private `error`
 * event to the ORIGINATING socket (never a broadcast) so a global client error
 * handler can surface a toast.
 *
 * @param socket - the originating socket to notify.
 * @param event - the inbound event name that failed.
 * @param userId - the authenticated user id (for the log line).
 * @param targetId - the raw wire id (for the log line).
 * @param start - the `Date.now()` captured at handler entry (for latency).
 * @param err - the thrown error (Zod, ServiceError subclass, or unknown).
 */
function handleError(
  socket: AppSocket,
  event: string,
  userId: string,
  targetId: string,
  start: number,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : 'Internal error';
  const code = resolveErrorCode(err);

  logger.error(
    {
      component: 'subscription.handler',
      event,
      socketId: socket.id,
      userId,
      targetId,
      code,
      err: message,
      latency: Date.now() - start,
    },
    `${event} failed`,
  );

  socket.emit(ERROR, { code, message });
}

/**
 * Maps a thrown error to a stable Socket.io error code string. Concrete
 * `ServiceError` subclasses are checked before the abstract base so each
 * receives its specific code; `ZodError` (id validation) maps to
 * `VALIDATION_ERROR`.
 *
 * @param err - the thrown error to classify.
 * @returns the error code string surfaced to the client.
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
