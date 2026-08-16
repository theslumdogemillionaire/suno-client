import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DriftBaselines } from '../client.js';
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
  'billing.info': ['total_credits_left', 'plan.name', 'models[].external_key', 'models[].name'],
  'captcha.check': ['required'],
  'lyrics.submit': ['id'],
  'lyrics.result': ['text', 'title', 'status'],
  'lyrics.aligned': ['aligned_words[].word', 'aligned_words[].start_s', 'aligned_words[].end_s'],
  'persona.get': ['persona.id', 'persona.name'],
};

const here = dirname(fileURLToPath(import.meta.url));

function baselineDir(): string {
  return join(here, 'baselines');
}

export function loadBaselines(dir: string = baselineDir()): Map<string, Baseline> {
  const map = new Map<string, Baseline>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // No baselines recorded yet. Drift detection simply stays quiet rather than
    // refusing to start: a fresh clone must still be able to make a request.
    return map;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Baseline;
      if (typeof parsed.endpoint === 'string') map.set(parsed.endpoint, parsed);
    } catch {
      // A corrupt baseline is not worth crashing over; it just stops guarding
      // that one endpoint.
    }
  }
  return map;
}

export function registryFromBaselines(dir?: string): DriftBaselines {
  const map = loadBaselines(dir);
  return {
    get: (key) => map.get(key),
    consumedPaths: (key) => CONSUMED_PATHS[key],
  };
}

export function registryFromMap(map: Map<string, Baseline>): DriftBaselines {
  return {
    get: (key) => map.get(key),
    consumedPaths: (key) => CONSUMED_PATHS[key],
  };
}
