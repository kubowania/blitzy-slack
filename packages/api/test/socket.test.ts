/**
 * @file packages/api/test/socket.test.ts
 *
 * Jest + socket.io-client integration tests for the WebSocket layer of
 * `@app/api`. Each test spins up a real HTTP server bound to an ephemeral port,
 * attaches a typed Socket.io server wired with the SAME Redis adapter and the
 * SAME `registerSocketHandlers` graph used in production, and drives it with
 * authenticated socket.io-client connections.
 *
 * Coverage:
 *   - JWT handshake middleware: valid connect; missing / invalid / expired token
 *     all reject with `connect_error` carrying `'Unauthorized'`.
 *   - Channel room subscription: `channel:join` ack(true)/ack(false) + room state.
 *   - `channel:leave`: socket leaves the room (durable membership untouched).
 *   - `message:send`: channel broadcast, DM broadcast, thread (parent-room)
 *     broadcast, ack with the persisted `MessageWithAuthor`, ack error envelope.
 *   - Reactions: `reaction:added` (full `ReactionSummary`) vs the asymmetric
 *     `reaction:removed` (`{ messageId, emoji, userId }` tuple, no summary).
 *   - Presence: TRANSITION-ONLY `presence:update` broadcasts (silent on a
 *     repeated same-state heartbeat); targeted to the subject's authorized
 *     audience (own `user:<id>` room + co-member channel/DM rooms).
 *   - Typing indicators: `typing:start` / `typing:stop` reach other room
 *     members but never echo back to the originator.
 *   - Multi-tab disconnect safety: no offline broadcast while another tab of the
 *     same user remains; offline broadcast only when the LAST tab disconnects.
 *   - `error` envelope emitted to the sender on a forbidden `message:send`.
 *
 * Compliance:
 *   Rule 2  — All real-time updates traverse Socket.io with the Redis adapter.
 *   Rule 3  — Zero-warning strict TypeScript (no `@ts-ignore`/`@ts-expect-error`,
 *             no unsafe `any` access; the generic `.once` is routed through a
 *             minimal typed structural interface).
 *   Gate 9  — Message delivery < 500 ms; presence propagation < 5 s.
 *   Gate 10 — Pino logs every socket event (verified indirectly: handlers run
 *             without crashing and produce the expected broadcasts).
 *   Gate 13 — Contributes coverage to the socket handlers + presence.service.
 *
 * AAP refs: §0.4.5 (event surface + rooms), §0.6.2 (Redis adapter, presence TTL),
 *           §0.8.1 Rule 2, §0.8.4 (typed events, presence semantics, JWT scope).
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket as IOClientSocket } from 'socket.io-client';
import { createAdapter } from '@socket.io/redis-adapter';

import { SOCKET_EVENTS } from '@app/shared/constants/events';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
} from '@app/shared/types/socket-events';
import type { MessageWithAuthor, ReactionSummary } from '@app/shared/types/message';
import type { PresenceUpdate } from '@app/shared/types/presence';

import {
  cleanDatabase,
  closeTestResources,
  registerUser,
  createTestChannel,
  createTestDm,
  signTestToken,
  prismaTest,
  pubClient,
  subClient,
  redisClient,
} from './setup.js';
import { registerSocketHandlers } from '../src/sockets/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Client-side socket type. Per AAP §0.8.4 the generic order is INVERTED on the
 * client: the FIRST argument is what the client RECEIVES (`ServerToClientEvents`)
 * and the SECOND is what it SENDS (`ClientToServerEvents`).
 */
type ClientConn = IOClientSocket<ServerToClientEvents, ClientToServerEvents>;

/** Fully-typed test Socket.io server (server generic order: C2S, S2C, Inter, Data). */
type TestIOServer = IOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** Handle to a running test Socket.io server bound to an ephemeral port. */
interface TestServer {
  httpServer: HttpServer;
  io: TestIOServer;
  port: number;
  url: string;
}

/**
 * Minimal structural view of a socket's `.once` used by the generic
 * {@link waitForEvent} helper. The typed client `.once` cannot accept a
 * variadic `unknown[]` listener for a *generic* event key, so the call is
 * routed through this interface via a double cast. No `any` is introduced, so
 * the `no-unsafe-*` rules remain satisfied (Rule 3).
 */
interface UntypedOnceEmitter {
  once(event: string, listener: (...args: unknown[]) => void): void;
}

// ---------------------------------------------------------------------------
// Server / client harness
// ---------------------------------------------------------------------------

/** No-op acknowledgement for fire-and-forget emits whose ack is not asserted. */
const noopAck = (): void => undefined;

/**
 * Builds a raw HTTP server, attaches a typed Socket.io server wired with the
 * SAME Redis adapter and handler registration as production (Rule 2), and binds
 * it to an ephemeral port (port 0) to avoid collisions with other suites.
 *
 * Declared non-`async` (returns the listen Promise directly) so it contains no
 * `await`, satisfying `@typescript-eslint/require-await`.
 */
function startTestSocketServer(): Promise<TestServer> {
  const httpServer = createServer();
  const io: TestIOServer = new IOServer<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, { cors: { origin: '*' } });

  // Wire the Redis pub/sub adapter so broadcast semantics match production.
  io.adapter(createAdapter(pubClient, subClient));
  // Register the production handler graph (JWT auth + channel/message/reaction/
  // presence/typing handlers) onto the test server.
  registerSocketHandlers(io);

  return new Promise<TestServer>((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address() as AddressInfo;
      resolve({
        httpServer,
        io,
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

/** Closes the Socket.io server then the underlying HTTP server. */
async function stopTestSocketServer(server: TestServer): Promise<void> {
  await new Promise<void>((resolve) => {
    // `io.close()` also returns a Promise in Socket.io v4; the callback drives
    // resolution here, so the returned Promise is explicitly ignored.
    void server.io.close(() => {
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    // `httpServer.close()` may already be closed by `io.close()`; the callback
    // ignores its error argument and resolves regardless.
    server.httpServer.close(() => {
      resolve();
    });
  });
}

/**
 * Opens a fresh authenticated client. `forceNew` + `reconnection: false` keep
 * each test's connection isolated; `transports: ['websocket']` skips the
 * long-polling upgrade dance for speed and determinism.
 */
function connectClient(url: string, token: string): ClientConn {
  // socket.io-client's `io()` takes no type arguments and returns a bare
  // `Socket`; the typed event maps are applied via the `ClientConn` return
  // annotation (the documented socket.io-client typing pattern).
  const socket: ClientConn = ioClient(url, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  return socket;
}

/** Resolves when the socket completes its handshake; rejects on `connect_error`. */
function waitForConnect(socket: ClientConn, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for connect'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Resolves with the handshake error; rejects if the socket unexpectedly connects. */
function waitForConnectError(socket: ClientConn, timeoutMs = 2000): Promise<Error> {
  return new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for connect_error'));
    }, timeoutMs);
    socket.once('connect_error', (err: Error) => {
      clearTimeout(timer);
      resolve(err);
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      reject(new Error('Expected connect_error but the socket connected'));
    });
  });
}

/**
 * Resolves with the payload tuple of the next `event` the socket receives, or
 * rejects after `timeoutMs`. The generic event key forces the `.once` call
 * through {@link UntypedOnceEmitter}; the resolved tuple is typed precisely as
 * `Parameters<ServerToClientEvents[E]>`.
 */
function waitForEvent<E extends keyof ServerToClientEvents>(
  socket: ClientConn,
  event: E,
  timeoutMs = 2000,
): Promise<Parameters<ServerToClientEvents[E]>> {
  return new Promise<Parameters<ServerToClientEvents[E]>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${String(event)}`));
    }, timeoutMs);
    (socket as unknown as UntypedOnceEmitter).once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args as Parameters<ServerToClientEvents[E]>);
    });
  });
}

/** Emits `channel:join` and resolves with the boolean ack. */
function emitChannelJoin(socket: ClientConn, channelId: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for channel:join ack'));
    }, timeoutMs);
    socket.emit(SOCKET_EVENTS.CHANNEL_JOIN, channelId, (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

/** Emits `channel:leave` and resolves with the boolean ack. */
function emitChannelLeave(socket: ClientConn, channelId: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for channel:leave ack'));
    }, timeoutMs);
    socket.emit(SOCKET_EVENTS.CHANNEL_LEAVE, channelId, (ok: boolean) => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

/** Emits `message:send` and resolves with the ack (persisted message or error envelope). */
function emitMessageSend(
  socket: ClientConn,
  payload: {
    content: string;
    channelId?: string;
    dmId?: string;
    parentId?: string;
    fileId?: string;
  },
  timeoutMs = 2000,
): Promise<MessageWithAuthor | { error: string }> {
  return new Promise<MessageWithAuthor | { error: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for message:send ack'));
    }, timeoutMs);
    socket.emit(SOCKET_EVENTS.MESSAGE_SEND, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

/**
 * Polls the server-side adapter until `room` holds at least `expectedSize`
 * sockets. Used to deterministically await asynchronous auto-joins (DM rooms
 * are joined via an awaited DB lookup in `autoJoinAuthorizedRooms`).
 */
async function waitForRoomMembership(
  io: TestIOServer,
  room: string,
  expectedSize: number,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const sockets = await io.in(room).fetchSockets();
    if (sockets.length >= expectedSize) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Room ${room} did not reach ${expectedSize} member(s) within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Socket.io integration (real-time WebSocket layer)', () => {
  let server: TestServer;
  const openClients: ClientConn[] = [];

  beforeAll(async () => {
    server = await startTestSocketServer();
  });

  beforeEach(async () => {
    // Reset relational state and presence/TTL keys so each test starts clean.
    await cleanDatabase();
    await redisClient.flushdb();
  });

  afterEach(() => {
    // Disconnect every client opened during the test to prevent room/state leak.
    for (const client of openClients.splice(0)) {
      if (client.connected) {
        client.disconnect();
      }
    }
  });

  afterAll(async () => {
    await stopTestSocketServer(server);
    // Allow in-flight disconnect handlers (presence-cleanup DB queries fired by
    // io.close()) to drain before Prisma/Redis are torn down, avoiding
    // teardown-race "Engine was empty" error logs.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await closeTestResources();
  });

  /**
   * Connects a client, tracks it for `afterEach` teardown, and resolves once the
   * handshake completes. Throws if the handshake is rejected.
   */
  async function connectAndTrack(token: string): Promise<ClientConn> {
    const client = connectClient(server.url, token);
    openClients.push(client);
    await waitForConnect(client);
    return client;
  }

  describe('JWT handshake middleware', () => {
    it('connects successfully with a valid JWT in handshake.auth.token', async () => {
      const { user } = await registerUser();
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));
      expect(client.connected).toBe(true);
    });

    it('rejects with connect_error when no token is provided', async () => {
      const client = connectClient(server.url, '');
      openClients.push(client);
      const err = await waitForConnectError(client);
      expect(err.message).toBe('Unauthorized');
      expect(client.connected).toBe(false);
    });

    it('rejects with connect_error for an invalid token signature', async () => {
      const client = connectClient(server.url, 'not.a.valid.jwt');
      openClients.push(client);
      const err = await waitForConnectError(client);
      expect(err.message).toBe('Unauthorized');
      expect(client.connected).toBe(false);
    });

    it('rejects with connect_error for an expired JWT', async () => {
      const { user } = await registerUser();
      const expired = signTestToken({ sub: user.id, email: user.email }, { expiresIn: '-1s' });
      const client = connectClient(server.url, expired);
      openClients.push(client);
      const err = await waitForConnectError(client);
      expect(err.message).toBe('Unauthorized');
      expect(client.connected).toBe(false);
    });

    it('attaches the authenticated identity to socket.data (self-targeted presence proves userId)', async () => {
      const { user } = await registerUser();
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));
      // The first heartbeat triggers an offline->online transition. The server
      // broadcasts to the subject's own `user:<id>` room, so receiving our own
      // update proves `socket.data.userId` was populated from the JWT.
      const updateP = waitForEvent(client, SOCKET_EVENTS.PRESENCE_UPDATE);
      client.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
      const [update] = await updateP;
      expect(update.userId).toBe(user.id);
      expect(update.state).toBe('online');
    });
  });

  describe('channel:join handler', () => {
    it('joins the channel room and acks true for a public channel', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));

      const ok = await emitChannelJoin(client, channel.id);
      expect(ok).toBe(true);

      const sockets = await server.io.in(`channel:${channel.id}`).fetchSockets();
      expect(sockets).toHaveLength(1);
    });

    it('acks false when joining a private channel as a non-member', async () => {
      const { token: ownerToken } = await registerUser();
      const privateChannel = await createTestChannel({ token: ownerToken, isPrivate: true });

      const { user: outsider } = await registerUser();
      const client = await connectAndTrack(
        signTestToken({ sub: outsider.id, email: outsider.email }),
      );

      const ok = await emitChannelJoin(client, privateChannel.id);
      expect(ok).toBe(false);

      const sockets = await server.io.in(`channel:${privateChannel.id}`).fetchSockets();
      expect(sockets).toHaveLength(0);
    });

    it('acks false for an unknown channel id', async () => {
      const { user } = await registerUser();
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));

      const ok = await emitChannelJoin(client, 'clnonexistent0000000000000');
      expect(ok).toBe(false);
    });
  });

  describe('channel:leave handler', () => {
    it('removes the socket from the channel room', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));

      expect(await emitChannelJoin(client, channel.id)).toBe(true);
      expect(await emitChannelLeave(client, channel.id)).toBe(true);

      const sockets = await server.io.in(`channel:${channel.id}`).fetchSockets();
      expect(sockets).toHaveLength(0);
    });
  });

  describe('message:send handler — channel', () => {
    it('acks the sender with the persisted message and broadcasts message:new to the room', async () => {
      const { token, user: sender } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const senderClient = await connectAndTrack(
        signTestToken({ sub: sender.id, email: sender.email }),
      );
      expect(await emitChannelJoin(senderClient, channel.id)).toBe(true);

      const { user: receiver } = await registerUser();
      const receiverClient = await connectAndTrack(
        signTestToken({ sub: receiver.id, email: receiver.email }),
      );
      // A public channel join also creates durable membership for the receiver.
      expect(await emitChannelJoin(receiverClient, channel.id)).toBe(true);

      const receivedP = waitForEvent(receiverClient, SOCKET_EVENTS.MESSAGE_NEW);
      const ack = await emitMessageSend(senderClient, {
        content: 'hello world',
        channelId: channel.id,
      });

      expect(ack).toMatchObject({ content: 'hello world', channelId: channel.id });

      const [received] = await receivedP;
      expect(received).toMatchObject({ content: 'hello world', channelId: channel.id });
      expect(received.author).toMatchObject({ id: sender.id });
    });

    it('Gate 9: delivers a channel message to a subscriber in under 500ms', async () => {
      const { token, user: sender } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const senderClient = await connectAndTrack(
        signTestToken({ sub: sender.id, email: sender.email }),
      );
      expect(await emitChannelJoin(senderClient, channel.id)).toBe(true);

      const { user: receiver } = await registerUser();
      const receiverClient = await connectAndTrack(
        signTestToken({ sub: receiver.id, email: receiver.email }),
      );
      expect(await emitChannelJoin(receiverClient, channel.id)).toBe(true);

      const start = Date.now();
      const receivedP = waitForEvent(receiverClient, SOCKET_EVENTS.MESSAGE_NEW);
      senderClient.emit(
        SOCKET_EVENTS.MESSAGE_SEND,
        { content: 'fast', channelId: channel.id },
        noopAck,
      );
      await receivedP;
      expect(Date.now() - start).toBeLessThan(500);
    });

    it('acks with an error envelope when the sender is not a member of a private channel', async () => {
      const { token: ownerToken } = await registerUser();
      const privateChannel = await createTestChannel({ token: ownerToken, isPrivate: true });

      const { user: outsider } = await registerUser();
      const client = await connectAndTrack(
        signTestToken({ sub: outsider.id, email: outsider.email }),
      );

      const ack = await emitMessageSend(client, {
        content: 'sneaky',
        channelId: privateChannel.id,
      });
      // The ack is the error envelope, not a persisted MessageWithAuthor.
      expect('error' in ack).toBe(true);
      if ('error' in ack) {
        expect(typeof ack.error).toBe('string');
        expect(ack.error.length).toBeGreaterThan(0);
      }
    });
  });

  describe('message:send handler — DM', () => {
    it('broadcasts message:new to all DM participants', async () => {
      const { token: aliceToken, user: alice } = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: aliceToken, targetUserId: bob.id });

      const aliceClient = await connectAndTrack(
        signTestToken({ sub: alice.id, email: alice.email }),
      );
      const bobClient = await connectAndTrack(signTestToken({ sub: bob.id, email: bob.email }));

      // Both participants auto-join `dm:<id>` on connection via an awaited DB
      // lookup; wait until both sockets are present before sending.
      await waitForRoomMembership(server.io, `dm:${dm.id}`, 2);

      const receivedP = waitForEvent(bobClient, SOCKET_EVENTS.MESSAGE_NEW);
      aliceClient.emit(SOCKET_EVENTS.MESSAGE_SEND, { content: 'hi bob', dmId: dm.id }, noopAck);

      const [received] = await receivedP;
      expect(received).toMatchObject({ content: 'hi bob', dmId: dm.id });
      expect(received.author).toMatchObject({ id: alice.id });
    });
  });

  describe('message:send handler — thread (dual broadcast)', () => {
    it('broadcasts a thread reply (parentId set) to the parent channel room subscribers', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parent = await prismaTest.message.create({
        data: { content: 'parent message', authorId: user.id, channelId: channel.id },
      });

      const senderClient = await connectAndTrack(
        signTestToken({ sub: user.id, email: user.email }),
      );
      expect(await emitChannelJoin(senderClient, channel.id)).toBe(true);

      const { user: observer } = await registerUser();
      const observerClient = await connectAndTrack(
        signTestToken({ sub: observer.id, email: observer.email }),
      );
      expect(await emitChannelJoin(observerClient, channel.id)).toBe(true);

      // The handler emits MESSAGE_NEW to BOTH `thread:<parentId>` AND the parent
      // container room (here the channel). The channel observer verifies the
      // parent-room half of the dual broadcast.
      const receivedP = waitForEvent(observerClient, SOCKET_EVENTS.MESSAGE_NEW);
      senderClient.emit(
        SOCKET_EVENTS.MESSAGE_SEND,
        { content: 'threaded reply', channelId: channel.id, parentId: parent.id },
        noopAck,
      );

      const [received] = await receivedP;
      expect(received).toMatchObject({
        content: 'threaded reply',
        channelId: channel.id,
        parentId: parent.id,
      });
    });
  });

  describe('reaction:add / reaction:remove handlers (asymmetric payloads)', () => {
    it('emits reaction:added with a full ReactionSummary to the message room', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const message = await prismaTest.message.create({
        data: { content: 'react to me', authorId: user.id, channelId: channel.id },
      });

      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));
      expect(await emitChannelJoin(client, channel.id)).toBe(true);

      const receivedP = waitForEvent(client, SOCKET_EVENTS.REACTION_ADDED);
      client.emit(SOCKET_EVENTS.REACTION_ADD, { messageId: message.id, emoji: '👍' });

      const [payload] = await receivedP;
      expect(payload.messageId).toBe(message.id);
      const reaction: ReactionSummary = payload.reaction;
      expect(reaction.emoji).toBe('👍');
      expect(reaction.count).toBe(1);
      expect(reaction.userIds).toContain(user.id);
    });

    it('emits reaction:removed as a { messageId, emoji, userId } tuple without summary fields', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const message = await prismaTest.message.create({
        data: { content: 'react to me', authorId: user.id, channelId: channel.id },
      });
      await prismaTest.messageReaction.create({
        data: { messageId: message.id, userId: user.id, emoji: '👍' },
      });

      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));
      expect(await emitChannelJoin(client, channel.id)).toBe(true);

      const receivedP = waitForEvent(client, SOCKET_EVENTS.REACTION_REMOVED);
      client.emit(SOCKET_EVENTS.REACTION_REMOVE, { messageId: message.id, emoji: '👍' });

      const [payload] = await receivedP;
      expect(payload).toMatchObject({ messageId: message.id, emoji: '👍', userId: user.id });
      // The removal payload is a lean tuple — it carries NONE of the
      // ReactionSummary fields that reaction:added carries.
      expect(payload).not.toHaveProperty('reaction');
      expect(payload).not.toHaveProperty('count');
      expect(payload).not.toHaveProperty('userIds');
    });
  });

  describe('presence:heartbeat handler (transition-only broadcast)', () => {
    it('broadcasts presence:update on the offline->online transition (first heartbeat)', async () => {
      const { user } = await registerUser();
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));

      const updateP = waitForEvent(client, SOCKET_EVENTS.PRESENCE_UPDATE);
      client.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
      const [update] = await updateP;
      expect(update).toMatchObject({ userId: user.id, state: 'online' });
    });

    it('does NOT broadcast presence:update on a repeated same-state heartbeat', async () => {
      const { user } = await registerUser();
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));

      // First heartbeat establishes online (offline->online transition).
      const firstP = waitForEvent(client, SOCKET_EVENTS.PRESENCE_UPDATE);
      client.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
      await firstP;

      // Second heartbeat is online->online: the transition gate stays closed.
      let received = false;
      client.once(SOCKET_EVENTS.PRESENCE_UPDATE, () => {
        received = true;
      });
      client.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(received).toBe(false);
    });

    it('Gate 9: presence transition propagates to a co-member observer in under 5s', async () => {
      const { token: actorToken, user: actor } = await registerUser();
      const channel = await createTestChannel({ token: actorToken, isPrivate: false });
      const { user: observer } = await registerUser();

      const observerClient = await connectAndTrack(
        signTestToken({ sub: observer.id, email: observer.email }),
      );
      // Observer joins the shared channel so it sits in the actor's broadcast
      // audience (presence is targeted to the subject's co-member rooms).
      expect(await emitChannelJoin(observerClient, channel.id)).toBe(true);

      const actorClient = await connectAndTrack(
        signTestToken({ sub: actor.id, email: actor.email }),
      );

      const start = Date.now();
      const updateP = waitForEvent(observerClient, SOCKET_EVENTS.PRESENCE_UPDATE, 5500);
      actorClient.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
      const [update] = await updateP;
      expect(update).toMatchObject({ userId: actor.id, state: 'online' });
      expect(Date.now() - start).toBeLessThan(5000);
    });
  });

  describe('typing:start / typing:stop handlers', () => {
    it('broadcasts typing:start to other channel members (never echoes to the typist)', async () => {
      const { token, user: typer } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const typerClient = await connectAndTrack(
        signTestToken({ sub: typer.id, email: typer.email }),
      );
      expect(await emitChannelJoin(typerClient, channel.id)).toBe(true);

      const { user: observer } = await registerUser();
      const observerClient = await connectAndTrack(
        signTestToken({ sub: observer.id, email: observer.email }),
      );
      expect(await emitChannelJoin(observerClient, channel.id)).toBe(true);

      const receivedP = waitForEvent(observerClient, SOCKET_EVENTS.TYPING_START);
      typerClient.emit(SOCKET_EVENTS.TYPING_START, { channelId: channel.id });

      const [event] = await receivedP;
      expect(event).toMatchObject({ userId: typer.id, channelId: channel.id });
    });

    it('broadcasts typing:stop to other channel members', async () => {
      const { token, user: typer } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });

      const typerClient = await connectAndTrack(
        signTestToken({ sub: typer.id, email: typer.email }),
      );
      expect(await emitChannelJoin(typerClient, channel.id)).toBe(true);

      const { user: observer } = await registerUser();
      const observerClient = await connectAndTrack(
        signTestToken({ sub: observer.id, email: observer.email }),
      );
      expect(await emitChannelJoin(observerClient, channel.id)).toBe(true);

      const receivedP = waitForEvent(observerClient, SOCKET_EVENTS.TYPING_STOP);
      typerClient.emit(SOCKET_EVENTS.TYPING_STOP, { channelId: channel.id });

      const [event] = await receivedP;
      expect(event).toMatchObject({ userId: typer.id, channelId: channel.id });
    });
  });

  describe('disconnect — multi-tab presence safety', () => {
    it('does NOT broadcast offline when one of several tabs of the same user disconnects', async () => {
      const { user } = await registerUser();
      const jwt = signTestToken({ sub: user.id, email: user.email });

      const tabA = await connectAndTrack(jwt);
      const tabB = await connectAndTrack(jwt);

      // Establish online; both tabs share the `user:<id>` room and see it.
      const onlineP = waitForEvent(tabB, SOCKET_EVENTS.PRESENCE_UPDATE);
      tabA.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
      const [online] = await onlineP;
      expect(online).toMatchObject({ userId: user.id, state: 'online' });

      // Disconnect tab A; tab B remains, so the user is still online -> silence.
      let sawOffline = false;
      tabB.once(SOCKET_EVENTS.PRESENCE_UPDATE, (update: PresenceUpdate) => {
        if (update.state === 'offline') {
          sawOffline = true;
        }
      });
      tabA.disconnect();
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      expect(sawOffline).toBe(false);
    });

    it('broadcasts offline when the LAST tab of the user disconnects', async () => {
      const { token: actorToken, user: actor } = await registerUser();
      const channel = await createTestChannel({ token: actorToken, isPrivate: false });
      const { user: observer } = await registerUser();

      const observerClient = await connectAndTrack(
        signTestToken({ sub: observer.id, email: observer.email }),
      );
      // Observer shares the actor's channel so it receives the actor's presence.
      expect(await emitChannelJoin(observerClient, channel.id)).toBe(true);

      const actorClient = await connectAndTrack(
        signTestToken({ sub: actor.id, email: actor.email }),
      );

      // Precondition: actor goes online and the observer sees it.
      const onlineP = waitForEvent(observerClient, SOCKET_EVENTS.PRESENCE_UPDATE, 5500);
      actorClient.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
      const [online] = await onlineP;
      expect(online).toMatchObject({ userId: actor.id, state: 'online' });

      // Disconnect the actor's only tab -> offline broadcast to the same audience.
      const offlineP = waitForEvent(observerClient, SOCKET_EVENTS.PRESENCE_UPDATE, 6000);
      actorClient.disconnect();
      const [offline] = await offlineP;
      expect(offline).toMatchObject({ userId: actor.id, state: 'offline' });
    });
  });

  describe('error envelope', () => {
    it('emits an error event to the sender on a forbidden message:send', async () => {
      const { token: ownerToken } = await registerUser();
      const privateChannel = await createTestChannel({ token: ownerToken, isPrivate: true });

      const { user: outsider } = await registerUser();
      const client = await connectAndTrack(
        signTestToken({ sub: outsider.id, email: outsider.email }),
      );

      const errorP = waitForEvent(client, SOCKET_EVENTS.ERROR);
      client.emit(
        SOCKET_EVENTS.MESSAGE_SEND,
        { content: 'sneaky', channelId: privateChannel.id },
        noopAck,
      );

      const [errorPayload] = await errorP;
      expect(typeof errorPayload.code).toBe('string');
      expect(errorPayload.message.length).toBeGreaterThan(0);
    });
  });
});
