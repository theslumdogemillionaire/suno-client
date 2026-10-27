/**
 * Public profiles, and who follows whom.
 *
 * Profiles read without a session, the way suno.com shows one to anyone who
 * opens it. The follow lists do not: anonymous, they answer 401. All of it
 * pages by `?page=N`, 20 items to a page, with no cursor.
 */
import { z } from 'zod';

import { pathSegment, type SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { salvageClips } from '../internal/clip.js';
import { walkNumberedPages } from '../internal/pages.js';
import { requestWithSessionIfAny } from '../internal/session.js';
import type { Clip } from '../schemas.js';

export const PROFILES_PATH = '/api/profiles';
export const FOLLOW_PATH = '/api/profiles/follow';

/**
 * Clips and profiles per page, as observed on 2026-10-23. A profile's first
 * page holds its pinned clips on top of these 20.
 */
export const PROFILE_PAGE_SIZE = 20;

const ProfileStatsSchema = z
  .object({
    upvote_count__sum: z.number().nullish(),
    play_count__sum: z.number().nullish(),
    followers_count: z.number().nullish(),
    following_count: z.number().nullish(),
  })
  .passthrough();

export const ProfilePageSchema = z
  .object({
    user_id: z.string().nullish(),
    display_name: z.string().nullish(),
    handle: z.string(),
    profile_description: z.string().nullish(),
    avatar_image_url: z.string().nullish(),
    /** One page of the creator's public clips. Unparseable entries are dropped. */
    clips: z.array(z.unknown()).nullish().transform(salvageClips),
    stats: ProfileStatsSchema.nullish(),
    is_flagged: z.boolean().nullish(),
    is_verified: z.boolean().nullish(),
    /** Whether this account follows the profile. Always false signed out. */
    is_following: z.boolean().nullish(),
    /**
     * Counts pinned clips again, so it cannot be compared with a running
     * total of clips seen across pages.
     */
    num_total_clips: z.number().nullish(),
    current_page: z.number().nullish(),
    playlists: z.array(z.unknown()).nullish(),
    favorite_songs: z.array(z.unknown()).nullish(),
    personas: z.array(z.unknown()).nullish(),
  })
  .passthrough();

export type ProfilePage = z.infer<typeof ProfilePageSchema>;

/**
 * One entry of a follow list (`entity_type: "simple_profile_schema"`).
 *
 * `user_id` is not typed: it reads `-1` on every entry measured. The real
 * account id is `external_user_id`.
 */
export const ProfileSummarySchema = z
  .object({
    handle: z.string(),
    display_name: z.string().nullish(),
    external_user_id: z.string().nullish(),
    avatar_image_url: z.string().nullish(),
    entity_type: z.string().nullish(),
    is_following: z.boolean().nullish(),
    is_verified: z.boolean().nullish(),
    stats: z.record(z.unknown()).nullish(),
  })
  .passthrough();

export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;

export const FollowPageSchema = z
  .object({
    user_id: z.string().nullish(),
    handle: z.string().nullish(),
    profiles: z.array(ProfileSummarySchema).default([]),
    current_page: z.number().nullish(),
    num_total_profiles: z.number().nullish(),
  })
  .passthrough();

export type FollowPage = z.infer<typeof FollowPageSchema>;

export interface ProfileOptions {
  /** 1-based. */
  page?: number;
  /** `clips_sort_by`. Defaults to `created_at`, newest first, as suno.com does. */
  clipsSortBy?: string;
  /** `playlists_sort_by`. Defaults to `upvote_count`. */
  playlistsSortBy?: string;
  signal?: AbortSignal;
}

function checkHandle(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed === '') {
    throw new SunoError({ code: 'invalid_input', message: 'a profile handle cannot be empty' });
  }
  return trimmed;
}

function checkPage(page: number): number {
  if (!Number.isInteger(page) || page < 1) {
    throw new SunoError({ code: 'invalid_input', message: `page must be an integer from 1, got ${page}` });
  }
  return page;
}

/**
 * One page of a public profile: who it is, its stats, and a page of its clips.
 *
 * Needs no session. With one, it is sent, so `is_following` says whether this
 * account follows the profile. All three query parameters are required by the
 * server: leaving out `playlists_sort_by` answers 422.
 */
export async function getProfile(
  client: SunoClient,
  handle: string,
  options: ProfileOptions = {},
): Promise<ProfilePage> {
  return requestWithSessionIfAny(client, {
    method: 'GET',
    path: `${PROFILES_PATH}/${pathSegment(checkHandle(handle))}`,
    query: {
      page: checkPage(options.page ?? 1),
      playlists_sort_by: options.playlistsSortBy ?? 'upvote_count',
      clips_sort_by: options.clipsSortBy ?? 'created_at',
    },
    schema: ProfilePageSchema,
    endpointKey: 'profile.get',
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Every public clip on a profile, each once.
 *
 * Pinned clips sit on top of page one and appear again further down, so clips
 * are deduplicated by id, and `num_total_clips` is not used as a stop: it
 * counts them twice. The walk ends on an empty or short page instead.
 */
export async function* iterateProfileClips(
  client: SunoClient,
  handle: string,
  options: { clipsSortBy?: string; maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Clip, void, undefined> {
  const name = checkHandle(handle);
  yield* walkNumberedPages<Clip>({
    fetchPage: async (page) => ({
      items: (
        await getProfile(client, name, {
          page,
          ...(options.clipsSortBy !== undefined ? { clipsSortBy: options.clipsSortBy } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      ).clips,
    }),
    keyOf: (clip) => clip.id,
    pageSize: PROFILE_PAGE_SIZE,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  });
}

type FollowDirection = 'following' | 'followers';

async function listFollows(
  client: SunoClient,
  handle: string,
  direction: FollowDirection,
  options: { page?: number; signal?: AbortSignal },
): Promise<FollowPage> {
  return client.request({
    method: 'GET',
    path: `${PROFILES_PATH}/${pathSegment(checkHandle(handle))}/${direction}`,
    query: { page: checkPage(options.page ?? 1) },
    schema: FollowPageSchema,
    endpointKey: `profile.${direction}`,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function* iterateFollows(
  client: SunoClient,
  handle: string,
  direction: FollowDirection,
  options: { maxPages?: number; signal?: AbortSignal },
): AsyncGenerator<ProfileSummary, void, undefined> {
  const name = checkHandle(handle);
  yield* walkNumberedPages<ProfileSummary>({
    fetchPage: async (page) => {
      const data = await listFollows(client, name, direction, {
        page,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { items: data.profiles, total: data.num_total_profiles };
    },
    keyOf: (profile) => profile.handle,
    pageSize: PROFILE_PAGE_SIZE,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  });
}

/** One page of the profiles `handle` follows. Needs a session. */
export function listFollowing(
  client: SunoClient,
  handle: string,
  options: { page?: number; signal?: AbortSignal } = {},
): Promise<FollowPage> {
  return listFollows(client, handle, 'following', options);
}

/** One page of the profiles following `handle`. Needs a session. */
export function listFollowers(
  client: SunoClient,
  handle: string,
  options: { page?: number; signal?: AbortSignal } = {},
): Promise<FollowPage> {
  return listFollows(client, handle, 'followers', options);
}

export function iterateFollowing(
  client: SunoClient,
  handle: string,
  options: { maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<ProfileSummary, void, undefined> {
  return iterateFollows(client, handle, 'following', options);
}

export function iterateFollowers(
  client: SunoClient,
  handle: string,
  options: { maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<ProfileSummary, void, undefined> {
  return iterateFollows(client, handle, 'followers', options);
}

/**
 * Follow a profile, or stop following it.
 *
 * Verified 2026-10-23 through `is_following` on the profile. The body names
 * the handle, not the path, and the answer is empty. Sets a state, so a replay
 * is harmless.
 */
export async function setFollowing(
  client: SunoClient,
  handle: string,
  follow: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: 'POST',
    path: FOLLOW_PATH,
    body: { handle: checkHandle(handle), unfollow: !follow },
    endpointKey: 'profile.follow',
    ...(signal ? { signal } : {}),
  });
}

const RemixesInspiredSchema = z
  .object({
    clips: z.array(z.unknown()).nullish().transform(salvageClips),
    current_page: z.number().nullish(),
    total_pages: z.number().nullish(),
    total_count: z.number().nullish(),
  })
  .passthrough();

export type RemixesInspiredPage = z.infer<typeof RemixesInspiredSchema>;

/**
 * One page of the songs others made from this creator's songs: remixes,
 * covers, extends. Needs a session. `pageSize` defaults to 20.
 */
export async function listRemixesInspired(
  client: SunoClient,
  handle: string,
  options: { page?: number; pageSize?: number; signal?: AbortSignal } = {},
): Promise<RemixesInspiredPage> {
  const pageSize = options.pageSize ?? PROFILE_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new SunoError({ code: 'invalid_input', message: `pageSize must be a positive integer, got ${pageSize}` });
  }
  return client.request({
    method: 'GET',
    path: `${PROFILES_PATH}/${pathSegment(checkHandle(handle))}/remixes-inspired`,
    query: { page: checkPage(options.page ?? 1), page_size: pageSize },
    schema: RemixesInspiredSchema,
    endpointKey: 'profile.remixesInspired',
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Every song others made from this creator's songs, each once. */
export function iterateRemixesInspired(
  client: SunoClient,
  handle: string,
  options: { pageSize?: number; maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Clip, void, undefined> {
  const name = checkHandle(handle);
  const pageSize = options.pageSize ?? PROFILE_PAGE_SIZE;
  return walkNumberedPages<Clip>({
    fetchPage: async (page) => {
      const data = await listRemixesInspired(client, name, {
        page,
        pageSize,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { items: data.clips, total: data.total_count };
    },
    keyOf: (clip) => clip.id,
    pageSize,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  });
}
