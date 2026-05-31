import type { ZodType } from 'zod';

import { performLogout } from '@/lib/session';
import { useAuthStore } from '@/stores/auth.store';

/**
 * Base URL for HTTP API calls. Sourced from `VITE_API_URL` at module
 * load and normalized to omit any trailing slash so that path joins
 * produce a single `/` separator.
 */
const BASE_URL: string = import.meta.env.VITE_API_URL.replace(/\/$/, '');

/**
 * Structured error thrown by every `apiClient` method on any non-2xx
 * response or network failure. Callers should `catch` this type and
 * surface `.status` / `.body` to the user (typically via Sonner toast).
 *
 * Network failures (fetch rejections) are normalized to `status === 0`
 * with `body === null` so callers see a uniform shape.
 */
export class ApiError extends Error {
  public readonly status: number;
  public readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Per-call options accepted by every `apiClient` method.
 *
 * - `schema`: optional Zod schema validating the response body. When
 *   provided, the response is parsed via `schema.parse(...)`, so the
 *   returned value is statically typed AND runtime-validated.
 * - `signal`: optional `AbortSignal` for cancellation (e.g., paired
 *   with TanStack Query's per-query signal).
 * - `headers`: optional extra headers merged into the request.
 */
export interface RequestOptions<T> {
  schema?: ZodType<T>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * Constructs the Authorization header from the Zustand auth store.
 * Returns an empty object when no token is set so that unauthenticated
 * endpoints (e.g., `/api/auth/register`, `/api/auth/login`) succeed.
 */
function authHeader(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

/**
 * Joins a base URL and a relative path, tolerating either form of the
 * path (with or without leading slash).
 */
function buildUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_URL}${normalized}`;
}

/**
 * Parses a Response's body as JSON when possible, falling back to text,
 * and finally to `null` if the body is absent or unparsable. Never
 * throws.
 */
async function parseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (response.status === 204 || response.headers.get('content-length') === '0') {
    return null;
  }
  if (contentType.includes('application/json')) {
    try {
      return (await response.json()) as unknown;
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * Extracts a human-readable error message from a parsed error body.
 * The API's error-handler middleware emits `{ error: string, ... }`
 * but the client must also tolerate other shapes.
 */
function extractErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.length > 0) {
    return body;
  }
  if (body !== null && typeof body === 'object' && 'error' in body) {
    const value = body.error;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  if (body !== null && typeof body === 'object' && 'message' in body) {
    const value = body.message;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return fallback;
}

/**
 * Core request function shared by `get`, `post`, `del`, `upload`.
 *
 * Behavior:
 *   1. Builds the final URL via `buildUrl(path)`.
 *   2. Injects the Authorization header when a JWT is present in the
 *      auth store.
 *   3. Merges caller-provided headers AFTER the defaults so callers may
 *      override (e.g., a custom `Accept` for downloads).
 *   4. On a 401 response, runs the shared `performLogout()` teardown
 *      (clears the auth store, disconnects the WebSocket singleton, and
 *      clears the presence map) before throwing, so the UI redirects to
 *      `/login` with no stale socket or presence state.
 *   5. On a non-2xx response, throws `ApiError(message, status, body)`.
 *   6. On a 2xx response with an empty body, returns `undefined as T`.
 *   7. On a 2xx response with a body and a `schema` option, validates
 *      the body via `schema.parse(...)` — ZodError propagates AS-IS.
 *   8. On a fetch rejection (network failure), throws
 *      `ApiError(message, 0, null)`.
 */
async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body: unknown,
  options?: RequestOptions<T>,
): Promise<T> {
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeader(),
    ...(options?.headers ?? {}),
  };

  let payload: BodyInit | undefined;
  if (body === undefined) {
    payload = undefined;
  } else if (isFormData) {
    payload = body;
  } else {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    payload = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path), {
      method,
      headers,
      body: payload,
      signal: options?.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed';
    throw new ApiError(message, 0, null);
  }

  if (response.status === 401) {
    // Session expired or token rejected: run the FULL teardown (clear auth
    // store + disconnect the WebSocket + clear presence) via the shared
    // orchestrator, not just the store logout — otherwise the socket would stay
    // connected on a dead identity. The UI redirects to /login off the cleared
    // auth state.
    performLogout();
    const errBody = await parseBody(response);
    throw new ApiError(extractErrorMessage(errBody, 'Unauthorized'), 401, errBody);
  }

  if (!response.ok) {
    const errBody = await parseBody(response);
    throw new ApiError(
      extractErrorMessage(errBody, `HTTP ${response.status}`),
      response.status,
      errBody,
    );
  }

  const okBody = await parseBody(response);
  if (okBody === null) {
    return undefined as T;
  }

  if (options?.schema !== undefined) {
    return options.schema.parse(okBody);
  }

  return okBody as T;
}

/**
 * Fetches a binary resource (e.g., an uploaded file) as a `Blob` with the
 * Authorization header attached, used by the secure file-download path.
 *
 * Auth-gated routes such as `GET /api/files/:id` require the bearer JWT, which a
 * raw `<img src>` or anchor `href` cannot carry. Callers therefore fetch the
 * bytes here (token attached, same `VITE_API_URL` origin via `buildUrl`) and
 * wrap the result in an object URL (`URL.createObjectURL`) for `<img src>` or a
 * download anchor.
 *
 * Behavior mirrors {@link request}'s auth and failure handling:
 *   - injects the Authorization header when a JWT is present;
 *   - on a 401, runs the shared `performLogout()` teardown before throwing;
 *   - on any non-2xx, throws `ApiError(message, status, body)`;
 *   - on a fetch rejection (network failure / abort), throws
 *     `ApiError(message, 0, null)`.
 */
async function requestBlob(path: string, options?: { signal?: AbortSignal }): Promise<Blob> {
  const headers: Record<string, string> = {
    ...authHeader(),
  };

  let response: Response;
  try {
    response = await fetch(buildUrl(path), {
      method: 'GET',
      headers,
      signal: options?.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network request failed';
    throw new ApiError(message, 0, null);
  }

  if (response.status === 401) {
    performLogout();
    const errBody = await parseBody(response);
    throw new ApiError(extractErrorMessage(errBody, 'Unauthorized'), 401, errBody);
  }

  if (!response.ok) {
    const errBody = await parseBody(response);
    throw new ApiError(
      extractErrorMessage(errBody, `HTTP ${response.status}`),
      response.status,
      errBody,
    );
  }

  return response.blob();
}

/**
 * Typed HTTP client for the Slack-clone REST API.
 *
 * Endpoint surface (per AAP §0.6.1 and the folder spec):
 *   - Auth:     POST /api/auth/register, POST /api/auth/login, GET /api/auth/me
 *   - Channels: GET  /api/channels, POST /api/channels,
 *               GET  /api/channels/:id/messages?cursor=&limit=50,
 *               POST /api/channels/:id/join, POST /api/channels/:id/leave
 *   - Messages: GET  /api/messages/:id/replies,
 *               POST /api/messages/:id/reactions,
 *               DELETE /api/messages/:id/reactions
 *   - DMs:      GET  /api/dms, POST /api/dms, GET /api/dms/:id/messages
 *   - Files:    POST /api/files (multipart), GET /api/files/:id
 *   - Search:   GET  /api/search?q=
 *   - Health:   GET  /api/health
 *
 * Each method is generic over the response type `T`. Pass a Zod schema
 * via `options.schema` to validate the response at runtime and narrow
 * `T` automatically via Zod's inference.
 */
export const apiClient = {
  get<T>(path: string, options?: RequestOptions<T>): Promise<T> {
    return request<T>('GET', path, undefined, options);
  },

  post<T>(path: string, body?: unknown, options?: RequestOptions<T>): Promise<T> {
    return request<T>('POST', path, body, options);
  },

  del<T>(path: string, options?: RequestOptions<T>): Promise<T> {
    return request<T>('DELETE', path, undefined, options);
  },

  upload<T>(path: string, formData: FormData, options?: RequestOptions<T>): Promise<T> {
    return request<T>('POST', path, formData, options);
  },

  /**
   * Fetches a binary resource as a `Blob` with the bearer token attached. Use
   * for auth-gated assets (e.g., `GET /api/files/:id`) that cannot be loaded via
   * an unauthenticated `<img src>` / anchor `href`. Pair with
   * `URL.createObjectURL` to obtain a usable object URL.
   */
  getBlob(path: string, options?: { signal?: AbortSignal }): Promise<Blob> {
    return requestBlob(path, options);
  },
} as const;
