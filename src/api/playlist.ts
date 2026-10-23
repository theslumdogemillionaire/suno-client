/**
 * Playlists: reading a public one, and managing the account's own.
 *
 * The public fetch is the same GET suno.com makes when anyone opens a share
 * link: no session, no download quota. Paging is `?page=N`. The payload is not
 * a feed/v3 page: clips live under `playlist_clips[].clip` and the playlist's
 * own order is `relative_index`.
 *
 * The writes need a session. Each one takes a flat body: the 422s they return
 * name `body.spec.*`, but as with `/api/gen/trash` those are server parameter
 * names, not an envelope to wrap the body in.
 */
import { z } from 'zod';

import type { SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { salvageClip } from '../internal/clip.js';
import { walkNumberedPages } from '../internal/pages.js';
import type { Clip } from '../schemas.js';

export const PLAYLIST_PATH = '/api/playlist';
export const MY_PLAYLISTS_PATH = '/api/playlist/me';
export const PLAYLIST_CREATE_PATH = '/api/playlist/create/';
export const PLAYLIST_UPDATE_CLIPS_PATH = '/api/playlist/update_clips/';
export const PLAYLIST_SET_METADATA_PATH = '/api/playlist/set_metadata/';
export const PLAYLIST_TRASH_PATH = '/api/playlist/trash/';
/**
 * A runaway guard, not a size limit: paging already ends on the first page
 * that adds nothing. Reaching it throws rather than returning part of the
 * playlist as if it were all of it, which is what a cap of 20 used to do.
 */
const MAX_PAGES = 500;

const PlaylistClipSchema = z
  .object({
    /** Position in the playlist. Can be fractional. */
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
    playlist_clips: z.array(PlaylistClipSchema).nullish(),
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

/**
 * A playlist as a summary: what `/api/playlist/me` lists, and what create and
 * set_metadata return (`entity_type: "playlist_schema"`).
 */
export const PlaylistSummarySchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    image_url: z.string().nullish(),
    entity_type: z.string().nullish(),
    is_public: z.boolean().nullish(),
    is_owned: z.boolean().nullish(),
    is_trashed: z.boolean().nullish(),
    num_total_results: z.number().nullish(),
    user_handle: z.string().nullish(),
  })
  .passthrough();

export type PlaylistSummary = z.infer<typeof PlaylistSummarySchema>;

export const MyPlaylistsPageSchema = z
  .object({
    playlists: z.array(PlaylistSummarySchema).default([]),
    num_total_results: z.number().nullish(),
    current_page: z.number().nullish(),
  })
  .passthrough();

export type MyPlaylistsPage = z.infer<typeof MyPlaylistsPageSchema>;

/** One clip in a playlist, with the position `removePlaylistClips` needs. */
export interface PlaylistEntry {
  clipId: string;
  /**
   * `relative_index` as Suno sent it, and undefined when it sent none. Never
   * made up: removing by a guessed index could take out a different song.
   */
  relativeIndex: number | undefined;
  clip: Clip;
}

export interface Playlist {
  id: string;
  name: string;
  userDisplayName: string | undefined;
  userHandle: string | undefined;
  totalDuration: number | undefined;
  clips: Clip[];
  /** The same clips, in the same order, each with its playlist position. */
  entries: PlaylistEntry[];
}

export interface GetPlaylistOptions {
  /**
   * Send the stored session. Off by default, since a shared playlist reads
   * without one. A playlist the account just created is private, and whether
   * an anonymous read can see a private one is unverified: read your own with
   * this on.
   */
  signedIn?: boolean;
  signal?: AbortSignal;
}

export async function getPlaylist(
  client: SunoClient,
  idOrUrl: string,
  options: GetPlaylistOptions = {},
): Promise<Playlist> {
  const pid = extractPlaylistId(idOrUrl);
  const entries: Array<{ pos: number; entry: PlaylistEntry }> = [];
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
      skipAuth: options.signedIn !== true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // The first page describes the playlist; a later page that omits the owner
    // fields must not erase them.
    meta ??= data;
    let added = 0;
    for (const item of data.playlist_clips ?? []) {
      const clip = salvageClip(item.clip);
      if (!clip || seen.has(clip.id)) continue;
      seen.add(clip.id);
      const relativeIndex = typeof item.relative_index === 'number' ? item.relative_index : undefined;
      // The fallback only orders the list. It is not an index Suno knows.
      const pos = relativeIndex ?? entries.length + 1;
      entries.push({ pos, entry: { clipId: clip.id, relativeIndex, clip } });
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
    clips: entries.map((e) => e.entry.clip),
    entries: entries.map((e) => e.entry),
  };
}

function emptyToUndef(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** One page of the signed-in account's playlists, trashed ones left out. */
export async function listMyPlaylists(
  client: SunoClient,
  options: { page?: number; signal?: AbortSignal } = {},
): Promise<MyPlaylistsPage> {
  const page = options.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    throw new SunoError({ code: 'invalid_input', message: `page must be an integer from 1, got ${page}` });
  }
  return client.request({
    method: 'GET',
    path: MY_PLAYLISTS_PATH,
    query: { page, show_trashed: false, show_sharelist: false },
    schema: MyPlaylistsPageSchema,
    endpointKey: 'playlist.mine',
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Every playlist the signed-in account owns, each once. */
export async function* iterateMyPlaylists(
  client: SunoClient,
  options: { maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<PlaylistSummary, void, undefined> {
  yield* walkNumberedPages<PlaylistSummary>({
    fetchPage: async (page) => {
      const data = await listMyPlaylists(client, { page, ...(options.signal ? { signal: options.signal } : {}) });
      return { items: data.playlists, total: data.num_total_results };
    },
    keyOf: (playlist) => playlist.id,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  });
}

function checkName(name: string): void {
  if (name.trim() === '') {
    throw new SunoError({ code: 'invalid_input', message: 'a playlist name cannot be empty' });
  }
}

function checkClipIds(clipIds: readonly string[]): void {
  if (clipIds.length === 0) {
    throw new SunoError({ code: 'invalid_input', message: 'name at least one clip' });
  }
  for (const id of clipIds) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new SunoError({ code: 'invalid_input', message: `not a usable clip id: ${JSON.stringify(id)}` });
    }
  }
}

/**
 * Create an empty playlist. It starts private (`is_public: false`).
 *
 * The name is checked here because the server does not check it: any body,
 * `{}` included, creates a playlist called "Untitled". Never retried, since a
 * replay after Suno created it would create a second one.
 */
export async function createPlaylist(
  client: SunoClient,
  name: string,
  signal?: AbortSignal,
): Promise<PlaylistSummary> {
  checkName(name);
  return client.request({
    method: 'POST',
    path: PLAYLIST_CREATE_PATH,
    body: { name },
    schema: PlaylistSummarySchema,
    endpointKey: 'playlist.create',
    retry: { maxRetries: 0 },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Append clips to a playlist. Never retried: a replay after the first attempt
 * landed would add them twice.
 */
export async function addPlaylistClips(
  client: SunoClient,
  playlistIdOrUrl: string,
  clipIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const pid = extractPlaylistId(playlistIdOrUrl);
  checkClipIds(clipIds);
  await client.request({
    method: 'POST',
    path: PLAYLIST_UPDATE_CLIPS_PATH,
    body: { playlist_id: pid, update_type: 'add', metadata: { clip_ids: [...clipIds] } },
    endpointKey: 'playlist.updateClips',
    retry: { maxRetries: 0 },
    ...(signal ? { signal } : {}),
  });
}

/**
 * Take entries out of a playlist.
 *
 * Suno removes by position as well as by id: without `indexes` it answers 400
 * `remove_indexes_invalid`, "Choose which songs to remove from the playlist."
 * So this takes `PlaylistEntry` values (from `getPlaylist(..., { signedIn:
 * true })`) rather than bare clip ids, and refuses an entry with no
 * `relativeIndex` rather than guess one. Never retried: positions move once a
 * removal lands.
 */
export async function removePlaylistClips(
  client: SunoClient,
  playlistIdOrUrl: string,
  entries: ReadonlyArray<Pick<PlaylistEntry, 'clipId' | 'relativeIndex'>>,
  signal?: AbortSignal,
): Promise<void> {
  const pid = extractPlaylistId(playlistIdOrUrl);
  checkClipIds(entries.map((e) => e.clipId));
  const indexes: number[] = [];
  for (const entry of entries) {
    if (typeof entry.relativeIndex !== 'number' || !Number.isFinite(entry.relativeIndex)) {
      throw new SunoError({
        code: 'invalid_input',
        message: `clip ${entry.clipId} has no relative_index; read the playlist again to get one`,
      });
    }
    indexes.push(entry.relativeIndex);
  }
  await client.request({
    method: 'POST',
    path: PLAYLIST_UPDATE_CLIPS_PATH,
    body: {
      playlist_id: pid,
      update_type: 'remove',
      metadata: { clip_ids: entries.map((e) => e.clipId), indexes },
    },
    endpointKey: 'playlist.updateClips',
    retry: { maxRetries: 0 },
    ...(signal ? { signal } : {}),
  });
}

export interface SetPlaylistMetadataOptions {
  name: string;
  /**
   * Required by the server along with `name`. Pass the current one to change
   * only the name.
   */
  description: string;
  signal?: AbortSignal;
}

/** Rename a playlist and set its description. Returns the updated playlist. */
export async function setPlaylistMetadata(
  client: SunoClient,
  playlistIdOrUrl: string,
  options: SetPlaylistMetadataOptions,
): Promise<PlaylistSummary> {
  const pid = extractPlaylistId(playlistIdOrUrl);
  checkName(options.name);
  if (typeof options.description !== 'string') {
    throw new SunoError({ code: 'invalid_input', message: 'description is required by the server along with name' });
  }
  return client.request({
    method: 'POST',
    path: PLAYLIST_SET_METADATA_PATH,
    body: { playlist_id: pid, name: options.name, description: options.description },
    schema: PlaylistSummarySchema,
    endpointKey: 'playlist.setMetadata',
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/**
 * Move a playlist to trash, or bring it back.
 *
 * Trashing (`undo_trash: false`) is verified. Restoring sends
 * `undo_trash: true`, which is what the field name implies and has not been
 * observed working.
 */
export async function setPlaylistTrashed(
  client: SunoClient,
  playlistIdOrUrl: string,
  trashed: boolean,
  signal?: AbortSignal,
): Promise<void> {
  await client.request({
    method: 'POST',
    path: PLAYLIST_TRASH_PATH,
    body: { playlist_id: extractPlaylistId(playlistIdOrUrl), undo_trash: !trashed },
    endpointKey: 'playlist.trash',
    ...(signal ? { signal } : {}),
  });
}
