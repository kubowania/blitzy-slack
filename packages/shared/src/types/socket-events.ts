/**
 * Socket.io event interface contracts shared between @app/api (server)
 * and @app/web (client).
 *
 * Per AAP §0.4.5, this is the SINGLE declaration site for the real-time event
 * surface. Adding a new event requires updating BOTH this file AND the
 * matching constant in `../constants/events.ts`.
 *
 * Consumers pass these interfaces as generic type arguments:
 *
 *   // SERVER (packages/api/src/sockets/index.ts):
 *   import { Server } from 'socket.io';
 *   import type {
 *     ClientToServerEvents,
 *     ServerToClientEvents,
 *     InterServerEvents,
 *     SocketData,
 *   } from '@app/shared/types/socket-events';
 *   const io = new Server<
 *     ClientToServerEvents,
 *     ServerToClientEvents,
 *     InterServerEvents,
 *     SocketData
 *   >(httpServer);
 *
 *   // CLIENT (packages/web/src/lib/socket.ts):
 *   import { io } from 'socket.io-client';
 *   import type {
 *     ClientToServerEvents,
 *     ServerToClientEvents,
 *   } from '@app/shared/types/socket-events';
 *   // NOTE: the generic order is INVERTED on the client.
 *   const socket = io<ServerToClientEvents, ClientToServerEvents>(VITE_WS_URL);
 *
 * The asymmetry is intentional: on the server, the FIRST generic describes
 * what the server RECEIVES; on the client, the FIRST generic describes what
 * the client RECEIVES.
 *
 * LEAF invariant: this file declares Socket.io generic interfaces WITHOUT
 * importing the `socket.io` or `socket.io-client` library. Consumers pass
 * these interfaces in as generic arguments; the library types do the rest.
 */

import type { Message, MessageWithAuthor, ReactionSummary } from './message.js';
import type { PresenceUpdate } from './presence.js';

/**
 * Events the CLIENT emits to the SERVER. Each property is a function whose
 * parameters are the event payload(s) plus an optional acknowledgement
 * callback.
 */
export interface ClientToServerEvents {
  /**
   * Subscribe the socket to a channel room (`channel:<id>`).
   * @param channelId - The channel to join.
   * @param ack - Acknowledgement: `true` on success, `false` if not a member.
   */
  'channel:join': (channelId: string, ack: (ok: boolean) => void) => void;

  /**
   * Unsubscribe the socket from a channel room.
   * @param channelId - The channel to leave.
   * @param ack - Acknowledgement: `true` on success.
   */
  'channel:leave': (channelId: string, ack: (ok: boolean) => void) => void;

  /**
   * Send a new message into a channel, DM, or thread.
   * The server validates that the authenticated socket has permission to post
   * to the target channel/DM, persists the message, and broadcasts
   * `message:new` to subscribers.
   * @param payload - Message body and routing fields.
   * @param ack - Acknowledgement: the persisted message on success, or an
   *              error envelope on failure.
   */
  'message:send': (
    payload: {
      content: string;
      channelId?: string;
      dmId?: string;
      parentId?: string;
      fileId?: string;
    },
    ack: (response: MessageWithAuthor | { error: string }) => void,
  ) => void;

  /**
   * Add a reaction emoji to a message. Idempotent — re-adding the same
   * reaction does not duplicate.
   */
  'reaction:add': (payload: { messageId: string; emoji: string }) => void;

  /**
   * Remove a reaction emoji from a message. Idempotent — removing a
   * non-existent reaction is a no-op.
   */
  'reaction:remove': (payload: { messageId: string; emoji: string }) => void;

  /**
   * Notify the server that the user has begun typing in a channel or DM.
   * The server broadcasts a `typing:start` to other room participants.
   * EXACTLY ONE of `channelId` or `dmId` MUST be set.
   */
  'typing:start': (payload: { channelId?: string; dmId?: string }) => void;

  /**
   * Notify the server that the user has stopped typing.
   * The server broadcasts a `typing:stop` to other room participants.
   * EXACTLY ONE of `channelId` or `dmId` MUST be set.
   */
  'typing:stop': (payload: { channelId?: string; dmId?: string }) => void;

  /**
   * Presence heartbeat (emitted by the client every HEARTBEAT_INTERVAL_MS
   * while the tab is focused). The server refreshes the user's Redis TTL.
   */
  'presence:heartbeat': () => void;
}

/**
 * Events the SERVER emits to the CLIENT. Each property is a function whose
 * parameters describe the event payload(s). Server events do NOT carry
 * acknowledgement callbacks.
 */
export interface ServerToClientEvents {
  /**
   * A new message was posted to a room the socket is subscribed to.
   * The payload is the fully-hydrated message including author and any
   * attached file.
   */
  'message:new': (message: MessageWithAuthor) => void;

  /**
   * A message's content or metadata was updated server-side (e.g., a
   * reaction-count refresh or future-edit scenario). The payload is the
   * BARE Message shape (no rehydrated author or reactions); subscribers
   * should reconcile against their local cache.
   */
  'message:updated': (message: Message) => void;

  /**
   * A reaction was added to a message in a subscribed room.
   * The payload contains the updated ReactionSummary so subscribers can
   * replace the message's reaction state directly.
   */
  'reaction:added': (payload: { messageId: string; reaction: ReactionSummary }) => void;

  /**
   * A reaction was removed from a message in a subscribed room.
   * The payload identifies which (emoji, userId) tuple was removed so
   * subscribers can decrement counts without a full ReactionSummary refresh.
   */
  'reaction:removed': (payload: { messageId: string; emoji: string; userId: string }) => void;

  /**
   * A user's presence state transitioned (online ↔ away ↔ offline).
   * Broadcast to subscribers of the relevant `user:<id>` room.
   */
  'presence:update': (update: PresenceUpdate) => void;

  /**
   * Another user has begun typing in a room the socket is subscribed to.
   * EXACTLY ONE of `channelId` or `dmId` is set, matching the originator's
   * `typing:start` payload.
   */
  'typing:start': (payload: { userId: string; channelId?: string; dmId?: string }) => void;

  /**
   * Another user has stopped typing in a room the socket is subscribed to.
   * EXACTLY ONE of `channelId` or `dmId` is set.
   */
  'typing:stop': (payload: { userId: string; channelId?: string; dmId?: string }) => void;

  /**
   * Generic error envelope emitted to the originating socket when a
   * Client→Server action fails outside of an acknowledgement callback.
   * The string `'error'` is Socket.io's reserved error channel.
   */
  error: (payload: { code: string; message: string }) => void;
}

/**
 * Events forwarded between Socket.io server instances by the Redis adapter.
 * Reserved for future cross-instance signalling (e.g., admin broadcasts,
 * cluster-wide presence sweeps). Currently only the conventional `ping`
 * placeholder is declared.
 */
export interface InterServerEvents {
  /** Cross-instance liveness probe used by the Redis adapter. */
  ping: () => void;
}

/**
 * Per-socket auxiliary data attached by the JWT handshake middleware in
 * `packages/api/src/middleware/socket-auth.ts`. After successful handshake,
 * `socket.data.userId` and `socket.data.email` are available on every
 * handler.
 */
export interface SocketData {
  /** Authenticated user's database id (cuid). */
  userId: string;
  /** Authenticated user's email (denormalized from the JWT for log lines). */
  email: string;
}
