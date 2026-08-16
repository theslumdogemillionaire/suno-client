/**
 * Record response-shape baselines from live traffic.
 *
 *   SUNO_COOKIE=... npx tsx scripts/record-baselines.ts
 *
 * Run this after a deliberate, verified update to the client, and commit the
 * result. The baselines are what the drift detector compares against, so a
 * baseline recorded from a broken response bakes the breakage in as normal.
 *
 * Several samples per endpoint on purpose: a field seen in every sample is
 * load-bearing, one seen in some is optional. That distinction is the whole
 * reason the detector does not scream every time a clip is still queued.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { billingInfo, captchaCheck, generateLyrics } from '../src/api/misc.js';
import { getClips, listClips } from '../src/api/feed.js';
import { SunoClient } from '../src/client.js';
import { emptyBaseline, foldIntoBaseline, type Baseline } from '../src/drift/shape.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src', 'drift', 'baselines');
const recordedAt = new Date().toISOString();

/** Matches DEFAULT_MIN_SAMPLES in the detector: fewer, and it cannot tell a
 * required field from a coincidence. */
const MIN_SAMPLES = 5;

const cookie = process.env['SUNO_COOKIE'];
const samples = new Map<string, unknown[]>();

// The client hands callers parsed, validated objects, not raw payloads, so we
// record through a fetch wrapper rather than adding a debug hook to production
// code that would exist only for this script.
const recording = new SunoClient({
  ...(cookie ? { cookie } : {}),
  fetch: async (input, init) => {
    const res = await fetch(input, init);
    const clone = res.clone();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const key = endpointKeyFor(url);
    if (key !== undefined && res.ok) {
      try {
        const body: unknown = await clone.json();
        samples.set(key, [...(samples.get(key) ?? []), body]);
      } catch {
        // Not JSON. Nothing to fingerprint.
      }
    }
    return res;
  },
});

function endpointKeyFor(url: string): string | undefined {
  const path = new URL(url).pathname;
  if (path === '/api/billing/info/') return 'billing.info';
  if (path === '/api/c/check') return 'captcha.check';
  if (path === '/api/feed/v3') return 'feed.v3';
  if (path === '/api/feed/') return 'feed.byIds';
  if (path === '/api/generate/lyrics/') return 'lyrics.submit';
  if (path.startsWith('/api/generate/lyrics/')) return 'lyrics.result';
  if (path.endsWith('/aligned_lyrics/v2/')) return 'lyrics.aligned';
  return undefined;
}

async function main(): Promise<void> {
  console.log('sampling live responses...');

  // At least MIN_SAMPLES of everything. The detector only treats a field as
  // load-bearing once it has been present in every sample of a large enough
  // baseline, so a thin recording produces false alarms rather than warnings.
  for (let i = 0; i < MIN_SAMPLES; i++) await billingInfo(recording);
  for (let i = 0; i < MIN_SAMPLES; i++) await captchaCheck(recording);

  // Walk several pages: clips differ in age, model and completeness, and the
  // point of multiple samples is to learn which fields vary.
  let cursor: string | undefined;
  const seenClipIds: string[] = [];
  for (let page = 0; page < MIN_SAMPLES; page++) {
    const result = await listClips(recording, {
      limit: 20,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    seenClipIds.push(...result.clips.map((c) => c.id));
    const next = result.next_cursor;
    if (typeof next !== 'string' || next === '' || next === cursor) break;
    cursor = next;
  }

  // Sample clips in a few states so the baseline learns which fields are
  // genuinely optional (a queued clip has no audio_url; a complete one does).
  for (let i = 0; i < Math.min(MIN_SAMPLES, seenClipIds.length); i++) {
    await getClips(recording, [seenClipIds[i] as string]);
  }
  for (const id of seenClipIds.slice(0, MIN_SAMPLES)) {
    await recording
      .request({ method: 'GET', path: `/api/gen/${id}/aligned_lyrics/v2/`, endpointKey: 'lyrics.aligned' })
      .catch(() => undefined);
  }

  for (const prompt of [
    'a short bright song about morning light',
    'a slow song about a long train ride',
    'a calm song about rain on a window',
    'a warm song about an old friend',
    'a quiet song about the last bus home',
  ]) {
    await generateLyrics(recording, prompt).catch(() => undefined);
  }

  mkdirSync(outDir, { recursive: true });
  for (const [endpoint, values] of samples) {
    const baseline = values.reduce<Baseline>(
      (acc, v) => foldIntoBaseline(acc, v),
      emptyBaseline(endpoint, recordedAt),
    );
    writeFileSync(join(outDir, `${endpoint}.json`), `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`  ${endpoint.padEnd(16)} ${baseline.samples} samples, ${Object.keys(baseline.paths).length} paths`);
  }
  console.log(`\nwrote ${samples.size} baselines to ${outDir}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
