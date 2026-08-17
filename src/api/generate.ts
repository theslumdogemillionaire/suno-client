import { randomUUID } from 'node:crypto';

import type { SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { GenerateResponseSchema, type Clip } from '../schemas.js';

export const GENERATE_PATH = '/api/generate/v2-web/';

/** v5.5. Suno's default; `suno.models()` lists what the account can actually use. */
export const DEFAULT_MODEL = 'chirp-fenix';

export interface ControlSliders {
  /** 0..1, the UI's 0-100 weirdness dial. */
  weirdnessConstraint?: number;
  /** 0..1, style influence. */
  styleWeight?: number;
  /** 0..1, how strongly source audio shapes a cover or remix. */
  audioWeight?: number;
}

export interface GenerateMetadataWire {
  web_client_pathname: string;
  is_max_mode: boolean;
  is_mumble: boolean;
  /** "custom" | "inspiration" | "cover" | "remaster". Free-form on the wire. */
  create_mode: string;
  user_tier: string;
  create_session_token: string;
  disable_volume_normalization: boolean;
  /** Sent by the web app on every create. Decorative as far as we can tell. */
  lyrics_updated?: boolean;
  /** True on extend and other derived creates. Captured from the live web app. */
  is_remix?: boolean;
  control_sliders?: {
    weirdness_constraint?: number;
    style_weight?: number;
    audio_weight?: number;
  };
}

/**
 * The literal POST body. Field names and null-vs-empty-string choices are the
 * contract; do not "clean this up".
 *
 * Two of these defaults were paid for in downtime:
 *
 *   title       must be a STRING. `null` began returning 422
 *               `body.params.title: Input should be a valid string` around
 *               2026-08-01 and silently killed every code path that did not set
 *               an explicit title.
 *   token_provider is absent entirely. Suno's v2-web schema types it as an
 *               integer and 422s on a string, so sending it "for completeness"
 *               breaks generation.
 */
export interface GenerateWireBody {
  token: string | null;
  /**
   * Absent on a plain create, `"extend"` on a continuation.
   *
   * Captured from the real web app on 2026-08-17 by watching the browser submit
   * an extend. Its absence is what produced HTTP 400 "Inconsistent task and
   * generation params": the body named `continue_clip_id` while the task said
   * plain generation, and the server would not reconcile the two.
   */
  task?: string;
  generation_type: string;
  title: string;
  tags: string | null;
  negative_tags: string;
  mv: string;
  prompt: string;
  make_instrumental: boolean;
  user_uploaded_images_b64: string | null;
  metadata: GenerateMetadataWire;
  override_fields: unknown[];
  cover_clip_id: string | null;
  cover_start_s: number | null;
  cover_end_s: number | null;
  persona_id: string | null;
  artist_clip_id: string | null;
  artist_start_s: number | null;
  artist_end_s: number | null;
  continue_clip_id: string | null;
  continued_aligned_prompt: string | null;
  continue_at: number | null;
  transaction_uuid: string;
  /** Escape hatch, see `extraFields` on the request options. */
  [key: string]: unknown;
}

export interface BaseGenerateOptions {
  model?: string;
  instrumental?: boolean;
  negativeTags?: string;
  personaId?: string;
  sliders?: ControlSliders;
  /** hCaptcha solution, only when `captchaCheck()` says one is required. */
  captchaToken?: string;
  /**
   * Merged into the wire body last, overwriting anything above it.
   *
   * This exists because Suno adds required fields without warning, and the
   * difference between a five-minute fix and a release cycle is whether you can
   * add a field from config. When a 422 names a field this client does not
   * send, put it here, confirm it works, then open an issue so it becomes a
   * real default.
   */
  extraFields?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CustomGenerateOptions extends BaseGenerateOptions {
  /** The lyrics. Meta tags like [Verse] and [Chorus] belong in here. */
  lyrics: string;
  /** Style prompt. Genre, instrumentation, vocal direction, BPM. */
  tags: string;
  title: string;
}

export interface DescribeGenerateOptions extends BaseGenerateOptions {
  /** A plain description. Suno writes the lyrics. */
  prompt: string;
  /** Optional style steer, same field as custom mode. */
  tags?: string;
  /** Optional; Suno names the track when this is empty. */
  title?: string;
}

function slidersToWire(s: ControlSliders | undefined): GenerateMetadataWire['control_sliders'] {
  if (!s) return undefined;
  const wire: NonNullable<GenerateMetadataWire['control_sliders']> = {};
  if (s.weirdnessConstraint !== undefined) wire.weirdness_constraint = s.weirdnessConstraint;
  if (s.styleWeight !== undefined) wire.style_weight = s.styleWeight;
  if (s.audioWeight !== undefined) wire.audio_weight = s.audioWeight;
  return Object.keys(wire).length > 0 ? wire : undefined;
}

export function buildMetadata(
  createMode: string,
  sliders?: ControlSliders,
  sessionToken: string = randomUUID(),
): GenerateMetadataWire {
  const control = slidersToWire(sliders);
  return {
    web_client_pathname: '/create',
    is_max_mode: false,
    is_mumble: false,
    create_mode: createMode,
    // Not validated server-side: empty string and arbitrary text both work.
    user_tier: '',
    // Looks decorative. Is not optional.
    create_session_token: sessionToken,
    disable_volume_normalization: false,
    lyrics_updated: false,
    ...(control ? { control_sliders: control } : {}),
  };
}

/** Every field the endpoint expects, at its safe default. */
export function baseWireBody(
  mv: string,
  createMode: string,
  sliders?: ControlSliders,
): GenerateWireBody {
  return {
    token: null,
    generation_type: 'TEXT',
    title: '',
    tags: null,
    negative_tags: '',
    mv,
    prompt: '',
    make_instrumental: false,
    user_uploaded_images_b64: null,
    metadata: buildMetadata(createMode, sliders),
    override_fields: [],
    cover_clip_id: null,
    cover_start_s: null,
    cover_end_s: null,
    persona_id: null,
    artist_clip_id: null,
    artist_start_s: null,
    artist_end_s: null,
    continue_clip_id: null,
    continued_aligned_prompt: null,
    continue_at: null,
    transaction_uuid: randomUUID(),
  };
}

export function buildCustomBody(options: CustomGenerateOptions): GenerateWireBody {
  const body = baseWireBody(options.model ?? DEFAULT_MODEL, 'custom', options.sliders);
  body.title = options.title;
  body.tags = options.tags;
  body.prompt = options.lyrics;
  body.make_instrumental = options.instrumental ?? false;
  body.negative_tags = options.negativeTags ?? '';
  body.persona_id = options.personaId ?? null;
  body.token = options.captchaToken ?? null;
  return Object.assign(body, options.extraFields);
}

export function buildDescribeBody(options: DescribeGenerateOptions): GenerateWireBody {
  const body = baseWireBody(options.model ?? DEFAULT_MODEL, 'inspiration', options.sliders);
  // v2-web dropped `gpt_description_prompt`. Inspiration mode is signalled by
  // `create_mode: "inspiration"` alone, and the description rides in the same
  // `prompt` field custom mode uses for lyrics. Older clients that still send
  // gpt_description_prompt are talking to the retired /api/generate/v2/ route.
  body.prompt = options.prompt;
  if (options.tags !== undefined) body.tags = options.tags;
  body.title = options.title ?? '';
  body.make_instrumental = options.instrumental ?? false;
  body.negative_tags = options.negativeTags ?? '';
  body.persona_id = options.personaId ?? null;
  body.token = options.captchaToken ?? null;
  return Object.assign(body, options.extraFields);
}

/**
 * Suno can answer HTTP 200 with `{"status":"error","clips":[]}`. Credits get
 * quoted and nothing is created, so treating 200 as success reports a
 * generation that does not exist.
 */
export function validateSubmission(response: unknown): Clip[] {
  const parsed = GenerateResponseSchema.parse(response);
  if (typeof parsed.status === 'string' && parsed.status.toLowerCase() === 'error') {
    throw new SunoError({
      code: 'api_error',
      message: 'Suno rejected the generation (HTTP 200 with status "error")',
      body: JSON.stringify(parsed).slice(0, 500),
    });
  }
  if (parsed.clips.length === 0) {
    throw new SunoError({
      code: 'api_error',
      message: 'Suno returned no clips: the generation was not created',
      body: JSON.stringify(parsed).slice(0, 500),
    });
  }
  return parsed.clips;
}

export async function submitGenerate(
  client: SunoClient,
  body: GenerateWireBody,
  signal?: AbortSignal,
): Promise<Clip[]> {
  const raw = await client.request({
    method: 'POST',
    path: GENERATE_PATH,
    body,
    endpointKey: 'generate',
    // Never retry a create. A network blip after Suno accepted the request
    // would bill a second generation for the same call.
    retry: { maxRetries: 0 },
    ...(signal ? { signal } : {}),
  });
  return validateSubmission(raw);
}
