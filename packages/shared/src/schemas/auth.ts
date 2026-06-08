import { z } from 'zod';

import {
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DISPLAY_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
} from '../constants/limits.js';

/**
 * Validates the request body for `POST /api/auth/register`.
 *
 * Consumed by the API via the `validate(registerSchema)` middleware in
 * `packages/api/src/middleware/validate.ts` AND by the web client via
 * `zodResolver(registerSchema)` on the registration form in
 * `packages/web/src/pages/Register.tsx`.
 *
 * The shape mirrors AAP §0.1.1 (email + password registration). The
 * displayName floor of MIN_DISPLAY_NAME_LENGTH (1) and ceiling of
 * MAX_DISPLAY_NAME_LENGTH (80) match Slack's display-name conventions.
 *
 * `.strict()` rejects unknown keys to prevent prototype-pollution / over-
 * posting attacks; rationale recorded in /docs/decision-log.md.
 */
export const registerSchema = z
  .object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .min(1, 'Email is required')
      .email('Enter a valid email address'),
    password: z
      .string({ required_error: 'Password is required' })
      .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
    displayName: z
      .string({ required_error: 'Display name is required' })
      .trim()
      .min(MIN_DISPLAY_NAME_LENGTH, 'Display name is required')
      .max(MAX_DISPLAY_NAME_LENGTH, `Display name must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated registration payload.
 */
export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Validates the request body for `POST /api/auth/login`.
 *
 * Consumed by the API via the `validate(loginSchema)` middleware AND by
 * the web client via `zodResolver(loginSchema)` on the login form.
 *
 * Unlike `registerSchema`, the password is only required to be non-empty
 * (`.min(1)`) — the registration-time length floor is NOT re-enforced
 * here so that legacy users who registered before the floor was raised
 * can still authenticate. Rationale recorded in /docs/decision-log.md.
 *
 * `.strict()` rejects unknown keys.
 */
export const loginSchema = z
  .object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .min(1, 'Email is required')
      .email('Enter a valid email address'),
    password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required'),
  })
  .strict();

/**
 * Inferred TypeScript type for the validated login payload.
 */
export type LoginInput = z.infer<typeof loginSchema>;
