import { z } from 'zod';

/**
 * Every schema here is `.passthrough()` on purpose.
 *
 * Suno adds response fields regularly. A strict schema would turn each of those
 * additions into an outage, which is the opposite of resilient. Unknown fields
 * flow through untouched; the drift detector is what notices them, and it does
 * so at `info` severity rather than by throwing.
 *
 * The flip side is that these schemas must stay honest about what is genuinely
 * optional. `audio_url` is empty while a clip is queued and populated once it
 * renders, so it is nullable here and the code that reads it must handle both.
 */

export const ClipStatus = z.enum(['submitted', 'queued', 'streaming', 'complete', 'error']);
export type ClipStatus = z.infer<typeof ClipStatus>;

/** A clip stops changing only at these two. Everything else is still in flight. */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'error']);

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export const ClipMetadataSchema = z
  .object({
    tags: z.string().nullish(),
    prompt: z.string().nullish(),
    duration: z.number().nullish(),
    avg_bpm: z.number().nullish(),
    has_stem: z.boolean().optional(),
    is_remix: z.boolean().optional(),
    make_instrumental: z.boolean().optional(),
    type: z.string().nullish(),
    // Only present when the clip lands in `error`. Moderation rejections and
    // internal failures both surface here, and a caller that ignores them
    // reports a "successful" generation that produced nothing playable.
    error_type: z.string().nullish(),
    error_message: z.string().nullish(),
  })
  .passthrough();

/**
 * The one entry Suno puts in `media_urls`, as of 2026-09-10.
 *
 * Not the metered download path. The URL is public and unauthenticated and
 * answers 200 with `content-type: audio/mp4`, which makes it look like the
 * obvious replacement for `audio_url` — fetching it as-is writes ciphertext.
 * The payload measures 7.997 bits per byte end to end and carries no `ftyp`.
 *
 * Playable bytes need the keys from `POST /api/mango/rights` — `playTrack`, or
 * an explicit `source: 'playback'`. The default download path still uses
 * `/api/download/clip/{id}`; see `AUDIO_FORBIDDEN_URL`.
 *
 * `content_type` has only ever been seen as `m4a-opus`, `delivery` as
 * `progressive`, `encoding` as `1.0.0` — all across 50 clips. All four fields
 * are loose on purpose: none of them is worth an outage.
 */
export const MediaUrlSchema = z
  .object({
    url: z.string(),
    content_type: z.string().nullish(),
    delivery: z.string().nullish(),
    encoding: z.string().nullish(),
  })
  .passthrough();

export type MediaUrl = z.infer<typeof MediaUrlSchema>;

/**
 * What `audio_url` holds now that Suno has stopped serving audio from it.
 *
 * Not an error state and not a placeholder for "still rendering": as of
 * 2026-09-10 every clip in a live library carries this, `complete` ones
 * included, retroactively — including clips downloaded successfully weeks
 * earlier. Fetching it returns 403.
 *
 * The trap it sets is that it is a non-empty string, so `Boolean(clip.audio_url)`
 * and `typeof url === 'string' && url !== ''` both say yes. Every truthiness
 * check written against `audio_url` before this date now passes on every clip
 * and defers the failure to a 403 at download time.
 */
export const AUDIO_FORBIDDEN_URL = 'https://studio-api.prod.suno.com/api/forbidden';

/**
 * True when `url` is a URL you can actually fetch bytes from.
 *
 * Compared on the path rather than the whole string: the host has already moved
 * once (`studio-api.prod` here, `studio-api-prod` for the API itself) and a
 * literal match would silently start passing again the day it moves back.
 */
export function isFetchableUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url === '') return false;
  return !url.endsWith('/api/forbidden');
}

export const ClipSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    // Deliberately NOT the ClipStatus enum: an unknown status must not throw.
    // A new Suno state should degrade to "not terminal yet", not crash a bot
    // mid-stream. The enum stays exported for callers who want to switch on it.
    status: z.string(),
    model_name: z.string(),
    // Reads as a URL, fetches as a 403. See AUDIO_FORBIDDEN_URL before trusting it.
    audio_url: z.string().nullish(),
    video_url: z.string().nullish(),
    image_url: z.string().nullish(),
    /** Encrypted player delivery. See MediaUrlSchema and `playTrack`. */
    media_urls: z.array(MediaUrlSchema).nullish(),
    /**
     * Whether a metered download has been spent on this clip.
     *
     * Since audio_url died this is what actually decides whether bytes are
     * obtainable, so it belongs in the type rather than surviving untyped
     * through `.passthrough()`. False on 48 of 50 clips in a real library: that
     * is the normal state, not a fault.
     */
    is_download_unlocked: z.boolean().nullish(),
    download_unlocked_at: z.string().nullish(),
    created_at: z.string(),
    play_count: z.number().optional(),
    upvote_count: z.number().optional(),
    metadata: ClipMetadataSchema.optional(),
  })
  .passthrough();

export type Clip = z.infer<typeof ClipSchema>;

export const GenerateResponseSchema = z
  .object({
    clips: z.array(ClipSchema).default([]),
    // Suno answers HTTP 200 with {"status":"error","clips":[]} when a create is
    // rejected server-side. Credits are quoted; nothing is created.
    status: z.string().nullish(),
  })
  .passthrough();

export type GenerateResponse = z.infer<typeof GenerateResponseSchema>;

export const FeedPageSchema = z
  .object({
    clips: z.array(ClipSchema).default([]),
    /** Opaque. Never construct one; only ever echo it back. */
    next_cursor: z.string().nullish(),
    has_more: z.boolean().optional(),
  })
  .passthrough();

export type FeedPage = z.infer<typeof FeedPageSchema>;

export const ClipsArraySchema = z.array(ClipSchema);

/**
 * The account's standing with one clip, as `update_reaction_type` returns it.
 *
 * `reaction_type` is `"L"` for a like and the key is absent when there is no
 * reaction: absence, not `null`, is what an unlike returns. Nothing is
 * required, because this arrives after the write has already happened and a
 * renamed counter must not turn a successful like into an error.
 */
export const ClipReactionSchema = z
  .object({
    clip: z.string().nullish(),
    reaction_type: z.string().nullish(),
    play_count: z.number().nullish(),
    skip_count: z.number().nullish(),
    flagged: z.boolean().nullish(),
    updated_at: z.string().nullish(),
  })
  .passthrough();

export type ClipReaction = z.infer<typeof ClipReactionSchema>;

export const MaxLengthsSchema = z
  .object({
    title: z.number().optional(),
    prompt: z.number().optional(),
    tags: z.number().optional(),
    negative_tags: z.number().optional(),
    gpt_description_prompt: z.number().optional(),
  })
  .passthrough();

export const ModelSchema = z
  .object({
    name: z.string(),
    external_key: z.string(),
    can_use: z.boolean().optional(),
    is_default_model: z.boolean().optional(),
    /**
     * Set on the one model a Free account is allowed to use. Paid payloads
     * carry it too, on a model the account may not be able to use at all, so it
     * is a hint about the tier below you rather than about you.
     */
    is_default_free_model: z.boolean().optional(),
    /** `["pro"]` on models behind a subscription. */
    badges: z.array(z.string()).optional(),
    description: z.string().optional(),
    max_lengths: MaxLengthsSchema.optional(),
  })
  .passthrough();

export type Model = z.infer<typeof ModelSchema>;

export const PlanFeatureSchema = z.object({ name: z.string() }).passthrough();

export const PlanSchema = z
  .object({
    name: z.string(),
    plan_key: z.string().optional(),
    level: z.number().optional(),
    usage_plan_features: z.array(PlanFeatureSchema).optional(),
  })
  .passthrough();

/**
 * Billing, across account tiers.
 *
 * Only `total_credits_left` is required, and that is not tidiness: a Free
 * account's payload has **no `plan` object at all**. Requiring it - which this
 * schema did until 2026-08-18 - made `billing()`, `credits()` and `models()`
 * all throw `response_invalid` on every Free account, which in turn took out
 * anything built on top of them. Verified live against a Free account.
 *
 * What a Free payload has instead: `plans` (the catalogue you could buy, not
 * the one you hold), `subscription_type: false`, `is_active: false`, and
 * `accessible_features` listing the handful of features that are actually
 * unlocked. See `describeAccount()` in api/account.ts for the tier derivation.
 */
export const BillingInfoSchema = z
  .object({
    // The one field every tier returns. Everything else defaults, so one
    // renamed billing field cannot take down auth, credits and model listing at
    // once.
    total_credits_left: z.number(),
    /** Absent on Free. Present on a subscription, and the tier signal. */
    plan: PlanSchema.optional(),
    /** The purchasable catalogue. Free accounts get it; it is not your plan. */
    plans: z.array(PlanSchema).optional(),
    /** False on Free, true on a live subscription. */
    subscription_type: z.boolean().optional(),
    /** Features unlocked for this account right now, whatever the tier. */
    accessible_features: z.array(PlanFeatureSchema).optional(),
    credits: z.number().optional(),
    monthly_usage: z.number().optional(),
    monthly_limit: z.number().optional(),
    is_active: z.boolean().optional(),
    models: z.array(ModelSchema).optional(),
    period: z.string().optional(),
    renews_on: z.string().nullish(),
    /** Free-tier allowances, counted down per feature. Zero is common. */
    free_cover_clips_remaining: z.number().optional(),
    free_persona_clips_remaining: z.number().optional(),
    free_remasters_remaining: z.number().optional(),
    /** Free accounts replenish credits on a short timer rather than monthly. */
    credit_rate_limit: z
      .object({
        available_credits: z.number().optional(),
        replenish_credits: z.number().optional(),
        replenish_interval_secs: z.number().optional(),
      })
      .passthrough()
      .optional(),
    remaster_model_types: z
      .array(
        z
          .object({
            name: z.string(),
            external_key: z.string(),
            is_default_model: z.boolean().optional(),
            can_use: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type BillingInfo = z.infer<typeof BillingInfoSchema>;
export type Plan = z.infer<typeof PlanSchema>;

export const LyricsSubmitSchema = z.object({ id: z.string() }).passthrough();

export const LyricsResultSchema = z
  .object({
    text: z.string(),
    title: z.string(),
    status: z.string(),
    error_message: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough();

export type LyricsResult = z.infer<typeof LyricsResultSchema>;

export const AlignedWordSchema = z
  .object({
    word: z.string(),
    start_s: z.number(),
    end_s: z.number(),
    success: z.boolean().optional(),
    p_align: z.number().nullish(),
  })
  .passthrough();

export type AlignedWord = z.infer<typeof AlignedWordSchema>;

export const AlignedLyricsSchema = z
  .object({
    aligned_words: z.array(AlignedWordSchema).default([]),
  })
  .passthrough();

/**
 * `required` has no default on purpose. A payload missing the field must fail
 * to parse, so the caller's error branch treats captcha as required. Defaulting
 * it to false would silently skip the solver the day Suno renames the field.
 */
export const CaptchaCheckSchema = z
  .object({
    required: z.boolean(),
    captcha_version: z.number().nullish(),
  })
  .passthrough();

export type CaptchaCheck = z.infer<typeof CaptchaCheckSchema>;

export const PersonaInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    image_s3_id: z.string().nullish(),
    user_display_name: z.string().nullish(),
    user_handle: z.string().nullish(),
  })
  .passthrough();

export const PersonaResponseSchema = z.object({ persona: PersonaInfoSchema }).passthrough();

export type PersonaInfo = z.infer<typeof PersonaInfoSchema>;
