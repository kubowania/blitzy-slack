/**
 * Socket.io event-name string constants for the Blitzy Slack real-time wire
 * protocol.
 *
 * These constants pair with the typed Socket.io interfaces in
 * ../types/socket-events.ts. The constant NAME (left side) is for code
 * authoring ergonomics; the string VALUE (right side) is what travels over
 * the wire and MUST match the key in ClientToServerEvents/ServerToClientEvents.
 *
 * Per AAP §0.4.5, the event surface is split into:
 *   - Client → Server (actions the browser fires)
 *   - Server → Client (broadcasts the API emits to subscribed clients)
 *
 * Two events (TYPING_START, TYPING_STOP) appear on BOTH directions: the client
 * fires the action to notify the server, and the server broadcasts it back to
 * other room participants. The constant is declared ONCE and used in both
 * directions to keep the single source of truth.
 *
 * Per the Explainability rule (AAP §0.8.3), rationale for naming and design
 * choices is recorded in /docs/decision-log.md, not in these comments.
 */

// ===========================================================================
// Client → Server events (actions the browser fires)
// ===========================================================================

/** Client requests to join a channel room. */
export const CHANNEL_JOIN = 'channel:join' as const;

/** Client requests to leave a channel room. */
export const CHANNEL_LEAVE = 'channel:leave' as const;

/** Client requests to subscribe the live socket to a DM room (`dm:<id>`). */
export const DM_JOIN = 'dm:join' as const;

/** Client requests to unsubscribe the live socket from a DM room. */
export const DM_LEAVE = 'dm:leave' as const;

/** Client requests to subscribe the live socket to a thread room (`thread:<parentId>`). */
export const THREAD_JOIN = 'thread:join' as const;

/** Client requests to unsubscribe the live socket from a thread room. */
export const THREAD_LEAVE = 'thread:leave' as const;

/** Client sends a new message (channel or DM). */
export const MESSAGE_SEND = 'message:send' as const;

/** Client toggles a reaction on a message (add). */
export const REACTION_ADD = 'reaction:add' as const;

/** Client toggles a reaction on a message (remove). */
export const REACTION_REMOVE = 'reaction:remove' as const;

/** Client begins typing in the composer (bidirectional — also Server → Client). */
export const TYPING_START = 'typing:start' as const;

/** Client stops typing in the composer (bidirectional — also Server → Client). */
export const TYPING_STOP = 'typing:stop' as const;

/** Client emits a presence heartbeat at HEARTBEAT_INTERVAL_MS cadence. */
export const PRESENCE_HEARTBEAT = 'presence:heartbeat' as const;

// ===========================================================================
// Server → Client events (broadcasts the API emits to subscribed clients)
// ===========================================================================
// Note: TYPING_START and TYPING_STOP are declared above and reused here in the
// Server → Client direction without redeclaration. The SOCKET_EVENTS bundle
// references them once.

/** Server broadcasts a newly persisted message to the channel/DM/thread room. */
export const MESSAGE_NEW = 'message:new' as const;

/** Server broadcasts an updated message (e.g., reaction-count refresh). */
export const MESSAGE_UPDATED = 'message:updated' as const;

/** Server broadcasts a reaction addition to the message's room. */
export const REACTION_ADDED = 'reaction:added' as const;

/** Server broadcasts a reaction removal to the message's room. */
export const REACTION_REMOVED = 'reaction:removed' as const;

/** Server broadcasts a presence state transition (online/away/offline). */
export const PRESENCE_UPDATE = 'presence:update' as const;

/**
 * Server emits a generic error payload to the originating socket. The wire
 * value `'error'` is Socket.io's reserved error channel.
 */
export const ERROR = 'error' as const;

// ===========================================================================
// Bundle object — convenience grouping for consumers who prefer
// `import { SOCKET_EVENTS }` over `import { MESSAGE_SEND, MESSAGE_NEW, ... }`.
// ===========================================================================

/**
 * All Socket.io event-name constants grouped as a single readonly object.
 *
 * Useful for consumers who want a single import:
 *     import { SOCKET_EVENTS } from '@app/shared';
 *     socket.emit(SOCKET_EVENTS.MESSAGE_SEND, payload);
 *
 * The individual named exports remain available for tree-shaking and direct
 * imports.
 */
export const SOCKET_EVENTS = {
  CHANNEL_JOIN,
  CHANNEL_LEAVE,
  DM_JOIN,
  DM_LEAVE,
  THREAD_JOIN,
  THREAD_LEAVE,
  MESSAGE_SEND,
  MESSAGE_NEW,
  MESSAGE_UPDATED,
  REACTION_ADD,
  REACTION_REMOVE,
  REACTION_ADDED,
  REACTION_REMOVED,
  TYPING_START,
  TYPING_STOP,
  PRESENCE_HEARTBEAT,
  PRESENCE_UPDATE,
  ERROR,
} as const;

/**
 * Union type of every Socket.io event-name string literal.
 *
 * Use as a contract assertion when accepting an event name as a parameter:
 *     function emit(event: SocketEventName, payload: unknown): void { ... }
 */
export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
