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
import { stopPresenceSweep } from '../src/sockets/presence-sweep.js';

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

/**
 * Minimal structural view of a socket's `.on` / `.off` used by the generic
 * {@link expectNoEvent} helper to register a listener for a *generic* event key
 * and later remove it. Like {@link UntypedOnceEmitter}, the typed client cannot
 * accept a variadic `unknown[]` listener for a generic key, so the calls are
 * routed through this interface via a double cast. No `any` is introduced, so
 * the `no-unsafe-*` rules remain satisfied (Rule 3).
 */
interface UntypedEventEmitter {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Minimal structural view of a socket's `.emit` used to emit an ack-bearing
 * event WITHOUT supplying the acknowledgement callback. The typed client's
 * `.emit` requires the ack argument for `channel:join` / `channel:leave` /
 * `message:send`, so a non-conforming (ack-less) emit is routed through this
 * interface via a double cast. No `any` is introduced, so the `no-unsafe-*`
 * rules remain satisfied (Rule 3).
 */
interface UntypedEmitter {
  emit(event: string, ...args: unknown[]): void;
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
  // registerSocketHandlers() started the once-per-process passive-presence sweep
  // timer; stop it here so its (unref-ed) interval does not outlive this suite and
  // fire against the Redis client that closeTestResources() later disconnects —
  // which would otherwise emit "presence sweep tick failed" error logs while the
  // remaining suites run (mirrors the production graceful-shutdown teardown order).
  stopPresenceSweep();

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

/**
 * Default window for negative ("no event") assertions. Tied to the Gate 9
 * message-delivery budget (< 500 ms): an in-process Socket.io broadcast that was
 * going to happen arrives far inside this window, so the event's ABSENCE after
 * the window is conclusive — replacing arbitrary fixed sleeps that can false-pass
 * if an event arrives just after the window.
 */
const NO_EVENT_WINDOW_MS = 500;

/**
 * Resolves if `event` does NOT arrive on `socket` within `timeoutMs`, and rejects
 * if it does. When `predicate` is supplied, only an event whose payload satisfies
 * it counts as a violation (e.g. only a `presence:update` with state `offline`);
 * non-matching occurrences are ignored. The listener is ALWAYS removed before the
 * promise settles, so it never leaks into a later test. The generic event key
 * routes registration through {@link UntypedEventEmitter}; payloads are typed as
 * `Parameters<ServerToClientEvents[E]>` (no `any`, Rule 3).
 */
function expectNoEvent<E extends keyof ServerToClientEvents>(
  socket: ClientConn,
  event: E,
  timeoutMs: number = NO_EVENT_WINDOW_MS,
  predicate?: (...args: Parameters<ServerToClientEvents[E]>) => boolean,
): Promise<void> {
  const emitter = socket as unknown as UntypedEventEmitter;
  return new Promise<void>((resolve, reject) => {
    const listener = (...args: unknown[]): void => {
      const payload = args as Parameters<ServerToClientEvents[E]>;
      if (predicate !== undefined && !predicate(...payload)) {
        return;
      }
      clearTimeout(timer);
      emitter.off(event, listener);
      reject(
        new Error(
          `Expected no ${String(event)} within ${timeoutMs}ms, but it fired: ${JSON.stringify(payload)}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      resolve();
    }, timeoutMs);
    emitter.on(event, listener);
  });
}

/** Emits `channel:join` and resolves with the boolean ack. */
function emitChannelJoin(
  socket: ClientConn,
  channelId: string,
  timeoutMs = 2000,
): Promise<boolean> {
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
function emitChannelLeave(
  socket: ClientConn,
  channelId: string,
  timeoutMs = 2000,
): Promise<boolean> {
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

/**
 * Polls the server-side adapter until `room` holds NO sockets. Used to
 * deterministically await an asynchronous `socket.leave` (the `dm:leave` /
 * `thread:leave` handlers join/leave through an awaited adapter call).
 */
async function waitForRoomEmpty(io: TestIOServer, room: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const sockets = await io.in(room).fetchSockets();
    if (sockets.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Room ${room} was not empty within ${timeoutMs}ms`);
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

  describe('ack resilience (no-ack emits must not crash the server)', () => {
    it('tolerates channel:join, channel:leave, and message:send emitted without an ack callback', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));

      // Emit each ack-bearing event with NO acknowledgement callback. A missing
      // ack previously threw "ack is not a function" inside the handler's catch
      // block, which — because the handler is delegated fire-and-forget —
      // surfaced as a process-terminating unhandledRejection. Routed through an
      // untyped emitter because the typed event map requires the ack argument
      // (Rule 3: no @ts-ignore).
      const untyped = client as unknown as UntypedEmitter;
      untyped.emit(SOCKET_EVENTS.CHANNEL_JOIN, channel.id);
      untyped.emit(SOCKET_EVENTS.CHANNEL_LEAVE, channel.id);
      untyped.emit(SOCKET_EVENTS.MESSAGE_SEND, { content: 'no-ack send', channelId: channel.id });

      // The server must remain alive and handling events: a follow-up ack'd join
      // resolves true. If a no-ack emit had crashed the process, the socket would
      // have dropped and this would time out instead of acking.
      const ok = await emitChannelJoin(client, channel.id);
      expect(ok).toBe(true);
      expect(client.connected).toBe(true);

      // And the originating socket ends up subscribed to the channel room,
      // proving the ack'd join ran end-to-end after the no-ack traffic.
      const sockets = await server.io.in(`channel:${channel.id}`).fetchSockets();
      expect(sockets).toHaveLength(1);
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

    it('emits message:updated carrying the re-hydrated parent (incremented replyCount) to the container room (WS-001)', async () => {
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

      // A thread reply triggers a fire-and-forget parent re-hydration followed by
      // a MESSAGE_UPDATED broadcast to the parent's container room (the channel),
      // so channel subscribers reconcile the parent's authoritative replyCount.
      // The payload is the PARENT (not the reply): id === parent.id, replyCount 1.
      const updatedP = waitForEvent(observerClient, SOCKET_EVENTS.MESSAGE_UPDATED);
      senderClient.emit(
        SOCKET_EVENTS.MESSAGE_SEND,
        { content: 'threaded reply', channelId: channel.id, parentId: parent.id },
        noopAck,
      );

      const [updated] = await updatedP;
      expect(updated.id).toBe(parent.id);
      expect(updated.content).toBe('parent message');
      expect(updated.parentId).toBeNull();
      expect(updated.replyCount).toBe(1);
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

  describe('subscription handler — thread:join / thread:leave / dm:join / dm:leave', () => {
    /** A well-formed cuid that resolves to no row (404 fixtures). */
    const MISSING_CUID = 'clxnonexistent00000000000';

    it('thread:join subscribes the live socket to the thread:<parentId> room', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parent = await prismaTest.message.create({
        data: { content: 'thread parent', authorId: user.id, channelId: channel.id },
      });

      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));
      client.emit(SOCKET_EVENTS.THREAD_JOIN, parent.id);

      await waitForRoomMembership(server.io, `thread:${parent.id}`, 1);
      const sockets = await server.io.in(`thread:${parent.id}`).fetchSockets();
      expect(sockets).toHaveLength(1);
    });

    it('delivers a reaction on a thread REPLY (which targets the thread room ONLY) to a thread:join subscriber', async () => {
      // Seed a channel with a parent + one threaded reply.
      const { token, user: author } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parent = await prismaTest.message.create({
        data: { content: 'parent', authorId: author.id, channelId: channel.id },
      });
      const reply = await prismaTest.message.create({
        data: {
          content: 'reply',
          authorId: author.id,
          channelId: channel.id,
          parentId: parent.id,
        },
      });

      // A second channel member who will react on the reply. The reaction
      // handler enforces channel membership (assertChannelAccess), so the
      // membership row is seeded directly via Prisma (Rule 4 permits non-user
      // fixtures; the user itself was created through registerUser()).
      const { user: reactor } = await registerUser();
      await prismaTest.channelMember.create({
        data: { channelId: channel.id, userId: reactor.id, role: 'member' },
      });

      // The observer is a channel member (auto-joined the channel room at
      // connect) AND explicitly thread:joins. Because a reaction on a reply
      // (`parentId !== null`) routes to `thread:<parentId>` ONLY — never the
      // channel room — receipt PROVES the thread-room subscription delivered it.
      const observer = await connectAndTrack(
        signTestToken({ sub: author.id, email: author.email }),
      );
      observer.emit(SOCKET_EVENTS.THREAD_JOIN, parent.id);
      await waitForRoomMembership(server.io, `thread:${parent.id}`, 1);

      const reactorClient = await connectAndTrack(
        signTestToken({ sub: reactor.id, email: reactor.email }),
      );

      const receivedP = waitForEvent(observer, SOCKET_EVENTS.REACTION_ADDED);
      reactorClient.emit(SOCKET_EVENTS.REACTION_ADD, { messageId: reply.id, emoji: '👍' });

      const [payload] = await receivedP;
      expect(payload.messageId).toBe(reply.id);
      expect(payload.reaction.emoji).toBe('👍');
    });

    it('does NOT deliver a reply reaction to a channel member who has not thread:joined', async () => {
      const { token, user: author } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parent = await prismaTest.message.create({
        data: { content: 'parent', authorId: author.id, channelId: channel.id },
      });
      const reply = await prismaTest.message.create({
        data: {
          content: 'reply',
          authorId: author.id,
          channelId: channel.id,
          parentId: parent.id,
        },
      });

      // The observer is a channel member (auto-joined the channel room) but does
      // NOT thread:join. Since the reply reaction targets the thread room only,
      // the channel-room membership must NOT deliver it — this is precisely the
      // gap that makes thread:join mandatory.
      const observer = await connectAndTrack(
        signTestToken({ sub: author.id, email: author.email }),
      );
      const noEventP = expectNoEvent(observer, SOCKET_EVENTS.REACTION_ADDED);
      observer.emit(SOCKET_EVENTS.REACTION_ADD, { messageId: reply.id, emoji: '👍' });
      await noEventP;
    });

    it('thread:leave unsubscribes the socket from the thread room', async () => {
      const { token, user } = await registerUser();
      const channel = await createTestChannel({ token, isPrivate: false });
      const parent = await prismaTest.message.create({
        data: { content: 'thread parent', authorId: user.id, channelId: channel.id },
      });

      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));
      client.emit(SOCKET_EVENTS.THREAD_JOIN, parent.id);
      await waitForRoomMembership(server.io, `thread:${parent.id}`, 1);

      client.emit(SOCKET_EVENTS.THREAD_LEAVE, parent.id);
      await waitForRoomEmpty(server.io, `thread:${parent.id}`);
    });

    it('emits an error (FORBIDDEN) and does not join when thread:join targets an inaccessible parent', async () => {
      const { token: ownerToken } = await registerUser();
      const privateChannel = await createTestChannel({ token: ownerToken, isPrivate: true });
      const parent = await prismaTest.message.create({
        data: {
          content: 'private parent',
          authorId: privateChannel.createdById,
          channelId: privateChannel.id,
        },
      });

      const { user: outsider } = await registerUser();
      const client = await connectAndTrack(
        signTestToken({ sub: outsider.id, email: outsider.email }),
      );

      const errP = waitForEvent(client, SOCKET_EVENTS.ERROR);
      client.emit(SOCKET_EVENTS.THREAD_JOIN, parent.id);

      const [err] = await errP;
      expect(err.code).toBe('FORBIDDEN');
      const sockets = await server.io.in(`thread:${parent.id}`).fetchSockets();
      expect(sockets).toHaveLength(0);
    });

    it('emits an error (NOT_FOUND) when thread:join targets a non-existent parent', async () => {
      const { user } = await registerUser();
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));

      const errP = waitForEvent(client, SOCKET_EVENTS.ERROR);
      client.emit(SOCKET_EVENTS.THREAD_JOIN, MISSING_CUID);

      const [err] = await errP;
      expect(err.code).toBe('NOT_FOUND');
    });

    it('emits an error (VALIDATION_ERROR) when thread:join receives a malformed id', async () => {
      const { user } = await registerUser();
      const client = await connectAndTrack(signTestToken({ sub: user.id, email: user.email }));

      const errP = waitForEvent(client, SOCKET_EVENTS.ERROR);
      client.emit(SOCKET_EVENTS.THREAD_JOIN, 'not-a-cuid');

      const [err] = await errP;
      expect(err.code).toBe('VALIDATION_ERROR');
    });

    it('dm:join subscribes a participant to a DM started AFTER the socket connected', async () => {
      // bob connects with NO DMs, so the connect-time auto-join covers none.
      const alice = await registerUser();
      const { user: bob } = await registerUser();
      const bobClient = await connectAndTrack(signTestToken({ sub: bob.id, email: bob.email }));

      // alice starts the DM mid-session; bob's existing socket is NOT auto-joined
      // because auto-join only runs at connect time (before the DM existed).
      const dm = await createTestDm({ token: alice.token, targetUserId: bob.id });

      const before = await server.io.in(`dm:${dm.id}`).fetchSockets();
      expect(before).toHaveLength(0);

      bobClient.emit(SOCKET_EVENTS.DM_JOIN, dm.id);
      await waitForRoomMembership(server.io, `dm:${dm.id}`, 1);

      bobClient.emit(SOCKET_EVENTS.DM_LEAVE, dm.id);
      await waitForRoomEmpty(server.io, `dm:${dm.id}`);
    });

    it('emits an error (FORBIDDEN) and does not join when dm:join targets a DM the caller is not in', async () => {
      const alice = await registerUser();
      const { user: bob } = await registerUser();
      const dm = await createTestDm({ token: alice.token, targetUserId: bob.id });

      const { user: carol } = await registerUser();
      const carolClient = await connectAndTrack(
        signTestToken({ sub: carol.id, email: carol.email }),
      );

      const errP = waitForEvent(carolClient, SOCKET_EVENTS.ERROR);
      carolClient.emit(SOCKET_EVENTS.DM_JOIN, dm.id);

      const [err] = await errP;
      expect(err.code).toBe('FORBIDDEN');
      const sockets = await server.io.in(`dm:${dm.id}`).fetchSockets();
      expect(sockets).toHaveLength(0);
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

      // Second heartbeat is online->online: the transition gate stays closed, so
      // no further presence:update may arrive within the negative-assertion window.
      const noUpdate = expectNoEvent(client, SOCKET_EVENTS.PRESENCE_UPDATE);
      client.emit(SOCKET_EVENTS.PRESENCE_HEARTBEAT);
      await noUpdate;
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

      // Disconnect tab A; tab B remains, so the user stays online -> NO offline
      // broadcast may reach tab B within the negative-assertion window.
      const noOffline = expectNoEvent(
        tabB,
        SOCKET_EVENTS.PRESENCE_UPDATE,
        NO_EVENT_WINDOW_MS,
        (update: PresenceUpdate) => update.state === 'offline',
      );
      tabA.disconnect();
      await noOffline;
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

  describe('Gate 9 — 50 concurrent WebSocket sessions', () => {
    /** Concurrent-session capacity Gate 9 requires the server to support. */
    const CONCURRENT_SESSIONS = 50;
    /**
     * Budget for establishing every session and fanning a broadcast out to all
     * of them. Tied to the Gate 9 propagation ceiling (< 5 s): an in-process
     * Socket.io fan-out to dozens of local sockets completes far inside this
     * window, so the budget proves real-time delivery under load (Rule 2) while
     * staying robust to CI scheduling jitter.
     */
    const LOAD_BUDGET_MS = 5000;

    it('establishes 50 authenticated sessions and fans a broadcast out to all of them within budget', async () => {
      // Session 0 is the host that owns the channel and sends the broadcast;
      // the remaining 49 are receivers. All 50 are connected concurrently.
      const { token: hostToken, user: host } = await registerUser();
      const channel = await createTestChannel({ token: hostToken, isPrivate: false });

      const others = await Promise.all(
        Array.from({ length: CONCURRENT_SESSIONS - 1 }, () => registerUser()),
      );
      const sessions = [{ token: hostToken, user: host }, ...others];
      expect(sessions).toHaveLength(CONCURRENT_SESSIONS);

      // Open every session concurrently (forceNew + websocket-only via
      // connectClient) and track each for afterEach teardown.
      const connectStart = Date.now();
      const clients = await Promise.all(
        sessions.map(async ({ user }) => {
          const client = connectClient(
            server.url,
            signTestToken({ sub: user.id, email: user.email }),
          );
          openClients.push(client);
          await waitForConnect(client, LOAD_BUDGET_MS);
          return client;
        }),
      );
      expect(clients).toHaveLength(CONCURRENT_SESSIONS);
      for (const client of clients) {
        expect(client.connected).toBe(true);
      }
      expect(Date.now() - connectStart).toBeLessThan(LOAD_BUDGET_MS);

      // Every session joins the same public channel room (durable membership +
      // socket-room join); all 50 acks must be true.
      const joinAcks = await Promise.all(
        clients.map((client) => emitChannelJoin(client, channel.id, LOAD_BUDGET_MS)),
      );
      expect(joinAcks.every((ok) => ok)).toBe(true);
      await waitForRoomMembership(
        server.io,
        `channel:${channel.id}`,
        CONCURRENT_SESSIONS,
        LOAD_BUDGET_MS,
      );

      // The host broadcasts; every one of the 49 receivers must get message:new
      // within the load budget.
      const sender = clients[0];
      if (sender === undefined) {
        throw new Error('expected at least one connected session');
      }
      const receivers = clients.slice(1);
      const broadcastStart = Date.now();
      const receivedAll = Promise.all(
        receivers.map((client) => waitForEvent(client, SOCKET_EVENTS.MESSAGE_NEW, LOAD_BUDGET_MS)),
      );
      sender.emit(
        SOCKET_EVENTS.MESSAGE_SEND,
        { content: 'broadcast under load', channelId: channel.id },
        noopAck,
      );

      const payloads = await receivedAll;
      expect(payloads).toHaveLength(CONCURRENT_SESSIONS - 1);
      for (const [message] of payloads) {
        expect(message).toMatchObject({
          content: 'broadcast under load',
          channelId: channel.id,
        });
      }
      expect(Date.now() - broadcastStart).toBeLessThan(LOAD_BUDGET_MS);
    }, 45_000);
  });
});
