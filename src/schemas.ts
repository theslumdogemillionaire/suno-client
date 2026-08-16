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

export const ClipSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    // Deliberately NOT the ClipStatus enum: an unknown status must not throw.
    // A new Suno state should degrade to "not terminal yet", not crash a bot
    // mid-stream. The enum stays exported for callers who want to switch on it.
    status: z.string(),
    model_name: z.string(),
    audio_url: z.string().nullish(),
    video_url: z.string().nullish(),
    image_url: z.string().nullish(),
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
    description: z.string().optional(),
    max_lengths: MaxLengthsSchema.optional(),
  })
  .passthrough();

export type Model = z.infer<typeof ModelSchema>;

export const BillingInfoSchema = z
  .object({
    // Only these two are load-bearing. Everything else defaults, so one renamed
    // billing field cannot take down auth, credits and model listing at once.
    total_credits_left: z.number(),
    plan: z
      .object({
        name: z.string(),
        plan_key: z.string().optional(),
        usage_plan_features: z.array(z.object({ name: z.string() }).passthrough()).optional(),
      })
      .passthrough(),
    credits: z.number().optional(),
    monthly_usage: z.number().optional(),
    monthly_limit: z.number().optional(),
    is_active: z.boolean().optional(),
    models: z.array(ModelSchema).optional(),
    period: z.string().optional(),
    renews_on: z.string().nullish(),
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
