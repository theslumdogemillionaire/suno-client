/**
 * Search across everyone's public songs: what suno.com's search box does.
 *
 * Not `searchClips`. That one filters the signed-in account's own library
 * through feed/v3 `searchText`; this one queries Suno's public index, and
 * finds other creators' songs.
 */
import { z } from 'zod';

import type { SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { salvageClips } from '../internal/clip.js';
import type { Clip } from '../schemas.js';

export const SEARCH_PATH = '/api/search';

/** The orderings `rank_by` was seen to accept on 2026-10-23. */
export const SEARCH_RANKINGS = ['most_relevant', 'play_count', 'trending'] as const;
export type SearchRanking = (typeof SEARCH_RANKINGS)[number];

/**
 * The largest `size` measured. It returned about 780 songs rather than 1000:
 * some are filtered out after the count.
 */
export const MAX_SEARCH_SIZE = 1000;

const SearchSectionSchema = z
  .object({
    total_hits: z.number().nullish(),
    /** Unparseable entries are dropped, so one odd song cannot fail the page. */
    result: z.array(z.unknown()).nullish().transform(salvageClips),
    from_index: z.number().nullish(),
    page_size: z.number().nullish(),
    tuned_count: z.number().nullish(),
  })
  .passthrough();

export const SearchResponseSchema = z
  .object({
    result: z.object({ tag_song: SearchSectionSchema.nullish() }).passthrough(),
  })
  .passthrough();

export interface PublicSearchOptions {
  /** Songs to ask for, 1 to 1000. Defaults to 20. */
  size?: number;
  /**
   * Offset into the ranking. Beyond roughly 200 the answer is empty: the index
   * serves a window, not the whole list, so deep paging does not work.
   */
  fromIndex?: number;
  /** Defaults to `most_relevant`. */
  rankBy?: SearchRanking;
  signal?: AbortSignal;
}

export interface PublicSearchPage {
  clips: Clip[];
  /** Matches in the index. Far more than can be paged through. */
  totalHits: number | undefined;
  fromIndex: number | undefined;
  pageSize: number | undefined;
}

export async function searchPublic(
  client: SunoClient,
  term: string,
  options: PublicSearchOptions = {},
): Promise<PublicSearchPage> {
  const size = options.size ?? 20;
  const fromIndex = options.fromIndex ?? 0;
  const rankBy = options.rankBy ?? 'most_relevant';
  if (term.trim() === '') {
    throw new SunoError({ code: 'invalid_input', message: 'a search term cannot be empty' });
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_SEARCH_SIZE) {
    throw new SunoError({ code: 'invalid_input', message: `size must be an integer from 1 to ${MAX_SEARCH_SIZE}, got ${size}` });
  }
  if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    throw new SunoError({ code: 'invalid_input', message: `fromIndex must be a non-negative integer, got ${fromIndex}` });
  }
  if (!SEARCH_RANKINGS.includes(rankBy)) {
    throw new SunoError({
      code: 'invalid_input',
      message: `rankBy must be one of ${SEARCH_RANKINGS.join(', ')}, got ${JSON.stringify(rankBy)}`,
    });
  }

  const data = await client.request({
    method: 'POST',
    path: SEARCH_PATH,
    body: {
      search_queries: [
        {
          name: 'tag_song',
          search_type: 'tag_song',
          term,
          from_index: fromIndex,
          size,
          rank_by: rankBy,
          is_public: true,
        },
      ],
    },
    schema: SearchResponseSchema,
    endpointKey: 'search.public',
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const section = data.result.tag_song;
  return {
    clips: section?.result ?? [],
    totalHits: section?.total_hits ?? undefined,
    fromIndex: section?.from_index ?? undefined,
    pageSize: section?.page_size ?? undefined,
  };
}
