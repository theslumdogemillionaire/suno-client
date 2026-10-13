/**
 * Suno's sanctioned download path, and the meter in front of it.
 *
 * As of 2026-09-10 this is the ONLY way to get playable bytes for a clip.
 * `audio_url` returns 403 on everything, and `media_urls` — which looks like
 * the replacement, right down to answering 200 with `audio/mp4` — is encrypted.
 * See docs/STATUS.md.
 *
 * The shape of the thing that matters: reading is free, unlocking is not.
 *
 *   GET  /api/download/clip/{id}?format=mp3   free, always, on any clip
 *   POST /api/download/authorize              spends one metered download
 *
 * A GET on a locked clip answers `{ok: false, reason: "not_authorized"}` and
 * deducts nothing — verified against `billing/info.download_usage` before and
 * after — so a client can look before it leaps, and a caller iterating a
 * library can detect-and-skip without touching the quota. Which matters,
 * because the quota is small: 20 per period on the Pro plan measured here.
 *
 * `authorizeDownload` exists and is exported, and NOTHING in this library calls
 * it. Spending a metered download has to be a decision someone made on purpose,
 * not a fallback that a retry loop can reach on its own.
 */
import { z } from 'zod';

import { pathSegment, type SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { sleep } from '../internal/retry.js';

export const DOWNLOAD_CLIP_PATH = '/api/download/clip';
export const DOWNLOAD_AUTHORIZE_PATH = '/api/download/authorize';

/**
 * Formats the endpoint accepts.
 *
 * Probed one by one: `mp3` comes back ready on an unlocked clip; `wav`, `m4a`
 * and `mp4` answer `{status: "processing"}` and have to be polled; `flac`,
 * `ogg` and `opus` are refused as `invalid_format`.
 */
export const DOWNLOAD_FORMATS = ['mp3', 'wav', 'm4a', 'mp4'] as const;
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number];

/**
 * Note the HTTP status: every one of these arrives as 200, refusals included.
 * `ok` is the field that decides, never the transport.
 */
export const DownloadTicketSchema = z
  .object({
    ok: z.boolean(),
    status: z.string().nullish(),
    download_url: z.string().nullish(),
    reason: z.string().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

export type DownloadTicket = z.infer<typeof DownloadTicketSchema>;

export const AuthorizeResultSchema = z
  .object({
    ok: z.boolean(),
    already_unlocked: z.boolean().nullish(),
    credit_deducted: z.boolean().nullish(),
    reason: z.string().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

export type AuthorizeResult = z.infer<typeof AuthorizeResultSchema>;

/** One look at the endpoint. Free on any clip, unlocked or not. */
export function downloadTicket(
  client: SunoClient,
  clipId: string,
  format: DownloadFormat = 'mp3',
  signal?: AbortSignal,
): Promise<DownloadTicket> {
  return client.request({
    method: 'GET',
    path: `${DOWNLOAD_CLIP_PATH}/${pathSegment(clipId)}`,
    query: { format },
    schema: DownloadTicketSchema,
    endpointKey: 'download.clip',
    ...(signal ? { signal } : {}),
  });
}

export interface ResolveOptions {
  format?: DownloadFormat;
  /** How long to wait on a `processing` render. Zero disables polling. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A signed URL for a clip, or an error that says which of the two problems it
 * is.
 *
 * The distinction is the whole point. "Locked" is a decision the account owner
 * has to make and pay for; "still rendering" resolves by waiting. Reporting
 * either as the other sends someone to do the wrong thing — and before this
 * endpoint existed in the client, BOTH surfaced as a bare 403 from a URL that
 * looked fine.
 */
export async function resolveDownloadUrl(
  client: SunoClient,
  clipId: string,
  options: ResolveOptions = {},
): Promise<string> {
  const format = options.format ?? 'mp3';
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let delay = 1_000;

  for (;;) {
    const ticket = await downloadTicket(client, clipId, format, options.signal);

    if (ticket.ok !== true) {
      const reason = ticket.reason ?? 'unknown';
      // `not_authorized` is the locked case, and it is deliberately NOT
      // resolved by calling authorize: that spends the owner's quota, and a
      // library must not do that on a caller's behalf.
      throw new SunoError({
        code: reason === 'not_authorized' ? 'download_locked' : 'api_error',
        message:
          reason === 'not_authorized'
            ? `clip ${clipId} has no download unlocked. Unlocking spends one of the account's ` +
              'metered downloads (see billing/info.download_usage); do it in the Suno app, or ' +
              'call authorizeDownload() deliberately.'
            : `download refused for ${clipId}: ${reason}${ticket.message ? ` (${ticket.message})` : ''}`,
      });
    }

    const url = ticket.download_url;
    if (typeof url === 'string' && url !== '') return url;

    // ok, no url yet: Suno is rendering this format. mp3 is normally ready on
    // the spot; wav/m4a/mp4 are not.
    if (Date.now() >= deadline) {
      throw new SunoError({
        code: 'timeout',
        message: `clip ${clipId}: ${format} still ${ticket.status ?? 'processing'} after ${Math.round(timeoutMs / 1000)}s`,
        retryable: true,
      });
    }
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), options.signal);
    delay = Math.min(delay * 2, 8_000);
  }
}

/**
 * Spend one of the account's metered downloads to unlock a clip.
 *
 * Nothing in this library calls this. It is here so that a caller who has
 * decided to spend can do so through the same client, with the same auth and
 * the same error taxonomy — not so that a download path can quietly reach for
 * it. `already_unlocked: true` comes back with `credit_deducted: false`, so
 * calling it twice on one clip is free, but calling it once on twenty clips is
 * the whole monthly allowance.
 */
export async function authorizeDownload(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<AuthorizeResult> {
  return client.request({
    method: 'POST',
    path: DOWNLOAD_AUTHORIZE_PATH,
    body: { item_id: clipId, item_type: 'clip' },
    schema: AuthorizeResultSchema,
    endpointKey: 'download.authorize',
    ...(signal ? { signal } : {}),
  });
}
