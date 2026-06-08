/**
 * useAuthenticatedImage — fetches an auth-gated image as an object URL.
 *
 * Uploaded-image previews are served by `GET /api/files/:id`, which requires
 * `Authorization: Bearer <jwt>`. A raw `<img src="/api/files/:id">` request
 * carries no token and is rejected with 401, so the bitmap must be fetched
 * through the authenticated {@link apiClient} and exposed to `<img>` via an
 * object URL (`URL.createObjectURL`).
 *
 * The hook fetches the blob whenever `url` changes, tracks load status, and
 * revokes the previous object URL on change/unmount to avoid leaking blob URLs.
 * An in-flight fetch is aborted on cleanup so rapid re-renders do not race.
 *
 * Design rationale lives in /docs/decision-log.md per the Explainability rule
 * (AAP §0.8.3), not in these comments.
 */
import { useEffect, useState } from 'react';

import { apiClient } from '@/lib/api-client';

/** Load lifecycle of the authenticated image fetch. */
export type AuthenticatedImageStatus = 'loading' | 'loaded' | 'error';

/** Return shape of {@link useAuthenticatedImage}. */
export interface UseAuthenticatedImageResult {
  /** Object URL usable in `<img src>`, or `null` until the blob has loaded. */
  objectUrl: string | null;
  /** Current fetch lifecycle state. */
  status: AuthenticatedImageStatus;
}

/**
 * Fetches the image at `url` (a relative API path such as `/api/files/:id`)
 * through the authenticated API client and returns a usable object URL.
 *
 * Passing `undefined` (e.g., for a non-image attachment) short-circuits to the
 * `error` state without performing a request, so callers may invoke the hook
 * unconditionally to satisfy the rules-of-hooks.
 *
 * @param url - Relative API path of the image, or `undefined` to skip fetching.
 */
export function useAuthenticatedImage(url: string | undefined): UseAuthenticatedImageResult {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<AuthenticatedImageStatus>('loading');

  useEffect(() => {
    if (url === undefined || url === '') {
      setObjectUrl(null);
      setStatus('error');
      return;
    }

    let cancelled = false;
    let created: string | null = null;
    const controller = new AbortController();

    setObjectUrl(null);
    setStatus('loading');

    const load = async (): Promise<void> => {
      try {
        const blob = await apiClient.getBlob(url, { signal: controller.signal });
        if (cancelled) {
          return;
        }
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
        setStatus('loaded');
      } catch {
        // Aborts (component unmount / url change) and genuine failures both land
        // here; only surface an error when this effect is still active.
        if (!cancelled) {
          setStatus('error');
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
      controller.abort();
      if (created !== null) {
        URL.revokeObjectURL(created);
      }
    };
  }, [url]);

  return { objectUrl, status };
}
