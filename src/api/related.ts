/**
 * What a clip is related to: songs like it, its remixes, and what it remixes.
 *
 * All of it measured live on 2026-10-27. Only the remix sources answer without
 * a session; the rest is 401 anonymous, so those calls need one.
 */
import { z } from 'zod';

import { pathSegment, type SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { salvageClips } from '../internal/clip.js';
import { walkCursorPages } from '../internal/pages.js';
import { requestWithSessionIfAny } from '../internal/session.js';
import type { Clip } from '../schemas.js';

export const SIMILAR_PATH = '/api/clips/get_similar';
export const REMIXES_PATH = '/api/clips/remixes';
export const REMIX_COUNT_PATH = '/api/clips/remixes/count';
export const PARENT_PATH = '/api/clips/parent';

/** Remixes per page when none is asked for. The server took 100 on 2026-10-27. */
export const REMIXES_PAGE_SIZE = 20;

function checkClipId(id: string): string {
  const trimmed = id.trim();
  if (trimmed === '') throw new SunoError({ code: 'invalid_input', message: 'a clip id cannot be empty' });
  return trimmed;
}

const SimilarSchema = z
  .object({ similar_clips: z.array(z.unknown()).nullish().transform(salvageClips) })
  .passthrough();

/**
 * Songs Suno considers like this one, as its "similar songs" shelf shows them.
 *
 * Ten on every call measured; `limit` is ignored. Other creators' songs mostly.
 * Needs a session.
 */
export async function similarClips(client: SunoClient, clipId: string, signal?: AbortSignal): Promise<Clip[]> {
  const data = await client.request({
    method: 'GET',
    path: SIMILAR_PATH,
    query: { id: checkClipId(clipId) },
    schema: SimilarSchema,
    endpointKey: 'clips.similar',
    ...(signal ? { signal } : {}),
  });
  return data.similar_clips;
}

const RemixesSchema = z
  .object({
    remixes: z.array(z.unknown()).nullish().transform(salvageClips),
    has_more: z.boolean().nullish(),
    next_cursor: z.string().nullish(),
  })
  .passthrough();

export interface RemixesPage {
  clips: Clip[];
  hasMore: boolean;
  /** Pass back as `cursor` for the next page. */
  nextCursor: string | undefined;
}

/**
 * One page of the public remixes of a clip (covers, extends and the like by
 * anyone). Pages by `next_cursor`; `offset` and `page` are ignored. Needs a
 * session.
 */
export async function listRemixes(
  client: SunoClient,
  clipId: string,
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<RemixesPage> {
  const limit = options.limit ?? REMIXES_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new SunoError({ code: 'invalid_input', message: `limit must be a positive integer, got ${limit}` });
  }
  const data = await client.request({
    method: 'GET',
    path: REMIXES_PATH,
    query: { clip_id: checkClipId(clipId), limit, ...(options.cursor !== undefined ? { cursor: options.cursor } : {}) },
    schema: RemixesSchema,
    endpointKey: 'clips.remixes',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { clips: data.remixes, hasMore: data.has_more === true, nextCursor: data.next_cursor ?? undefined };
}

/**
 * Every public remix of a clip, each once. Fewer than `remixCount()` says:
 * 46 of 55 on the clip measured, the rest presumably private or removed.
 */
export function iterateRemixes(
  client: SunoClient,
  clipId: string,
  options: { pageSize?: number; maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Clip, void, undefined> {
  const id = checkClipId(clipId);
  return walkCursorPages<Clip>({
    fetchPage: async (cursor) => {
      const page = await listRemixes(client, id, {
        ...(cursor !== undefined ? { cursor } : {}),
        ...(options.pageSize !== undefined ? { limit: options.pageSize } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { items: page.clips, nextCursor: page.nextCursor, hasMore: page.hasMore };
    },
    keyOf: (clip) => clip.id,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  });
}

const RemixCountSchema = z.object({ count: z.number(), is_capped: z.boolean().nullish() }).passthrough();

export interface RemixCount {
  count: number;
  /** True when Suno stopped counting and `count` is a floor. */
  capped: boolean;
}

/** How many remixes a clip has, as its page says. Needs a session. */
export async function remixCount(client: SunoClient, clipId: string, signal?: AbortSignal): Promise<RemixCount> {
  const data = await client.request({
    method: 'GET',
    path: REMIX_COUNT_PATH,
    query: { clip_id: checkClipId(clipId) },
    schema: RemixCountSchema,
    endpointKey: 'clips.remixCount',
    ...(signal ? { signal } : {}),
  });
  return { count: data.count, capped: data.is_capped === true };
}

export const RemixSourceSchema = z
  .object({
    clip_id: z.string(),
    /** `"AG"` on every source measured; meaning unconfirmed. */
    relationship: z.string().nullish(),
    is_deleted: z.boolean().nullish(),
    title: z.string().nullish(),
    image_url: z.string().nullish(),
    audio_url: z.string().nullish(),
    user: z
      .object({
        user_id: z.string().nullish(),
        user_display_name: z.string().nullish(),
        user_handle: z.string().nullish(),
        user_avatar_url: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

export type RemixSource = z.infer<typeof RemixSourceSchema>;

const AttributionSchema = z.object({ source_clips: z.array(RemixSourceSchema).default([]) }).passthrough();

/**
 * The songs a clip was made from, when it is a remix: empty for an original.
 * Answers without a session; with one it is sent.
 */
export async function remixSources(client: SunoClient, clipId: string, signal?: AbortSignal): Promise<RemixSource[]> {
  const data = await requestWithSessionIfAny(client, {
    method: 'GET',
    path: `/api/clips/${pathSegment(checkClipId(clipId))}/attribution`,
    schema: AttributionSchema,
    endpointKey: 'clips.attribution',
    ...(signal ? { signal } : {}),
  });
  return data.source_clips;
}

export const ParentClipSchema = z
  .object({
    id: z.string().nullish(),
    title: z.string().nullish(),
    image_url: z.string().nullish(),
    is_public: z.boolean().nullish(),
    user_display_name: z.string().nullish(),
    user_handle: z.string().nullish(),
    user_avatar_image_url: z.string().nullish(),
  })
  .passthrough();

export type ParentClip = z.infer<typeof ParentClipSchema> & { id: string };

/**
 * The public clip this one was derived from, or undefined.
 *
 * Without a public parent, Suno still answers 200, with `is_public: false`, the
 * owner's name and no `id`: that is read here as no parent. Needs a session.
 */
export async function parentClip(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<ParentClip | undefined> {
  const data = await client.request({
    method: 'GET',
    path: PARENT_PATH,
    query: { clip_id: checkClipId(clipId) },
    schema: ParentClipSchema,
    endpointKey: 'clips.parent',
    ...(signal ? { signal } : {}),
  });
  return typeof data.id === 'string' && data.id !== '' ? { ...data, id: data.id } : undefined;
}
