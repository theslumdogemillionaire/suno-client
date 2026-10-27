import type { DriftBaselines } from '../client.js';
import { BUNDLED_BASELINES } from './baselines.generated.js';
import type { Baseline } from './shape.js';

/**
 * Paths this client actually reads, per endpoint.
 *
 * A change under one of these breaks us and is an `error`. A change anywhere
 * else is Suno shipping something we do not use yet, and is at most a `warn`.
 * Keeping this list honest is what stops the drift detector from becoming
 * background noise everyone mutes.
 */
export const CONSUMED_PATHS: Record<string, readonly string[]> = {
  generate: ['clips[].id', 'clips[].status', 'clips[].title', 'clips[].audio_url', 'status'],
  'feed.v3': [
    'clips[].id',
    'clips[].status',
    'clips[].title',
    'clips[].audio_url',
    'clips[].created_at',
    'clips[].model_name',
    'next_cursor',
    'has_more',
  ],
  'feed.byIds': [
    '[].id',
    '[].status',
    '[].title',
    '[].audio_url',
    '[].created_at',
    '[].metadata.duration',
  ],
  // `plan.name` is deliberately NOT here. It is absent on a Free account, so
  // listing it would flag every Free-tier billing response as an error-severity
  // break of a path we read - the exact background noise that gets a drift
  // detector muted. The tier is derived in api/account.ts instead.
  'billing.info': [
    'total_credits_left',
    'models[].external_key',
    'models[].name',
    'models[].can_use',
  ],
  'captcha.check': ['required'],
  'lyrics.submit': ['id'],
  'lyrics.result': ['text', 'title', 'status'],
  'lyrics.aligned': ['aligned_words[].word', 'aligned_words[].start_s', 'aligned_words[].end_s'],
  'persona.get': ['persona.id', 'persona.name'],
  'playlist.get': [
    'name',
    'num_total_results',
    'playlist_clips[].relative_index',
    'playlist_clips[].clip.id',
    'playlist_clips[].clip.media_urls[].url',
  ],
  'mango.rights': ['key', 'iv', 'glt'],
  'clip.get': ['id', 'status', 'title', 'created_at', 'model_name', 'media_urls[].url'],
  'profile.get': ['handle', 'clips[].id'],
  'profile.following': ['profiles[].handle'],
  'profile.followers': ['profiles[].handle'],
  'playlist.mine': ['playlists[].id', 'num_total_results'],
  'search.public': ['result.tag_song.result[].id', 'result.tag_song.total_hits'],
  'search.suggest': ['feed.items[].content_type', 'feed.items[].content_item'],
  'clips.similar': ['similar_clips[].id'],
  'clips.remixes': ['remixes[].id', 'has_more', 'next_cursor'],
  'clips.remixCount': ['count'],
  'clips.attribution': ['source_clips[].clip_id'],
  'clips.parent': ['is_public'],
  'clip.comments': ['results[].id', 'results[].content', 'next_cursor'],
  'listen.history': ['history[].content.id', 'history[].listened_at', 'next_cursor', 'has_more'],
  'player.state': ['song_ids_in_queue', 'song_index', 'song_play_time'],
  'notifications.list': ['notifications[].id', 'notifications[].text[].text'],
  'notifications.badge': ['badge_count'],
  'profile.remixesInspired': ['clips[].id', 'total_count'],
};

/**
 * The baselines shipped with this release, as data compiled into the module.
 *
 * Deliberately not read from disk. Locating them by module path needed
 * `import.meta.url`, which is ESM-only and rules out a CommonJS build, and it
 * had already shipped once with drift detection silently inert because tsc does
 * not copy .json files into the build output. Data in the module graph cannot go
 * missing.
 */
export function loadBaselines(): Map<string, Baseline> {
  const map = new Map<string, Baseline>();
  for (const baseline of BUNDLED_BASELINES) {
    if (typeof baseline.endpoint === 'string') map.set(baseline.endpoint, baseline);
  }
  return map;
}

export function registryFromBaselines(): DriftBaselines {
  return registryFromMap(loadBaselines());
}

export function registryFromMap(map: Map<string, Baseline>): DriftBaselines {
  return {
    get: (key) => map.get(key),
    consumedPaths: (key) => CONSUMED_PATHS[key],
  };
}

/**
 * Load baselines from a directory instead of the bundled set.
 *
 * For anyone recording their own against a different account, or pinning an
 * older set. Node-only and dynamically imported so the bundled path stays free
 * of any filesystem dependency.
 */
export async function registryFromDirectory(dir: string): Promise<DriftBaselines> {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const map = new Map<string, Baseline>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Baseline;
      if (typeof parsed.endpoint === 'string') map.set(parsed.endpoint, parsed);
    } catch {
      // A corrupt file stops guarding that one endpoint, nothing more.
    }
  }
  return registryFromMap(map);
}
