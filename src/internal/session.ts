import type { RequestOptions, SunoClient } from '../client.js';
import { SunoError } from '../errors.js';

/**
 * Whether a session is stored, made usable if it is (the JWT minted or
 * refreshed, as any authenticated call would).
 *
 * Only a missing session answers false. A dead one throws, because quietly
 * reading as nobody would hide that the session needs replacing.
 *
 * Asked before a request rather than learned from one: `request()` reports
 * every failure to `onRequest`, and a session that was never there is not an
 * HTTP exchange worth counting as failed.
 */
export async function hasSession(client: SunoClient, signal?: AbortSignal): Promise<boolean> {
  try {
    await client.ensureAuth(signal);
    return true;
  } catch (err) {
    if (err instanceof SunoError && err.code === 'auth_missing') return false;
    throw err;
  }
}

/**
 * A public read that answers more to a signed-in caller.
 *
 * Sent with the session when one is stored, so fields that describe the viewer
 * (`is_following`, `is_download_unlocked`) are about this account. Without one
 * it goes out anonymous instead of failing with `auth_missing`.
 */
export async function requestWithSessionIfAny<T>(
  client: SunoClient,
  options: RequestOptions<T>,
): Promise<T> {
  // A fired signal skips the lookup: request() refuses it first, and reports it.
  const signedIn = options.signal?.aborted === true ? true : await hasSession(client, options.signal);
  return client.request({ ...options, skipAuth: !signedIn });
}
