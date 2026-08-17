import type { SunoClient } from '../client.js';
import { z } from 'zod';

/**
 * The endpoints the web app uses to render a song page, which no unofficial
 * client exposes because none of them were in the reverse-engineering notes
 * everyone copies from each other.
 *
 * Captured on 2026-08-17 by watching suno.com's own network traffic while
 * opening a track. They are the difference between "a bot that posts an mp3
 * link" and "an overlay that moves with the music": a beat grid, the detected
 * key, and a pre-computed waveform at several resolutions.
 */

export const DownbeatsSchema = z
  .object({
    state: z.string(),
    /** `[timeSeconds, beatNumber]`, where beat 1 is the downbeat of a bar. */
    downbeats: z.array(z.tuple([z.number(), z.number()]).rest(z.number())).default([]),
  })
  .passthrough();

export type Downbeats = z.infer<typeof DownbeatsSchema>;

export const MusicalKeySchema = z
  .object({
    state: z.string(),
    key: z.string().nullish(),
    mode: z.string().nullish(),
    confidence: z.number().nullish(),
  })
  .passthrough();

export type MusicalKey = z.infer<typeof MusicalKeySchema>;

export const WaveformSchema = z
  .object({
    waveform_aggregates: z
      .array(
        z
          .object({
            /** Higher level = coarser. Pick by how many pixels wide you draw. */
            mip_map_level: z.number(),
            /** Interleaved min/max pairs, 16-bit-ish signed range. */
            data: z.array(z.array(z.number())).default([]),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export type Waveform = z.infer<typeof WaveformSchema>;

/**
 * Beat grid.
 *
 * `state` is `running` while Suno is still analysing, so poll or fall back to
 * `avg_bpm` from the clip metadata. Each entry is `[seconds, beatInBar]`, and
 * the entries where beatInBar is 1 are the bar lines: that is what you sync a
 * visual to, not a fixed BPM interval, because Suno's tempo drifts.
 */
export async function getDownbeats(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<Downbeats> {
  return client.request({
    method: 'GET',
    path: `/api/gen/${clipId}/downbeats`,
    schema: DownbeatsSchema,
    endpointKey: 'media.downbeats',
    ...(signal ? { signal } : {}),
  });
}

/** Detected musical key. `state: "running"` means analysis is not finished. */
export async function getMusicalKey(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<MusicalKey> {
  return client.request({
    method: 'GET',
    path: `/api/gen/${clipId}/key`,
    schema: MusicalKeySchema,
    endpointKey: 'media.key',
    ...(signal ? { signal } : {}),
  });
}

/**
 * Pre-computed waveform at several mip-map levels.
 *
 * Saves downloading and decoding the MP3 just to draw a scrubber: pick the
 * level closest to your pixel width and render the min/max pairs directly.
 */
export async function getWaveform(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<Waveform> {
  return client.request({
    method: 'GET',
    path: `/api/gen/${clipId}/waveform-aggregates`,
    schema: WaveformSchema,
    endpointKey: 'media.waveform',
    ...(signal ? { signal } : {}),
  });
}

export const StemPagesSchema = z.object({ pages: z.number() }).passthrough();

/** How many pages of separated stems exist for a clip. 0 means none yet. */
export async function getStemPages(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<number> {
  const body = await client.request({
    method: 'GET',
    path: `/api/clip/${clipId}/stems/pages`,
    schema: StemPagesSchema,
    endpointKey: 'media.stemPages',
    ...(signal ? { signal } : {}),
  });
  return body.pages;
}

/** Bar lines only, in seconds. The useful subset of the beat grid. */
export function barLines(downbeats: Downbeats): number[] {
  return downbeats.downbeats.filter((d) => d[1] === 1).map((d) => d[0]);
}

/** Tempo implied by the beat grid, which is more honest than a single avg_bpm. */
export function tempoFromDownbeats(downbeats: Downbeats): number | undefined {
  const beats = downbeats.downbeats;
  if (beats.length < 2) return undefined;
  const first = beats[0];
  const last = beats[beats.length - 1];
  if (!first || !last) return undefined;
  const span = last[0] - first[0];
  if (span <= 0) return undefined;
  return ((beats.length - 1) / span) * 60;
}
