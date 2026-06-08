/**
 * Message fan-out helper for the `@app/api` package.
 *
 * Centralizes the Socket.io broadcast that follows EVERY successful message
 * create, so the REST write path (`POST /api/messages`, the path-scoped
 * `POST /api/channels/:id/messages` and `POST /api/dms/:id/messages`) and the
 * Socket.io `message:send` handler all emit one identical, authoritative event
 * shape. Previously each call site inlined its own routing logic; consolidating
 * here removes the drift risk and is the single producer of `message:new` and
 * `message:updated` (AAP §0.4.5 Real-Time Event Contract, Rule 2).
 *
 * Broadcast contract:
 *   MESSAGE_NEW (payload: MessageWithAuthor)
 *     - thread reply (parentId !== null) → DUAL broadcast: the thread room AND
 *       the parent's container room (channel OR DM), so the channel/DM timeline
 *       reply-count badge updates alongside the open thread panel
 *     - top-level channel message → channel room only
 *     - top-level DM message      → DM room only
 *   MESSAGE_UPDATED (payload: MessageWithAuthor)
 *     - emitted ONLY for a thread reply, carrying the re-hydrated PARENT message
 *       (with its authoritative incremented replyCount) to the parent's
 *       container room, so subscribers reconcile the parent against the server
 *       snapshot. Fetched and emitted fire-and-forget AFTER the MESSAGE_NEW
 *       emit so per-connection event order is `message:new` then
 *       `message:updated`.
 *
 * The Socket.io Redis adapter (AAP Rule 2) transparently fans every emit out to
 * subscribers connected to any API instance. Per the Explainability rule
 * (AAP §0.8.3) design rationale lives in /docs/decision-log.md, not here.
 */
import type { Server } from 'socket.io';

import { logger } from '../config/logger.js';
import { getMessageById } from '../services/messages.service.js';
import { channelRoom, dmRoom, threadRoom } from './rooms.js';
import { MESSAGE_NEW, MESSAGE_UPDATED } from '@app/shared/constants/events';
import type { MessageWithAuthor } from '@app/shared/types/message';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';

/** Fully-typed Socket.io server bound to the shared event contract. */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Resolve the Socket.io room key(s) a `message:new` broadcast targets from the
 * message's location: a thread reply dual-broadcasts to its thread room AND its
 * container room; a top-level message targets only its channel or DM room.
 *
 * @param message - the hydrated, authoritative message DTO from the service.
 * @returns the room keys to broadcast `message:new` to (1 or 2 entries; `[]`
 *   for the schema-impossible case of a message with no container).
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
 * Resolve the SINGLE container room key for a thread reply's parent (the
 * channel or DM the thread lives in), or `null` when the reply has neither.
 *
 * @param message - the thread reply (parentId !== null).
 * @returns the parent's container room key, or `null`.
 */
function containerRoomFor(message: MessageWithAuthor): string | null {
  if (message.channelId !== null) {
    return channelRoom(message.channelId);
  }
  if (message.dmId !== null) {
    return dmRoom(message.dmId);
  }
  return null;
}

/**
 * Broadcast the realtime events that follow a successful message create.
 *
 * Synchronous and fire-and-forget: the `message:new` emit is issued
 * immediately; for a thread reply, the parent re-hydration and `message:updated`
 * emit run on a detached promise so the HTTP response (or socket ack) is never
 * delayed by the extra DB round-trip. A failure to re-hydrate the parent is
 * logged and swallowed — the reply itself has already been delivered via
 * `message:new`, and the timeline's optimistic reply-count bump keeps the badge
 * correct, so a missed `message:updated` reconciliation is non-fatal.
 *
 * @param io - the typed Socket.io server used for the room broadcasts.
 * @param message - the hydrated, authoritative message DTO returned by the
 *   message service (REST or socket path).
 */
export function broadcastCreatedMessage(io: AppServer, message: MessageWithAuthor): void {
  const rooms = resolveBroadcastRooms(message);
  for (const room of rooms) {
    io.to(room).emit(MESSAGE_NEW, message);
  }

  if (message.parentId === null) {
    return;
  }

  // Thread reply: reconcile the parent's reply count on every timeline showing
  // it. Re-read the parent (authoritative replyCount) and emit `message:updated`
  // to the container room AFTER `message:new`, fire-and-forget so the response
  // is not blocked. The reply author can always read the parent (they just
  // replied to it), so the ACL inside getMessageById passes.
  const parentId = message.parentId;
  const containerRoom = containerRoomFor(message);
  if (containerRoom === null) {
    return;
  }

  void getMessageById({ messageId: parentId, userId: message.authorId })
    .then((parent) => {
      io.to(containerRoom).emit(MESSAGE_UPDATED, parent);
    })
    .catch((err: unknown) => {
      logger.warn(
        {
          component: 'message-broadcast',
          event: MESSAGE_UPDATED,
          parentId,
          replyId: message.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'failed to re-hydrate thread parent for message:updated',
      );
    });
}
