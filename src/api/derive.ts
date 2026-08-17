import type { SunoClient } from '../client.js';
import { ClipSchema, type Clip } from '../schemas.js';
import {
  baseWireBody,
  DEFAULT_MODEL,
  submitGenerate,
  type BaseGenerateOptions,
  type GenerateWireBody,
} from './generate.js';

export const CONCAT_PATH = '/api/generate/concat/v2/';

/** v5.5 remaster. Remaster uses its own model keys, not the generation ones. */
export const DEFAULT_REMASTER_MODEL = 'chirp-flounder';

export interface CoverOptions extends BaseGenerateOptions {
  /** Style to re-record in. Leave unset to let Suno choose. */
  tags?: string;
  title?: string;
  /** Slice of the source to cover, in seconds. */
  startS?: number;
  endS?: number;
}

export function buildCoverBody(clipId: string, options: CoverOptions = {}): GenerateWireBody {
  const body = baseWireBody(options.model ?? DEFAULT_MODEL, 'cover', options.sliders);
  body.cover_clip_id = clipId;
  body.title = options.title ?? '';
  if (options.tags !== undefined) body.tags = options.tags;
  body.cover_start_s = options.startS ?? null;
  body.cover_end_s = options.endS ?? null;
  body.make_instrumental = options.instrumental ?? false;
  body.negative_tags = options.negativeTags ?? '';
  body.persona_id = options.personaId ?? null;
  body.token = options.captchaToken ?? null;
  return Object.assign(body, options.extraFields);
}

export async function cover(
  client: SunoClient,
  clipId: string,
  options: CoverOptions = {},
): Promise<Clip[]> {
  return submitGenerate(client, buildCoverBody(clipId, options), options.signal);
}

export interface RemasterOptions extends BaseGenerateOptions {
  title?: string;
}

export function buildRemasterBody(clipId: string, options: RemasterOptions = {}): GenerateWireBody {
  const body = baseWireBody(options.model ?? DEFAULT_REMASTER_MODEL, 'remaster', options.sliders);
  body.cover_clip_id = clipId;
  body.title = options.title ?? '';
  body.token = options.captchaToken ?? null;
  return Object.assign(body, options.extraFields);
}

export async function remaster(
  client: SunoClient,
  clipId: string,
  options: RemasterOptions = {},
): Promise<Clip[]> {
  return submitGenerate(client, buildRemasterBody(clipId, options), options.signal);
}

export interface ExtendOptions extends BaseGenerateOptions {
  /** Seconds into the source clip where the continuation starts. */
  at: number;
  /** Lyrics for the continuation. */
  lyrics?: string;
  tags?: string;
  title?: string;
  /**
   * Rarely needed. The live web app sends `null` here even on a successful
   * extend, so this was NOT the cause of the 400 that the Rust reference client
   * still hits; the missing `task: "extend"` was.
   */
  continuedAlignedPrompt?: string;
}

export function buildExtendBody(clipId: string, options: ExtendOptions): GenerateWireBody {
  const body = baseWireBody(options.model ?? DEFAULT_MODEL, 'custom', options.sliders);
  // The two fields that make an extend an extend. Captured from the web app;
  // without `task` the server answers 400 "Inconsistent task and generation
  // params" no matter how correct the rest of the body is.
  body.task = 'extend';
  body.metadata.is_remix = true;
  body.continue_clip_id = clipId;
  body.continue_at = options.at;
  body.continued_aligned_prompt = options.continuedAlignedPrompt ?? null;
  body.prompt = options.lyrics ?? '';
  body.title = options.title ?? '';
  if (options.tags !== undefined) body.tags = options.tags;
  body.make_instrumental = options.instrumental ?? false;
  body.negative_tags = options.negativeTags ?? '';
  body.persona_id = options.personaId ?? null;
  body.token = options.captchaToken ?? null;
  return Object.assign(body, options.extraFields);
}

export async function extend(
  client: SunoClient,
  clipId: string,
  options: ExtendOptions,
): Promise<Clip[]> {
  return submitGenerate(client, buildExtendBody(clipId, options), options.signal);
}

/** Stitch a clip and its extensions into one continuous track. */
export async function concat(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<Clip> {
  return client.request({
    method: 'POST',
    path: CONCAT_PATH,
    body: { clip_id: clipId },
    schema: ClipSchema,
    endpointKey: 'concat',
    retry: { maxRetries: 0 },
    ...(signal ? { signal } : {}),
  });
}
