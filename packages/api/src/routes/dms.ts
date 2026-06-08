/**
 * @app/api — Direct message (DM) routes (AUTH REQUIRED).
 *
 * GET  /api/dms                              — list DMs the user participates in
 * POST /api/dms                              — start or find a 1:1 DM
 * GET  /api/dms/:id/messages?cursor=&limit=  — paginated DM message history
 *
 * Every handler delegates persistence and access control to
 * services/dms.service.ts; this file never touches Prisma, Redis, or
 * Socket.io directly. DM mutations emit NO Socket.io events — the AAP §0.4.5
 * server→client event list has no DM-creation event, and messages sent inside
 * a DM are broadcast by routes/messages.ts (POST /api/messages), not here.
 *
 * Errors thrown by the service layer (ForbiddenError on a self-DM or a
 * non-participant, NotFoundError on an unknown DM/user, ValidationError on a
 * malformed cursor) propagate to the centralized error handler; handlers
 * therefore carry no try/catch. Rationale and trade-offs for the choices in
 * this file live in /docs/decision-log.md per the Explainability rule
 * (AAP §0.8.3), not in these comments.
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation, which adds `log: pino.Logger` to IncomingMessage (the type the
// Express Request extends) — this is what types `req.log` in the POST handler.
import type {} from 'pino-http';

import { Router, type Request, type Response } from 'express';
import type { Server } from 'socket.io';
import { z } from 'zod';

import { startDmSchema } from '@app/shared/schemas/dm';
import type { StartDmInput } from '@app/shared/schemas/dm';
import { scopedMessageBodySchema } from '@app/shared/schemas/message';
import type { ScopedMessageBodyInput } from '@app/shared/schemas/message';
import type { DMWithParticipants } from '@app/shared/types/dm';
import type { MessageWithAuthor } from '@app/shared/types/message';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';
import { MAX_PAGE_SIZE, PAGE_SIZE } from '@app/shared/constants/limits';

import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { listDms, startDm, listDmMessages } from '../services/dms.service.js';
import { createMessage } from '../services/messages.service.js';
import { broadcastCreatedMessage } from '../sockets/message-broadcast.js';
import { dmRoom, userRoom } from '../sockets/rooms.js';

/**
 * Fully-typed Socket.io server alias. Narrowing `req.app.get('io')` to this type
 * keeps the `socketsJoin` call below checked against the shared event contract.
 */
type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Paginated DM message-history payload returned by `GET /:id/messages`: one
 * page of messages (newest-first) plus the opaque cursor for the next (older)
 * page, or `null` when the timeline is exhausted. Structurally identical to
 * the service's `ListDmMessagesResult`, so the service result serializes
 * directly without an adapter.
 */
interface ListDmMessagesResponse {
  messages: MessageWithAuthor[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Validates the `:id` path parameter as a Prisma cuid; rejects extra params. */
const dmIdParamsSchema = z.object({ id: z.string().cuid() }).strict();

/**
 * Validates the message-history query string. `cursor` is the opaque token
 * echoed back from a previous page; `limit` is coerced from its string form and
 * must be a positive integer. Values above `MAX_PAGE_SIZE` are clamped down to
 * `MAX_PAGE_SIZE` server-side (capped, not rejected) per the AAP §0.8.4
 * pagination contract. Both are optional — the first page omits the cursor and
 * falls back to `PAGE_SIZE`.
 */
const dmMessagesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .transform((n) => Math.min(n, MAX_PAGE_SIZE))
      .optional(),
  })
  .strict();

/**
 * Direct-message router, mounted at `/dms` by the routes barrel so the
 * effective paths are `/api/dms*`. Exported as `router` to match the barrel
 * convention (`import { router as dmsRouter } from './dms.js'`).
 */
export const router: Router = Router();

router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response<DMWithParticipants[]>): Promise<void> => {
    const userId = req.user!.id;

    const dms = await listDms(userId);

    res.status(200).json(dms);
  },
);

router.post(
  '/',
  requireAuth,
  validate(startDmSchema),
  async (
    req: Request<unknown, DMWithParticipants, StartDmInput>,
    res: Response<DMWithParticipants>,
  ): Promise<void> => {
    const initiatorId = req.user!.id;
    const otherUserId = req.body.targetUserId;

    // Idempotent at the service layer: an existing 1:1 conversation for the
    // pair is returned, otherwise a new one is created. Self-DMs and unknown
    // targets are rejected inside the service.
    const dm = await startDm({ initiatorId, otherUserId });

    // Subscribe BOTH participants' already-connected sockets to the DM's room so
    // realtime messages flow immediately, even when the DM was just created
    // mid-session (the connect-time auto-join only covers DMs that existed at
    // connect). `io.in(user:<id>).socketsJoin(dm:<id>)` works across the Redis
    // adapter so it reaches sockets on any API instance. Both participant ids
    // are read from the hydrated DTO.
    const io = req.app.get('io') as AppServer | undefined;
    if (io !== undefined) {
      const dmRoomKey = dmRoom(dm.id);
      for (const participant of dm.participants) {
        io.in(userRoom(participant.id)).socketsJoin(dmRoomKey);
      }
    }

    req.log.info(
      { component: 'dms.route', event: 'create', initiatorId, otherUserId, dmId: dm.id },
      'dm started or found',
    );

    res.status(200).json(dm);
  },
);

router.get(
  '/:id/messages',
  requireAuth,
  validate({ params: dmIdParamsSchema, query: dmMessagesQuerySchema }),
  async (
    req: Request<
      { id: string },
      ListDmMessagesResponse,
      unknown,
      { cursor?: string; limit?: number }
    >,
    res: Response<ListDmMessagesResponse>,
  ): Promise<void> => {
    const userId = req.user!.id;
    const dmId = req.params.id;
    const cursor = req.query.cursor;
    const limit = req.query.limit ?? PAGE_SIZE;

    // The service enforces participant access control (ForbiddenError for a
    // non-participant) before paginating the timeline with the shared opaque
    // (createdAt, id) cursor contract.
    const result = await listDmMessages({ dmId, userId, cursor, limit });

    res.status(200).json(result);
  },
);

router.post(
  '/:id/messages',
  requireAuth,
  validate({ params: dmIdParamsSchema, body: scopedMessageBodySchema }),
  async (
    req: Request<{ id: string }, MessageWithAuthor, ScopedMessageBodyInput>,
    res: Response<MessageWithAuthor>,
  ): Promise<void> => {
    const authorId = req.user!.id;
    const dmId = req.params.id;

    // The container is the DM named in the URL path; the body carries only
    // content + optional thread parentId + optional fileId. The service enforces
    // DM participation, thread parentage, and file ownership.
    const message = await createMessage({
      authorId,
      content: req.body.content,
      dmId,
      parentId: req.body.parentId,
      fileId: req.body.fileId,
    });

    // Single producer of message:new (+ message:updated for thread replies),
    // shared with POST /api/messages and the socket message handler.
    const io = req.app.get('io') as AppServer;
    broadcastCreatedMessage(io, message);

    req.log.info(
      {
        component: 'dms.route',
        event: 'message:send',
        userId: authorId,
        dmId,
        messageId: message.id,
        parentId: message.parentId,
        hasFile: message.file !== null,
      },
      'dm message sent',
    );

    res.status(201).json(message);
  },
);
