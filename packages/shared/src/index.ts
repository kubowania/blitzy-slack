// =============================================================================
// @app/shared — Public API Barrel
// =============================================================================
// Cross-boundary contracts consumed by @app/api (Express + Socket.io server)
// and @app/web (React + Vite client). This barrel is the package entry point
// declared in package.json `exports["."]`, and mirrors the granular subpath
// import surface (@app/shared/types/*, @app/shared/schemas/*,
// @app/shared/constants/*).
//
// LEAF package: must not import from @app/db, @app/api, or @app/web.
//
// Re-export specifiers carry the `.js` suffix mandated by NodeNext module
// resolution. Decision rationale lives in /docs/decision-log.md (Explainability
// rule) and is intentionally not duplicated here.
// =============================================================================

// ---------------------------------------------------------------------------
// Types (TypeScript DTOs and Socket.io event interfaces)
// ---------------------------------------------------------------------------
export * from './types/user.js';
export * from './types/channel.js';
export * from './types/message.js';
export * from './types/dm.js';
export * from './types/presence.js';
export * from './types/socket-events.js';

// ---------------------------------------------------------------------------
// Schemas (Zod validation schemas + inferred input types)
// ---------------------------------------------------------------------------
export * from './schemas/auth.js';
export * from './schemas/channel.js';
export * from './schemas/message.js';
export * from './schemas/dm.js';

// ---------------------------------------------------------------------------
// Constants (Socket.io event names + numeric limits)
// ---------------------------------------------------------------------------
export * from './constants/events.js';
export * from './constants/limits.js';
