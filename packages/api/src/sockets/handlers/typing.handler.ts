/**
 * Socket.io event handler for the typing-indicator family.
 *
 * Attaches `typing:start` and `typing:stop` listeners to an authenticated
 * socket. On each event the handler validates the wire payload, enforces the
 * SAME channel-membership / DM-participation ACL used by the message and
 * reaction paths, and re-broadcasts the indicator to the other participants of
 * the target room — never echoing it back to the originating socket.
 *
 * Real-time contract (AAP §0.4.5):
 *   - Listens: `typing:start` / `typing:stop`  (client → server) — `{ channelId?, dmId? }`, NO ack
 *   - Emits:   `typing:start` / `typing:stop`  (server → the OTHER room members)
 *              with `{ userId, channelId?, dmId? }`
 *   - Emits:   `error`                          (server → originating socket, on failure)
 *
 * Identity-spoofing safety: the broadcast `userId` is taken from the
 * server-trusted `socket.data.userId` (populated by the socket-auth
 * middleware), NEVER from the client payload — a client cannot claim another
 * user is typing.
 *
 * Broadcast targeting uses `socket.to(room)` so the indicator reaches every
 * OTHER socket in the room (the typist never sees their own indicator). The
 * Socket.io Redis adapter (AAP Rule 2) transparently fans the emit out to
 * room members connected to any API instance.
 *
 * Fire-and-forget: typing events carry no acknowledgement. A validation/ACL
 * failure is logged at `warn` and surfaced to the originating socket via the
 * reserved `error` event; the indicator is simply not broadcast.
 *
 * Layering: this handler performs NO database, Redis, or JWT work directly. It
 * delegates access control to the exported `assertChannelAccess` /
 * `assertDmAccess` service helpers and relies on the server-level socket-auth
 * middleware to populate `socket.data.userId`.
 *
 * Structured logging (AAP §0.8.2 Gate 10) is emitted through the Pino `logger`
 * singleton with `component`, `event`, `socketId`, `userId`, and `latency`
 * fields. Per the Explainability rule (AAP §0.8.3) design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import type { Socket } from 'socket.io';
import { ZodError } from 'zod';

import { assertChannelAccess, assertDmAccess } from '../../services/messages.service.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceError,
  UnauthorizedError,
  ValidationError,
} from '../../middleware/errors.js';
import { logger } from '../../config/logger.js';
import { channelRoom, dmRoom } from '../rooms.js';
import { typingScopeSchema } from '@app/shared/schemas/message';
import { ERROR, TYPING_START, TYPING_STOP } from '@app/shared/constants/events';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';

/** Fully-typed Socket.io socket bound to the shared event contract. */
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Wire payload accepted by `typing:start` / `typing:stop`. Mirrors the payload
 * arm of `ClientToServerEvents['typing:start' | 'typing:stop']`; the schema
 * enforces that exactly one of `channelId` / `dmId` is present.
 */
interface TypingScopePayload {
  /** Target channel id; mutually exclusive with `dmId`. */
  channelId?: string;
  /** Target DM id; mutually exclusive with `channelId`. */
  dmId?: string;
}

/**
 * Server → client typing-indicator broadcast payload. The `userId` is the
 * server-trusted identity of the typist; the scope echoes the validated
 * `channelId` / `dmId`.
 */
interface TypingBroadcast {
  userId: string;
  channelId?: string;
  dmId?: string;
}

/**
 * Registers the `typing:start` and `typing:stop` listeners on a connected,
 * authenticated socket.
 *
 * Each listener is synchronous and delegates to the async {@link handleTyping}
 * with a `void` prefix so the returned promise is intentionally not awaited
 * (typing events are fire-and-forget; the `no-floating-promises` rule is
 * satisfied by the explicit `void`).
 *
 * Only the socket is required — broadcasts use `socket.to(room)` (which the
 * Redis adapter still fans out cross-instance), so the `io` server reference is
 * not needed here.
 *
 * @param socket - The connecting socket whose typing events are handled;
 *   provides `socket.data.userId` and `socket.id`.
 */
export function registerTypingHandlers(socket: AppSocket): void {
  socket.on(TYPING_START, (payload: TypingScopePayload) => {
    void handleTyping(socket, TYPING_START, payload);
  });
  socket.on(TYPING_STOP, (payload: TypingScopePayload) => {
    void handleTyping(socket, TYPING_STOP, payload);
  });
}

/**
 * Validates, ACL-checks, and re-broadcasts a single typing indicator.
 *
 * Flow:
 *   1. Validate the wire payload with `typingScopeSchema` (Gate 12) — enforces
 *      the channel/DM XOR invariant and cuid shape.
 *   2. Enforce the room ACL via `assertChannelAccess` / `assertDmAccess` (the
 *      same membership/participation checks the message path uses), so a
 *      non-member cannot announce typing into a room they cannot post to.
 *   3. Broadcast the indicator to the room EXCLUDING the originating socket,
 *      stamping the server-trusted `userId`.
 *
 * On any failure the indicator is NOT broadcast: the error is logged at `warn`
 * and a private `error` event is sent to the originating socket.
 *
 * @param socket - The originating socket (provides `socket.data.userId`).
 * @param event - Which indicator to re-broadcast (`typing:start`/`typing:stop`).
 * @param rawPayload - The unvalidated typing-scope payload from the client.
 */
async function handleTyping(
  socket: AppSocket,
  event: typeof TYPING_START | typeof TYPING_STOP,
  rawPayload: TypingScopePayload,
): Promise<void> {
  const start = Date.now();
  const userId = socket.data.userId;
  try {
    const { channelId, dmId } = typingScopeSchema.parse(rawPayload);

    let room: string;
    let payload: TypingBroadcast;
    if (channelId !== undefined) {
      await assertChannelAccess(channelId, userId);
      room = channelRoom(channelId);
      payload = { userId, channelId };
    } else if (dmId !== undefined) {
      await assertDmAccess(dmId, userId);
      room = dmRoom(dmId);
      payload = { userId, dmId };
    } else {
      // Unreachable: the XOR superRefinement guarantees exactly one of
      // channelId / dmId survives validation. Returning keeps the type checker
      // satisfied without a non-null assertion.
      return;
    }

    // Broadcast to the room EXCLUDING the originating socket — a user never
    // sees their own typing indicator. `socket.to(...)` is adapter-aware, so
    // the emit still reaches room members on other API instances (Rule 2). The
    // event is branched to a literal so the typed emitter resolves its payload.
    if (event === TYPING_START) {
      socket.to(room).emit(TYPING_START, payload);
    } else {
      socket.to(room).emit(TYPING_STOP, payload);
    }

    logger.debug(
      {
        component: 'typing.handler',
        event,
        socketId: socket.id,
        userId,
        channelId,
        dmId,
        latency: Date.now() - start,
      },
      'typing indicator broadcast',
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal error';
    const code = resolveErrorCode(err);

    logger.warn(
      {
        component: 'typing.handler',
        event,
        socketId: socket.id,
        userId,
        code,
        err: message,
        latency: Date.now() - start,
      },
      'typing indicator failed',
    );

    socket.emit(ERROR, { code, message });
  }
}

/**
 * Maps a thrown error to a stable Socket.io error code string, matching the
 * classification used by the message handler so clients see a uniform `error`
 * contract across realtime events.
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
