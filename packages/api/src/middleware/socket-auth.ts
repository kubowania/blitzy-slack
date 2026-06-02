/**
 * Socket.io JWT handshake middleware for the `@app/api` package.
 *
 * Verifies the JSON Web Token presented during the Socket.io connection
 * handshake and, on success, attaches the authenticated identity to
 * `socket.data` so every downstream connection handler can read
 * `socket.data.userId` and `socket.data.email` without re-parsing the token.
 *
 * Real-time contract (AAP Rule 2): WebSocket connections are authenticated
 * identically to HTTP routes. The token travels in the handshake exclusively
 * via `socket.handshake.auth.token`; query-string tokens are NOT accepted.
 *
 * Single-verifier discipline (AAP §0.8.4): verification is delegated to the
 * SAME `verifyToken` helper the HTTP `requireAuth` middleware uses; this module
 * contains no `jwt.verify` logic of its own, so both layers evolve together
 * with no drift.
 *
 * Rejection contract: a missing or invalid token is surfaced to the client as a
 * `connect_error` carrying the constant message `'Unauthorized'`. The
 * service-layer error is translated into a generic `Error` so no server-side
 * error class, stack, or detail reaches the client.
 *
 * Layering: this middleware performs no database, Redis, or signing work. It
 * reads the handshake and delegates verification to the service layer.
 *
 * Per the Explainability rule (AAP §0.8.3) design rationale lives in
 * /docs/decision-log.md, not in these comments.
 */
import type { DefaultEventsMap, ExtendedError, Socket } from 'socket.io';

import { logger } from '../config/logger.js';
import { verifyToken } from '../services/auth.service.js';

/**
 * Typed per-connection data attached to an authenticated socket. Bound as the
 * `SocketData` type argument of {@link HandshakeSocket} so `socket.data.userId`
 * and `socket.data.email` resolve to `string` (never `unknown` or `any`) for
 * every connection handler registered after this middleware.
 */
interface SocketData {
  /** Authenticated user's database id (the JWT `sub` claim; a cuid). */
  userId: string;
  /** Authenticated user's email (denormalized from the JWT). */
  email: string;
}

/**
 * A handshake-stage socket carrying the {@link SocketData} identity payload.
 * The three event-map type arguments are left at Socket.io's defaults: this
 * middleware reads only the handshake and writes only `socket.data`, and
 * neither listens for nor emits domain events.
 */
type HandshakeSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

/**
 * Reads the JWT from the Socket.io handshake `auth` payload
 * (`handshake.auth.token`). Returns the token string, or `undefined` when it is
 * missing or is not a non-empty string.
 *
 * Only `handshake.auth.token` is honored — query-string tokens are rejected.
 * The web client always sends the token via `auth.token`.
 *
 * The `auth` value is read through an `unknown` binding: Socket.io types
 * `handshake.auth` with an `any`-valued index signature, and the `typeof` guard
 * narrows it back to a concrete `string`. This helper never throws.
 */
const extractToken = (socket: HandshakeSocket): string | undefined => {
  const fromAuth: unknown = socket.handshake.auth.token;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) {
    return fromAuth;
  }
  return undefined;
};

/**
 * Socket.io handshake middleware. Mount once via `io.use(socketAuth)` before
 * any connection handlers are registered.
 *
 * On success it attaches `userId` and `email` to `socket.data` and calls
 * `next()`. On a missing or invalid token it emits a structured `warn` log line
 * and calls `next(new Error('Unauthorized'))`, which Socket.io delivers to the
 * client as a `connect_error`. The middleware is synchronous; `verifyToken`
 * performs a synchronous HS256 verification.
 *
 * @param socket - The connecting socket, at handshake time (pre-`connection`).
 * @param next - Socket.io continuation callback: called with no argument to
 *   accept the connection, or with an `Error` to reject it.
 */
export const socketAuth = (socket: HandshakeSocket, next: (err?: ExtendedError) => void): void => {
  const token = extractToken(socket);
  if (token === undefined) {
    logger.warn(
      { socketId: socket.id, remoteAddress: socket.handshake.address },
      'Socket.io handshake rejected: missing token',
    );
    next(new Error('Unauthorized'));
    return;
  }

  try {
    const payload = verifyToken(token);
    socket.data.userId = payload.sub;
    socket.data.email = payload.email;
    logger.debug({ socketId: socket.id, userId: payload.sub }, 'Socket.io handshake authenticated');
    next();
  } catch (err) {
    logger.warn(
      {
        socketId: socket.id,
        remoteAddress: socket.handshake.address,
        err: err instanceof Error ? { name: err.name, message: err.message } : err,
      },
      'Socket.io handshake rejected: invalid token',
    );
    next(new Error('Unauthorized'));
  }
};
