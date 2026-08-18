import type { SunoClient } from '../client.js';
import { looksLikeRejectedInput, SunoError } from '../errors.js';
import {
  AlignedLyricsSchema,
  BillingInfoSchema,
  CaptchaCheckSchema,
  ClipSchema,
  LyricsResultSchema,
  LyricsSubmitSchema,
  PersonaResponseSchema,
  type AlignedWord,
  type BillingInfo,
  type CaptchaCheck,
  type Clip,
  type LyricsResult,
  type PersonaInfo,
} from '../schemas.js';
import { sleep } from '../internal/retry.js';

export const BILLING_PATH = '/api/billing/info/';
export const CAPTCHA_CHECK_PATH = '/api/c/check';
export const LYRICS_PATH = '/api/generate/lyrics/';
export const TRASH_PATH = '/api/gen/trash';

export async function billingInfo(client: SunoClient, signal?: AbortSignal): Promise<BillingInfo> {
  return client.request({
    method: 'GET',
    path: BILLING_PATH,
    schema: BillingInfoSchema,
    endpointKey: 'billing.info',
    ...(signal ? { signal } : {}),
  });
}

/**
 * Ask whether this account is captcha-gated before spending anything.
 *
 * `required: false` for accounts above Suno's trust threshold, which lets a
 * headless client skip browser automation entirely. Tier is not the
 * discriminator: a Free account answered `{required: false, captcha_version: 2}`
 * on 2026-08-18, and the flag has been watched flickering on a paid one. See
 * docs/STATUS.md before wiring any behaviour to it.
 */
export async function captchaCheck(
  client: SunoClient,
  ctype = 'generation',
  signal?: AbortSignal,
): Promise<CaptchaCheck> {
  return client.request({
    method: 'POST',
    path: CAPTCHA_CHECK_PATH,
    body: { ctype },
    schema: CaptchaCheckSchema,
    endpointKey: 'captcha.check',
    ...(signal ? { signal } : {}),
  });
}

export interface LyricsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Free. Costs no credits, which makes it the ideal canary probe. */
export async function generateLyrics(
  client: SunoClient,
  prompt: string,
  options: LyricsOptions = {},
): Promise<LyricsResult> {
  const submitted = await client.request({
    method: 'POST',
    path: LYRICS_PATH,
    body: { prompt },
    schema: LyricsSubmitSchema,
    endpointKey: 'lyrics.submit',
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let delay = 2000;
  for (;;) {
    await sleep(delay, options.signal);
    const result = await client.request({
      method: 'GET',
      path: `${LYRICS_PATH}${submitted.id}`,
      schema: LyricsResultSchema,
      endpointKey: 'lyrics.result',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (result.error_message !== undefined && result.error_message !== '') {
      throw new SunoError({
        // A rejected prompt is the caller's input, not a fault. Retrying the
        // same text will be rejected again, and a bot should say so in chat
        // rather than burn its retry budget.
        code: looksLikeRejectedInput(result.error_message) ? 'invalid_input' : 'api_error',
        message: `lyrics generation failed: ${result.error_message}`,
      });
    }
    if (result.status === 'complete') return result;
    if (Date.now() > deadline) {
      throw new SunoError({ code: 'timeout', message: 'lyrics generation timed out' });
    }
    delay = Math.min(delay * 2, 8000);
  }
}

/** Word-level timings. The reason a Twitch overlay can highlight a lyric line. */
export async function alignedLyrics(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<AlignedWord[]> {
  const body = await client.request({
    method: 'GET',
    path: `/api/gen/${clipId}/aligned_lyrics/v2/`,
    schema: AlignedLyricsSchema,
    endpointKey: 'lyrics.aligned',
    ...(signal ? { signal } : {}),
  });
  return body.aligned_words;
}

export function toLrc(words: readonly AlignedWord[]): string {
  return words
    .map((w) => {
      const m = Math.floor(w.start_s / 60);
      const s = (w.start_s % 60).toFixed(2).padStart(5, '0');
      return `[${String(m).padStart(2, '0')}:${s}] ${w.word}`;
    })
    .join('\n');
}

/**
 * Move clips to trash, or restore them.
 *
 * Route verified 2026-07-20. The old `/api/feed/trash` now 404s. Note that
 * despite 422s that name `body.spec.*`, a `spec`-wrapped body is rejected:
 * those locs are server-side parameter names, not a required envelope.
 */
export async function setTrashed(
  client: SunoClient,
  ids: readonly string[],
  trash: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: 'POST',
    path: TRASH_PATH,
    body: { clip_ids: ids, trash },
    endpointKey: 'trash',
    ...(signal ? { signal } : {}),
  });
}

export interface SetMetadataOptions {
  title?: string;
  lyrics?: string;
  caption?: string;
  removeImageCover?: boolean;
  removeVideoCover?: boolean;
  signal?: AbortSignal;
}

export async function setMetadata(
  client: SunoClient,
  clipId: string,
  options: SetMetadataOptions,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (options.title !== undefined) body['title'] = options.title;
  if (options.lyrics !== undefined) body['lyrics'] = options.lyrics;
  if (options.caption !== undefined) body['caption'] = options.caption;
  if (options.removeImageCover !== undefined) body['remove_image_cover'] = options.removeImageCover;
  if (options.removeVideoCover !== undefined) body['remove_video_cover'] = options.removeVideoCover;

  await client.request({
    method: 'POST',
    path: `/api/gen/${clipId}/set_metadata/`,
    body,
    endpointKey: 'clip.setMetadata',
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function setVisibility(
  client: SunoClient,
  clipId: string,
  isPublic: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: 'POST',
    path: `/api/gen/${clipId}/set_visibility/`,
    body: { is_public: isPublic },
    endpointKey: 'clip.setVisibility',
    ...(signal ? { signal } : {}),
  });
}

export async function getPersona(
  client: SunoClient,
  personaId: string,
  signal?: AbortSignal,
): Promise<PersonaInfo> {
  const body = await client.request({
    method: 'GET',
    path: `/api/persona/get-persona-paginated/${personaId}/`,
    query: { page: 0 },
    schema: PersonaResponseSchema,
    endpointKey: 'persona.get',
    ...(signal ? { signal } : {}),
  });
  return body.persona;
}

/**
 * Kick off stem separation.
 *
 * The response shape here is NOT a clip, which is exactly where the Rust
 * reference client fails: it deserialises into its Clip type and throws, even
 * though Suno accepted the job and renders it fine. So we parse leniently and,
 * whatever comes back, the two resulting clips ("<title> - Vocals" and
 * "<title> - Instrumental") show up in the feed shortly after.
 */
export async function requestStems(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<{ accepted: true; raw: unknown; clips: Clip[] }> {
  const raw = await client.request({
    method: 'POST',
    path: `/api/edit/stems/${clipId}`,
    endpointKey: 'stems',
    ...(signal ? { signal } : {}),
  });

  const clips: Clip[] = [];
  const candidates = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as { clips?: unknown }).clips)
      ? ((raw as { clips: unknown[] }).clips)
      : [raw];
  for (const candidate of candidates) {
    const parsed = ClipSchema.safeParse(candidate);
    if (parsed.success) clips.push(parsed.data);
  }
  return { accepted: true, raw, clips };
}
