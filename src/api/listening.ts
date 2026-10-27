/**
 * What the account has been listening to on Suno: its listen history, and the
 * player state suno.com keeps in sync between devices. Both need a session.
 */
import { z } from 'zod';

import type { SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { salvageClip } from '../internal/clip.js';
import { walkCursorPages } from '../internal/pages.js';
import type { Clip } from '../schemas.js';

export const LISTEN_HISTORY_PATH = '/api/profiles/listen-history';
export const PLAYBAR_STATE_PATH = '/api/music_player/playbar_state';

/**
 * Suno keeps the last 100 listens: on 2026-10-27, a limit of 100, 500 or 1000
 * returned 100 with `has_more: false`, and smaller pages stopped there too.
 */
export const LISTEN_HISTORY_MAX = 100;

const HistorySchema = z
  .object({
    history: z
      .array(z.object({ content: z.unknown(), listened_at: z.string().nullish() }).passthrough())
      .default([]),
    next_cursor: z.string().nullish(),
    has_more: z.boolean().nullish(),
  })
  .passthrough();

export interface Listen {
  clip: Clip;
  /** ISO time of the listen. */
  listenedAt: string | undefined;
}

export interface ListenHistoryPage {
  listens: Listen[];
  hasMore: boolean;
  nextCursor: string | undefined;
}

/** One page of the account's listens, newest first. */
export async function listListenHistory(
  client: SunoClient,
  options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<ListenHistoryPage> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > LISTEN_HISTORY_MAX) {
    throw new SunoError({
      code: 'invalid_input',
      message: `limit must be an integer from 1 to ${LISTEN_HISTORY_MAX}, got ${limit}`,
    });
  }
  const data = await client.request({
    method: 'GET',
    path: LISTEN_HISTORY_PATH,
    query: { limit, ...(options.cursor !== undefined ? { cursor: options.cursor } : {}) },
    schema: HistorySchema,
    endpointKey: 'listen.history',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const listens: Listen[] = [];
  // A song heard twice is two entries; one that no longer parses is dropped.
  for (const entry of data.history) {
    const clip = salvageClip(entry.content);
    if (clip) listens.push({ clip, listenedAt: entry.listened_at ?? undefined });
  }
  return { listens, hasMore: data.has_more === true, nextCursor: data.next_cursor ?? undefined };
}

/** Every listen Suno kept (the last 100), newest first. */
export function iterateListenHistory(
  client: SunoClient,
  options: { pageSize?: number; maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Listen, void, undefined> {
  return walkCursorPages<Listen>({
    fetchPage: async (cursor) => {
      const page = await listListenHistory(client, {
        limit: options.pageSize ?? LISTEN_HISTORY_MAX,
        ...(cursor !== undefined ? { cursor } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { items: page.listens, nextCursor: page.nextCursor, hasMore: page.hasMore };
    },
    // The same song can be heard several times: a listen is a song at a time.
    keyOf: (listen) => `${listen.clip.id}@${listen.listenedAt ?? ''}`,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  });
}

export const PlaybarStateSchema = z
  .object({
    /** `playing` or `paused`. */
    playbar_state: z.string().nullish(),
    song_ids_in_queue: z.array(z.string()).default([]),
    /** Position in `song_ids_in_queue` of the current song. */
    song_index: z.number().nullish(),
    /** Seconds into the current song. */
    song_play_time: z.number().nullish(),
    /** `no-repeat` was the one value seen. */
    repeat_state: z.string().nullish(),
    /** 0 to 100. */
    volume: z.number().nullish(),
    action_time: z.string().nullish(),
    device_id: z.string().nullish(),
    device_type: z.string().nullish(),
    context_id: z.string().nullish(),
    context_type: z.string().nullish(),
  })
  .passthrough();

export type PlaybarState = z.infer<typeof PlaybarStateSchema>;

/**
 * Where suno.com's player stands for this account: its queue, the song and the
 * second it is at, last saved by whichever device played. Read only here.
 */
export async function getPlaybarState(client: SunoClient, signal?: AbortSignal): Promise<PlaybarState> {
  return client.request({
    method: 'GET',
    path: PLAYBAR_STATE_PATH,
    schema: PlaybarStateSchema,
    endpointKey: 'player.state',
    ...(signal ? { signal } : {}),
  });
}
