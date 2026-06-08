/**
 * Socket.io room-key construction helpers for the `@app/api` package.
 *
 * This module is the single source of truth for every Socket.io room name used
 * across the server. Each helper maps an entity identifier to the room key that
 * segments real-time broadcasts (AAP §0.4.5 Real-Time Event Contract):
 *
 *   channelRoom(id) → `channel:<id>`  — members of a public or private channel
 *   dmRoom(id)      → `dm:<id>`        — both direct-message participants
 *   threadRoom(id)  → `thread:<id>`    — subscribers of an open thread panel
 *   userRoom(id)    → `user:<id>`      — every socket of one user (multi-device)
 *
 * Every `io.to(...)`, `io.in(...)`, `socket.join(...)`, and `socket.leave(...)`
 * call across the codebase routes through these helpers — never inline string
 * concatenation — so the room-key format stays identical to the keys the Redis
 * adapter publishes on.
 *
 * This is a foundational, zero-import module: the helpers are pure, content-
 * blind string builders with no side effects, so they behave identically in the
 * server, in Jest, and in any other execution context. Input validation (cuid
 * shape, non-empty) is performed by the Zod schemas at the route and socket
 * boundary, not here.
 *
 * Rationale for centralizing room-key construction and for the four-helper
 * design is recorded in /docs/decision-log.md; per the Explainability rule
 * (AAP §0.8.3) this file carries no embedded "why" rationale.
 */

/**
 * Constructs the Socket.io room key for a channel.
 *
 * Every member of a public or private channel joins this room when they enter
 * the workspace. Channel-scoped broadcasts (new messages, typing indicators,
 * reaction updates) target this room.
 *
 * @param channelId - Prisma cuid identifying the Channel
 * @returns The Socket.io room key, e.g., `'channel:cl9ebqhxk0000ek6m4ssjp4u3'`
 */
export const channelRoom = (channelId: string): string => `channel:${channelId}`;

/**
 * Constructs the Socket.io room key for a direct-message conversation.
 *
 * Both DM participants join this room when the DM is opened. DM-scoped
 * broadcasts (new messages, typing indicators) target this room.
 *
 * @param dmId - Prisma cuid identifying the DirectMessage conversation
 * @returns The Socket.io room key, e.g., `'dm:cl9ecqhxk0000ek6m4ssjp4u4'`
 */
export const dmRoom = (dmId: string): string => `dm:${dmId}`;

/**
 * Constructs the Socket.io room key for a message thread.
 *
 * Subscribers transiently join this room when a thread side-panel is open;
 * thread-reply broadcasts target this room. Per AAP §0.6.2, thread-reply events
 * also broadcast to the parent channel/DM room so unread counts update across
 * all subscribers.
 *
 * @param parentId - Prisma cuid identifying the parent Message
 * @returns The Socket.io room key, e.g., `'thread:cl9edqhxk0000ek6m4ssjp4u5'`
 */
export const threadRoom = (parentId: string): string => `thread:${parentId}`;

/**
 * Constructs the Socket.io room key for a single user's sockets (across all
 * their tabs / devices).
 *
 * On connect, every authenticated socket auto-joins its owner's user room so
 * that:
 *   1. Targeted broadcasts (e.g., DM notifications when the conversation is not
 *      currently open) reach every device the user is logged in on.
 *   2. The disconnect handler can determine whether the user still has
 *      remaining live sockets before clearing their presence state (multi-tab
 *      safety).
 *
 * @param userId - Prisma cuid identifying the User
 * @returns The Socket.io room key, e.g., `'user:cl9efqhxk0000ek6m4ssjp4u6'`
 */
export const userRoom = (userId: string): string => `user:${userId}`;
