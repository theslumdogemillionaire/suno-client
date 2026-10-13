/**
 * Public playlist fetch. The same GET suno.com makes when anyone opens a share
 * link — no session, no download quota.
 *
 * Paging is `?page=N`. The payload is not a feed/v3 page: clips live under
 * `playlist_clips[].clip` and the playlist's own order is `relative_index`.
 */
import { z } from 'zod';

import type { SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { ClipSchema, type Clip } from '../schemas.js';

export const PLAYLIST_PATH = '/api/playlist';
/**
 * A runaway guard, not a size limit: paging already ends on the first page
 * that adds nothing. Reaching it throws rather than returning part of the
 * playlist as if it were all of it, which is what a cap of 20 used to do.
 */
const MAX_PAGES = 500;

const PlaylistItemSchema = z
  .object({
    relative_index: z.number().nullish(),
    clip: z.unknown(),
  })
  .passthrough();

export const PlaylistPageSchema = z
  .object({
    id: z.string().nullish(),
    name: z.string().nullish(),
    user_display_name: z.string().nullish(),
    user_handle: z.string().nullish(),
    total_duration: z.number().nullish(),
    num_total_results: z.number().nullish(),
    playlist_clips: z.array(PlaylistItemSchema).nullish(),
  })
  .passthrough();

export type PlaylistPage = z.infer<typeof PlaylistPageSchema>;

const PLAYLIST_UUID =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

export function extractPlaylistId(input: string): string {
  const text = input.trim();
  const fromUrl = /suno\.com\/playlist\/([0-9a-fA-F-]{36})/i.exec(text);
  if (fromUrl?.[1]) return fromUrl[1].toLowerCase();
  if (PLAYLIST_UUID.test(text) && text.length === 36) return text.toLowerCase();
  throw new SunoError({
    code: 'invalid_input',
    message: `not a Suno playlist link or id: ${JSON.stringify(input)}`,
  });
}

export interface Playlist {
  id: string;
  name: string;
  userDisplayName: string | undefined;
  userHandle: string | undefined;
  totalDuration: number | undefined;
  clips: Clip[];
}

export async function getPlaylist(
  client: SunoClient,
  idOrUrl: string,
  options: { signal?: AbortSignal } = {},
): Promise<Playlist> {
  const pid = extractPlaylistId(idOrUrl);
  const entries: Array<{ pos: number; clip: Clip }> = [];
  const seen = new Set<string>();
  let meta: PlaylistPage | undefined;

  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) {
      throw new SunoError({
        code: 'api_error',
        message: `playlist ${pid} still had new clips after ${MAX_PAGES} pages; refusing to return it truncated`,
      });
    }
    const data = await client.request({
      method: 'GET',
      path: `${PLAYLIST_PATH}/${pid}`,
      query: { page },
      schema: PlaylistPageSchema,
      endpointKey: 'playlist.get',
      skipAuth: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // The first page describes the playlist; a later page that omits the owner
    // fields must not erase them.
    meta ??= data;
    let added = 0;
    for (const item of data.playlist_clips ?? []) {
      const clip = clipFromItem(item.clip);
      if (!clip || seen.has(clip.id)) continue;
      seen.add(clip.id);
      const pos = typeof item.relative_index === 'number' ? item.relative_index : entries.length + 1;
      entries.push({ pos, clip });
      added += 1;
    }
    // Without a total, keep going until a page adds nothing: treating the
    // clips seen so far as the total stopped after page 1.
    const total = data.num_total_results;
    if (added === 0 || (typeof total === 'number' && entries.length >= total)) break;
  }

  if (!meta) {
    throw new SunoError({ code: 'not_found', message: `playlist ${pid} returned no pages` });
  }

  entries.sort((a, b) => a.pos - b.pos);
  return {
    id: typeof meta.id === 'string' && meta.id !== '' ? meta.id : pid,
    name: meta.name?.trim() || pid,
    userDisplayName: emptyToUndef(meta.user_display_name),
    userHandle: emptyToUndef(meta.user_handle),
    totalDuration: typeof meta.total_duration === 'number' ? meta.total_duration : undefined,
    clips: entries.map((e) => e.clip),
  };
}

function emptyToUndef(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Playlist clips are the same objects as the feed, but a public payload has
 * been seen dropping fields ClipSchema treats as required. Fill the holes so
 * a missing `created_at` does not throw away a downloadable track.
 */
function clipFromItem(raw: unknown): Clip | undefined {
  const direct = ClipSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (raw === null || typeof raw !== 'object' || !('id' in raw) || typeof (raw as { id: unknown }).id !== 'string') {
    return undefined;
  }
  // A null is as much a hole as a missing key. Spread as-is it overrode the
  // defaults below, and the clip was dropped anyway.
  const present = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null));
  const filled = ClipSchema.safeParse({
    title: '',
    status: 'complete',
    model_name: 'unknown',
    created_at: '1970-01-01T00:00:00.000Z',
    ...present,
  });
  return filled.success ? filled.data : undefined;
}
