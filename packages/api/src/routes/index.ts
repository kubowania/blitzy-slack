/**
 * @app/api — Routes barrel.
 *
 * Composes all resource routers into a single Express Router consumed by
 * app.ts (mounted at /api). The composed mount-paths form the final URL
 * structure:
 *
 *   /api/auth/{register,login,me}
 *   /api/channels[/:id/{join,leave,messages}]
 *   /api/dms[/:id/messages]
 *   /api/files[/:id]
 *   /api/health
 *   /api/messages[/:id/{replies,reactions[,:emoji]}]
 *   /api/presence
 *   /api/search
 *   /api/users
 *
 * This file MUST NOT define route handlers itself — it is a pure composer.
 * Mounting order is alphabetical for readability (paths are exact, not
 * first-match, so order is functionally irrelevant). Rationale and trade-offs
 * for the choices in this file live in /docs/decision-log.md per the
 * Explainability rule (AAP §0.8.3), not in these comments.
 */

import { Router } from 'express';

import { router as authRouter } from './auth.js';
import { router as channelsRouter } from './channels.js';
import { router as dmsRouter } from './dms.js';
import { router as filesRouter } from './files.js';
import { router as healthRouter } from './health.js';
import { router as messagesRouter } from './messages.js';
import { router as presenceRouter } from './presence.js';
import { router as searchRouter } from './search.js';
import { router as usersRouter } from './users.js';

/**
 * Top-level `/api` router. `app.ts` imports this exact symbol via
 * `import { router } from './routes/index.js'` and mounts it with
 * `app.use('/api', router)`, so each sub-path mounted below resolves under
 * `/api` (e.g. `/auth` here → `/api/auth/*`).
 */
export const router: Router = Router();

router.use('/auth', authRouter);
router.use('/channels', channelsRouter);
router.use('/dms', dmsRouter);
router.use('/files', filesRouter);
router.use('/health', healthRouter);
router.use('/messages', messagesRouter);
router.use('/presence', presenceRouter);
router.use('/search', searchRouter);
router.use('/users', usersRouter);
