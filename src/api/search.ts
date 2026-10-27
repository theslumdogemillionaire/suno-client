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
import { salvageClip, salvageClips } from '../internal/clip.js';
import type { Clip } from '../schemas.js';
import { ProfileSummarySchema, type ProfileSummary } from './profile.js';

export const SEARCH_PATH = '/api/search';
export const SUGGEST_PATH = '/api/unified/search/suggest';

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

/**
 * What suno.com's search box offers while typing: a mix of styles, creators,
 * playlists and songs, best match first.
 *
 * `profile` and `playlist` are Suno's `creator_profile` and
 * `playlist_shortcut`. A kind not known here comes back as `other`, untouched.
 */
export type Suggestion =
  | { kind: 'style'; style: string; image: string | undefined; reason: string | undefined }
  | { kind: 'profile'; profile: ProfileSummary; reason: string | undefined }
  | { kind: 'playlist'; playlist: SuggestedPlaylist; reason: string | undefined }
  | { kind: 'clip'; clip: Clip; reason: string | undefined }
  | { kind: 'other'; contentType: string; id: string | undefined; item: unknown };

export interface SuggestedPlaylist {
  id: string;
  name: string | undefined;
  image: string | undefined;
  songCount: number | undefined;
  handle: string | undefined;
  displayName: string | undefined;
}

const SuggestItemSchema = z
  .object({
    content_type: z.string(),
    content_id: z.string().nullish(),
    /** `self_name`, `from_matched_creator`, `from_matched_genre`. */
    match_reason: z.string().nullish(),
    content_item: z.unknown(),
  })
  .passthrough();

const SuggestResponseSchema = z
  .object({ feed: z.object({ items: z.array(SuggestItemSchema).default([]) }).passthrough() })
  .passthrough();

const SuggestedPlaylistSchema = z
  .object({
    playlist_id: z.string(),
    playlist_name: z.string().nullish(),
    playlist_image_url: z.string().nullish(),
    playlist_song_count: z.number().nullish(),
    playlist_user_handle: z.string().nullish(),
    playlist_user_display_name: z.string().nullish(),
  })
  .passthrough();

const StyleItemSchema = z.object({ genre: z.string(), image: z.string().nullish() }).passthrough();

function toSuggestion(item: z.infer<typeof SuggestItemSchema>): Suggestion | undefined {
  const reason = item.match_reason ?? undefined;
  const other = { kind: 'other', contentType: item.content_type, id: item.content_id ?? undefined, item: item.content_item } as const;
  switch (item.content_type) {
    case 'genre': {
      const style = StyleItemSchema.safeParse(item.content_item);
      return style.success ? { kind: 'style', style: style.data.genre, image: style.data.image ?? undefined, reason } : other;
    }
    case 'creator_profile': {
      const profile = ProfileSummarySchema.safeParse(item.content_item);
      return profile.success ? { kind: 'profile', profile: profile.data, reason } : other;
    }
    case 'playlist_shortcut': {
      const p = SuggestedPlaylistSchema.safeParse(item.content_item);
      if (!p.success) return other;
      return {
        kind: 'playlist',
        reason,
        playlist: {
          id: p.data.playlist_id,
          name: p.data.playlist_name ?? undefined,
          image: p.data.playlist_image_url ?? undefined,
          songCount: p.data.playlist_song_count ?? undefined,
          handle: p.data.playlist_user_handle ?? undefined,
          displayName: p.data.playlist_user_display_name ?? undefined,
        },
      };
    }
    case 'clip': {
      const clip = salvageClip(item.content_item);
      return clip ? { kind: 'clip', clip, reason } : undefined;
    }
    default:
      return other;
  }
}

export interface SuggestOptions {
  /** Styles, creators and playlists to ask for. Defaults to 5. */
  suggestions?: number;
  /** Songs to ask for. Defaults to 5. */
  songs?: number;
  signal?: AbortSignal;
}

/** Suggestions for a partial search term. Needs a session: 401 anonymous. */
export async function searchSuggest(
  client: SunoClient,
  term: string,
  options: SuggestOptions = {},
): Promise<Suggestion[]> {
  if (term.trim() === '') {
    throw new SunoError({ code: 'invalid_input', message: 'a search term cannot be empty' });
  }
  for (const [name, value] of [['suggestions', options.suggestions ?? 5], ['songs', options.songs ?? 5]] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new SunoError({ code: 'invalid_input', message: `${name} must be a non-negative integer, got ${value}` });
    }
  }
  const data = await client.request({
    method: 'POST',
    path: SUGGEST_PATH,
    body: { term, suggestion_size: options.suggestions ?? 5, content_size: options.songs ?? 5 },
    schema: SuggestResponseSchema,
    endpointKey: 'search.suggest',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const out: Suggestion[] = [];
  for (const item of data.feed.items) {
    const suggestion = toSuggestion(item);
    if (suggestion) out.push(suggestion);
  }
  return out;
}
