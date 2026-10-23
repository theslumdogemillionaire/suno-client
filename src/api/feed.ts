import { pathSegment, type SunoClient } from '../client.js';
import { requestWithSessionIfAny } from '../internal/session.js';
import { ClipSchema, ClipsArraySchema, FeedPageSchema, type Clip, type FeedPage } from '../schemas.js';

export const FEED_V3_PATH = '/api/feed/v3';
export const FEED_BY_IDS_PATH = '/api/feed/';
export const CLIP_PATH = '/api/clip';

export interface FeedFiltersWire {
  searchText?: string;
  trashed?: string;
  fullSong?: string;
  stem?: { presence: string };
  /**
   * A capitalised string, like `trashed`. The `{ presence: "True" }` form that
   * `stem` takes is accepted and ignored: it returns the whole library.
   */
  liked?: string;
}

export interface ListOptions {
  /**
   * The opaque `next_cursor` from a previous page. feed/v3 does NOT accept page
   * numbers; passing one returns page 1 forever, which reads as "the user only
   * has 20 songs".
   */
  cursor?: string;
  limit?: number;
  /** Only the clips this account has liked. Sends `liked` and `trashed` filters. */
  liked?: boolean;
  signal?: AbortSignal;
}

export async function listClips(client: SunoClient, options: ListOptions = {}): Promise<FeedPage> {
  const body: { cursor?: string; limit?: number; filters?: FeedFiltersWire } = {
    limit: options.limit ?? 20,
  };
  // Omit the key entirely on page one. Sending `cursor: null` is not the same.
  if (options.cursor !== undefined) body.cursor = options.cursor;
  if (options.liked === true) body.filters = { liked: 'True', trashed: 'False' };

  return client.request({
    method: 'POST',
    path: FEED_V3_PATH,
    body,
    schema: FeedPageSchema,
    endpointKey: 'feed.v3',
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Walk every page. Yields clips one at a time so a huge library stays streamable. */
export async function* iterateClips(
  client: SunoClient,
  options: { limit?: number; maxPages?: number; liked?: boolean; signal?: AbortSignal } = {},
): AsyncGenerator<Clip, void, undefined> {
  let cursor: string | undefined;
  let pages = 0;
  const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;

  while (pages < maxPages) {
    const page: FeedPage = await listClips(client, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.liked !== undefined ? { liked: options.liked } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    for (const clip of page.clips) yield clip;
    pages += 1;

    const next = page.next_cursor;
    // has_more can be absent; an empty page or a repeated cursor is the real
    // terminator. Trusting has_more alone risks an infinite loop.
    if (next === undefined || next === null || next === '' || next === cursor) return;
    if (page.clips.length === 0) return;
    cursor = next;
  }
}

export async function searchClips(
  client: SunoClient,
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<FeedPage> {
  return client.request({
    method: 'POST',
    path: FEED_V3_PATH,
    body: {
      limit: options.limit ?? 50,
      filters: { searchText: query, trashed: 'False' } satisfies FeedFiltersWire,
    },
    schema: FeedPageSchema,
    endpointKey: 'feed.v3',
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Fetch clips by id.
 *
 * Batched in pairs because Suno's feed-by-ids silently truncates: asking for 4+
 * ids that span different generation batches returns only the first two, so a
 * naive single call reports half your clips as missing and the poller waits
 * forever on ids that were finished all along.
 */
export async function getClips(
  client: SunoClient,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Clip[]> {
  const out: Clip[] = [];
  for (let i = 0; i < ids.length; i += 2) {
    const chunk = ids.slice(i, i + 2);
    const clips = await client.request({
      method: 'GET',
      path: FEED_BY_IDS_PATH,
      query: { ids: chunk.join(',') },
      schema: ClipsArraySchema,
      endpointKey: 'feed.byIds',
      ...(signal ? { signal } : {}),
    });
    out.push(...clips);
  }
  return out;
}

/**
 * One clip by id, from the endpoint suno.com's song page reads.
 *
 * Unlike feed-by-ids this is not limited to the account's own clips, and it
 * needs no session: a public clip answers anonymously with its `media_urls`,
 * so the result can go straight to `playTrack`. Measured 2026-10-23, the
 * account's own private clip answered anonymously too. Signed in, the session
 * is sent and the answer gains `is_download_unlocked`. An unknown id is a 404.
 */
export async function getClip(client: SunoClient, id: string, signal?: AbortSignal): Promise<Clip> {
  return requestWithSessionIfAny(client, {
    method: 'GET',
    path: `${CLIP_PATH}/${pathSegment(id)}`,
    schema: ClipSchema,
    endpointKey: 'clip.get',
    ...(signal ? { signal } : {}),
  });
}
