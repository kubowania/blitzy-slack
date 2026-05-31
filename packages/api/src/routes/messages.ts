/**
 * @app/api — Message + Reaction routes (AUTH REQUIRED).
 *
 * POST   /api/messages                         — send message (channel / DM / thread reply)
 * GET    /api/messages/:id/replies             — list thread replies (oldest-first)
 * POST   /api/messages/:id/reactions           — add an emoji reaction (idempotent)
 * DELETE /api/messages/:id/reactions/:emoji    — remove an emoji reaction (idempotent)
 * DELETE /api/messages/:id/reactions?emoji=…   — remove via query param (same operation)
 *
 * This file is the HTTP write path for the real-time messaging surface and the
 * primary producer of the MESSAGE_NEW, REACTION_ADDED, and REACTION_REMOVED
 * Socket.io broadcasts (AAP §0.8.1 Rule 2). Every emission occurs ONLY after the
 * service call succeeds; service exceptions bubble to the centralized error
 * handler (Express 5 forwards async rejections), so no handler uses try/catch.
 *
 * Real-time broadcast contract (mirrors sockets/handlers/message.handler.ts and
 * reaction.handler.ts so REST- and socket-originated events share one shape):
 *   MESSAGE_NEW (payload: MessageWithAuthor)
 *     - thread reply (parentId !== null) → DUAL broadcast: threadRoom + the
 *       parent's container room (channelRoom OR dmRoom), so the channel/DM
 *       timeline's reply-count badge updates alongside the open thread panel
 *     - top-level channel message → channelRoom only
 *     - top-level DM message      → dmRoom only
 *   REACTION_ADDED (payload: { messageId, reaction: ReactionSummary })
 *     - SINGLE room resolved by roomForMessage(message); carries the FULL
 *       summary so subscribers re-render the chip group atomically
 *   REACTION_REMOVED (payload: { messageId, emoji, userId })
 *     - SINGLE room resolved by roomForMessage(message); carries the (emoji,
 *       userId) TUPLE (NOT a summary) so subscribers decrement locally
 *
 * The Socket.io server is read with `req.app.get('io')` (set once by the
 * index.ts bootstrap via `app.set('io', io)`) and narrowed through the typed
 * AppServer alias so every emit is checked against ServerToClientEvents.
 *
 * Validation (AAP §0.8.2 Gate 12) is enforced by the `validate` middleware
 * against the shared `sendMessageSchema` and the inline param/body schemas
 * below. Observability (Gate 10) is the request-scoped Pino child logger
 * (`req.log`). Rationale and trade-offs for the choices here live in
 * /docs/decision-log.md per the Explainability rule (AAP §0.8.3), not in these
 * comments.
 */

// Bare type-only import that loads pino-http's `declare module "http"`
// augmentation, which adds `log: pino.Logger` to IncomingMessage (the type the
// Express Request extends) — this is what types `req.log` in the handlers.
import type {} from 'pino-http';

import { Router, type Request, type Response } from 'express';
import type { Server } from 'socket.io';
import { z } from 'zod';

import {
  MESSAGE_NEW,
  REACTION_ADDED,
  REACTION_REMOVED,
} from '@app/shared/constants/events';
import { sendMessageSchema } from '@app/shared/schemas/message';
import type { SendMessageInput } from '@app/shared/schemas/message';
import type { MessageWithAuthor, ReactionSummary, Thread } from '@app/shared/types/message';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@app/shared/types/socket-events';

import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  addReaction,
  createMessage,
  listThreadReplies,
  removeReaction,
} from '../services/messages.service.js';
import { channelRoom, dmRoom, threadRoom } from '../sockets/rooms.js';

/**
 * Fully-typed Socket.io server alias. Narrowing `req.app.get('io')` to this type
 * makes every `io.to(room).emit(event, payload)` checked at compile time against
 * the ServerToClientEvents map (event name AND payload shape).
 */
type AppServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

/** Validates the `:id` path parameter as a Prisma cuid; rejects extra params. */
const messageIdParamsSchema = z.object({ id: z.string().cuid() }).strict();

/**
 * Validates a reaction `{ emoji }` payload. Used for the POST reaction BODY and,
 * because a Zod object schema is request-position agnostic, reused for the
 * query-param DELETE variant's QUERY.
 */
const emojiBodySchema = z.object({ emoji: z.string().min(1).max(64) }).strict();

/** Validates the path params for DELETE /:id/reactions/:emoji (cuid id + emoji). */
const reactionParamsSchema = z
  .object({
    id: z.string().cuid(),
    emoji: z.string().min(1).max(64),
  })
  .strict();

/**
 * Resolves the SINGLE Socket.io room a reaction broadcast targets, from the
 * message's location: a reaction on a thread reply targets the thread room; on a
 * top-level channel/DM message it targets that container's room. Returns `null`
 * only for the schema-impossible case of a message with no container (the
 * caller skips the broadcast in that case).
 */
function roomForMessage(message: MessageWithAuthor): string | null {
  if (message.parentId !== null) {
    return threadRoom(message.parentId);
  }
  if (message.channelId !== null) {
    return channelRoom(message.channelId);
  }
  if (message.dmId !== null) {
    return dmRoom(message.dmId);
  }
  return null;
}

/**
 * Reads the typed Socket.io server from the Express app settings. The index.ts
 * bootstrap registers it via `app.set('io', io)`; the explicit cast narrows the
 * untyped settings getter to the event-typed AppServer.
 */
function getIo(req: Request<unknown>): AppServer {
  return req.app.get('io') as AppServer;
}

/**
 * Shared remove-reaction implementation backing both DELETE variants (path-param
 * `:emoji` and `?emoji=` query). Idempotent at the service layer (a missing
 * reaction is a no-op); broadcasts the REACTION_REMOVED tuple to the message's
 * single room, then returns the updated message.
 */
async function removeReactionAndBroadcast(
  req: Request<unknown>,
  res: Response<MessageWithAuthor>,
  messageId: string,
  emoji: string,
): Promise<void> {
  const userId = req.user!.id;

  const message = await removeReaction({ messageId, userId, emoji });

  const targetRoom = roomForMessage(message);
  if (targetRoom !== null) {
    getIo(req).to(targetRoom).emit(REACTION_REMOVED, {
      messageId: message.id,
      emoji,
      userId,
    });
  }

  req.log.info(
    { component: 'messages.route', event: 'reaction:remove', userId, messageId, emoji },
    'reaction removed',
  );

  res.status(200).json(message);
}

/**
 * Messages router, mounted at `/messages` by the routes barrel so the effective
 * paths are `/api/messages*`. Exported as `router` to match the barrel
 * convention (`import { router as messagesRouter } from './messages.js'`).
 */
export const router: Router = Router();

router.post(
  '/',
  requireAuth,
  validate(sendMessageSchema),
  async (
    req: Request<unknown, MessageWithAuthor, SendMessageInput>,
    res: Response<MessageWithAuthor>,
  ): Promise<void> => {
    const authorId = req.user!.id;

    // The service enforces the channel/DM XOR invariant, access control, thread
    // parentage, and file ownership, then returns the hydrated DTO.
    const message = await createMessage({
      authorId,
      content: req.body.content,
      channelId: req.body.channelId,
      dmId: req.body.dmId,
      parentId: req.body.parentId,
      fileId: req.body.fileId,
    });

    const io = getIo(req);

    if (message.parentId !== null) {
      // Thread reply: DUAL broadcast — thread panel + parent's container room.
      io.to(threadRoom(message.parentId)).emit(MESSAGE_NEW, message);
      if (message.channelId !== null) {
        io.to(channelRoom(message.channelId)).emit(MESSAGE_NEW, message);
      } else if (message.dmId !== null) {
        io.to(dmRoom(message.dmId)).emit(MESSAGE_NEW, message);
      }
    } else if (message.channelId !== null) {
      io.to(channelRoom(message.channelId)).emit(MESSAGE_NEW, message);
    } else if (message.dmId !== null) {
      io.to(dmRoom(message.dmId)).emit(MESSAGE_NEW, message);
    }

    req.log.info(
      {
        component: 'messages.route',
        event: 'send',
        userId: authorId,
        messageId: message.id,
        channelId: message.channelId,
        dmId: message.dmId,
        parentId: message.parentId,
        hasFile: message.file !== null,
      },
      'message sent',
    );

    res.status(201).json(message);
  },
);

router.get(
  '/:id/replies',
  requireAuth,
  validate({ params: messageIdParamsSchema }),
  async (
    req: Request<{ id: string }>,
    res: Response<Thread>,
  ): Promise<void> => {
    const userId = req.user!.id;
    const parentId = req.params.id;

    // The service enforces ACL on the parent's channel/DM and returns the
    // hydrated parent plus replies oldest-first. The response envelope is the
    // shared `Thread` shape ({ parent, replies }) so the web thread panel can
    // render the thread root and its replies from a single request. Thread
    // sizes are bounded in the PoC, so the first page is returned as the reply
    // list (no pagination cursor surfaced here).
    const { parent, messages } = await listThreadReplies({ parentId, userId });

    res.status(200).json({ parent, replies: messages });
  },
);

router.post(
  '/:id/reactions',
  requireAuth,
  validate({ params: messageIdParamsSchema, body: emojiBodySchema }),
  async (
    req: Request<{ id: string }, MessageWithAuthor, { emoji: string }>,
    res: Response<MessageWithAuthor>,
  ): Promise<void> => {
    const userId = req.user!.id;
    const messageId = req.params.id;
    const emoji = req.body.emoji;

    // Idempotent upsert at the service layer; returns the updated message whose
    // reactions[] includes the just-touched emoji.
    const message = await addReaction({ messageId, userId, emoji });

    const reactionSummary: ReactionSummary | undefined = message.reactions.find(
      (r) => r.emoji === emoji,
    );

    if (reactionSummary === undefined) {
      // Defensive: the service guarantees the reaction is present post-add. This
      // branch is unreachable in practice; log and skip the broadcast gracefully.
      req.log.warn(
        { component: 'messages.route', event: 'reaction:add', messageId, userId, emoji },
        'reaction summary missing from updated message',
      );
    } else {
      const targetRoom = roomForMessage(message);
      if (targetRoom !== null) {
        getIo(req).to(targetRoom).emit(REACTION_ADDED, {
          messageId: message.id,
          reaction: reactionSummary,
        });
      }
    }

    req.log.info(
      { component: 'messages.route', event: 'reaction:add', userId, messageId, emoji },
      'reaction added',
    );

    res.status(200).json(message);
  },
);

router.delete(
  '/:id/reactions/:emoji',
  requireAuth,
  validate({ params: reactionParamsSchema }),
  async (
    req: Request<{ id: string; emoji: string }>,
    res: Response<MessageWithAuthor>,
  ): Promise<void> => {
    await removeReactionAndBroadcast(req, res, req.params.id, req.params.emoji);
  },
);

router.delete(
  '/:id/reactions',
  requireAuth,
  validate({ params: messageIdParamsSchema, query: emojiBodySchema }),
  async (
    req: Request<{ id: string }, MessageWithAuthor, unknown, { emoji: string }>,
    res: Response<MessageWithAuthor>,
  ): Promise<void> => {
    await removeReactionAndBroadcast(req, res, req.params.id, req.query.emoji);
  },
);
