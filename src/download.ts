import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import NodeID3 from 'node-id3';

import { alignedLyrics } from './api/misc.js';
import { resolveDownloadUrl, type DownloadFormat } from './api/download-unlock.js';
import type { SunoClient } from './client.js';
import { SunoError } from './errors.js';
import { isFetchableUrl, type AlignedWord, type Clip } from './schemas.js';

export interface DownloadOptions {
  /** Directory. Created if missing. */
  outputDir: string;
  /** Grab the mp4 instead of the mp3, when the clip has one. */
  video?: boolean;
  /**
   * Write ID3 tags, including word-level synchronised lyrics when available.
   * Costs one extra request per clip; skip it for bulk archival.
   */
  embedTags?: boolean;
  /**
   * Fetch the cover art and embed it as the APIC frame, so the file shows its
   * artwork in any player. One extra request. On by default when tagging.
   */
  embedArtwork?: boolean;
  /** Also save the cover art next to the audio as `<same-name>.jpeg`. */
  saveArtwork?: boolean;
  signal?: AbortSignal;
  onProgress?: (info: { clipId: string; bytes: number }) => void;
}

/** Filesystems cap a path component at 255 bytes; leave room for the id
 * suffix, the extension and the `.part` we write to first. */
const MAX_SLUG_LENGTH = 180;

/**
 * `<title-slug>-<first 8 of id>.<ext>`.
 *
 * The id suffix is not decoration: Suno returns two clips per generation with
 * identical titles, so a title-only filename means the second download silently
 * overwrites the first.
 */
export function clipFilename(title: string, id: string, ext: string): string {
  // Normalise first. toLowerCase() can *manufacture* combining marks (U+0130
  // becomes i + U+0307), and NFD input has them anyway, so without this a
  // title like "İstanbul" slugs to "i-stanbul" and "Déjà Vu" to "de-ja-vu".
  let slug = '';
  for (const ch of title.toLowerCase().normalize('NFC')) {
    if (/[\p{L}\p{N}\p{M}]/u.test(ch)) {
      slug += ch;
    } else if (slug !== '' && !slug.endsWith('-')) {
      slug += '-';
    }
  }
  if (slug.length > MAX_SLUG_LENGTH) slug = slug.slice(0, MAX_SLUG_LENGTH);
  while (slug.endsWith('-')) slug = slug.slice(0, -1);
  const shortId = id.slice(0, 8);
  return slug === '' ? `${shortId}.${ext}` : `${slug}-${shortId}.${ext}`;
}

/**
 * Where the bytes actually come from, in the order they are worth trying.
 *
 * Until 2026-09-10 there was only one answer and it was `audio_url`. Now that
 * field is a 403 sentinel on every clip in a library, so the real source is
 * Suno's own download endpoint — the one behind the button in the web app —
 * and reaching it is free for a clip whose download is already unlocked.
 *
 * `audio_url` is still tried first, and not out of nostalgia: it costs one
 * cheap string test, it is the only path that works without a second round
 * trip, and if Suno ever serves audio from it again this keeps working with no
 * change. `media_urls` is never consulted, here or anywhere: it answers 200 and
 * its payload is encrypted, so a fallback to it would write a corrupt file
 * instead of raising a clear error.
 */
async function resolveSource(
  client: SunoClient,
  clip: Clip,
  options: DownloadOptions,
): Promise<{ url: string; ext: string }> {
  const video = options.video ?? false;
  const legacy = video ? clip.video_url : clip.audio_url;
  if (isFetchableUrl(legacy)) return { url: legacy, ext: video ? 'mp4' : 'mp3' };

  // Nothing to download yet, as opposed to nothing we are allowed to download.
  // Kept distinct because one resolves by waiting and the other by paying.
  // An unlocked clip is exempt: `video_url` is empty string on clips that have
  // a perfectly downloadable mp3, so an emptiness check alone would refuse the
  // very clips someone has already paid to unlock.
  const unlocked = clip.is_download_unlocked === true;
  if (!unlocked && (legacy === undefined || legacy === null || legacy === '')) {
    throw new SunoError({
      code: 'not_found',
      message: `clip ${clip.id} has no ${video ? 'video' : 'audio'} URL (status: ${clip.status})`,
    });
  }

  const format: DownloadFormat = video ? 'mp4' : 'mp3';
  const url = await resolveDownloadUrl(client, clip.id, {
    format,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { url, ext: format };
}

/** Word timings to an LRC-style SYLT payload. */
export function toSyncedLyrics(words: readonly AlignedWord[]): Array<{ text: string; timeStamp: number }> {
  return words.map((w) => ({ text: w.word, timeStamp: Math.round(w.start_s * 1000) }));
}

export async function downloadClip(
  client: SunoClient,
  clip: Clip,
  options: DownloadOptions,
): Promise<string> {
  const { url, ext } = await resolveSource(client, clip, options);
  await mkdir(options.outputDir, { recursive: true });
  const target = join(options.outputDir, clipFilename(clip.title, clip.id, ext));
  // Download to a temp name and rename on success, so an interrupted transfer
  // never leaves a truncated mp3 that looks like a finished download.
  const tmp = `${target}.part`;

  const res = await fetch(url, options.signal ? { signal: options.signal } : {});
  if (!res.ok || !res.body) {
    throw new SunoError({
      code: 'api_error',
      message: `download failed for ${clip.id}: HTTP ${res.status}`,
      status: res.status,
    });
  }

  let bytes = 0;
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    options.onProgress?.({ clipId: clip.id, bytes });
  });

  try {
    await pipeline(source, createWriteStream(tmp));
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }

  if (options.embedTags !== false && ext === 'mp3') {
    await embedTags(client, clip, target, options).catch(() => {
      // Tagging is a nicety. A failure here must not lose the audio we already
      // have on disk.
    });
  }

  if (options.saveArtwork === true) {
    await saveArtwork(clip, options.outputDir, options.signal).catch(() => undefined);
  }

  return target;
}

/** Prefer the large art; the thumbnail is what `image_url` gives you. */
export function artworkUrl(clip: Clip): string | undefined {
  const large = (clip as { image_large_url?: unknown }).image_large_url;
  if (typeof large === 'string' && large !== '') return large;
  return typeof clip.image_url === 'string' && clip.image_url !== '' ? clip.image_url : undefined;
}

async function fetchArtwork(clip: Clip, signal?: AbortSignal): Promise<Buffer | undefined> {
  const url = artworkUrl(clip);
  if (url === undefined) return undefined;
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) return undefined;
  return Buffer.from(await res.arrayBuffer());
}

async function saveArtwork(clip: Clip, outputDir: string, signal?: AbortSignal): Promise<void> {
  const art = await fetchArtwork(clip, signal);
  if (!art) return;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(outputDir, clipFilename(clip.title, clip.id, 'jpeg')), art);
}

async function embedTags(
  client: SunoClient,
  clip: Clip,
  path: string,
  options: DownloadOptions,
): Promise<void> {
  const signal = options.signal;
  const tags: NodeID3.Tags = {
    title: clip.title || 'Untitled',
    artist: 'Suno',
    comment: { language: 'eng', text: clip.metadata?.tags ?? '' },
  };

  if (options.embedArtwork !== false) {
    const art = await fetchArtwork(clip, signal).catch(() => undefined);
    if (art) tags.image = { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: 'cover', imageBuffer: art };
  }
  const lyrics = clip.metadata?.prompt;
  if (typeof lyrics === 'string' && lyrics !== '') {
    tags.unsynchronisedLyrics = { language: 'eng', text: lyrics };
  }

  const words = await alignedLyrics(client, clip.id, signal).catch(() => [] as AlignedWord[]);
  if (words.length > 0) {
    tags.synchronisedLyrics = [
      {
        language: 'eng',
        timeStampFormat: 2, // milliseconds
        contentType: 1, // lyrics
        shortText: clip.title,
        synchronisedText: toSyncedLyrics(words),
      },
    ];
  }

  NodeID3.update(tags, path);
}

export async function downloadClips(
  client: SunoClient,
  clips: readonly Clip[],
  options: DownloadOptions,
): Promise<{ downloaded: string[]; failed: Array<{ clipId: string; error: string }> }> {
  const downloaded: string[] = [];
  const failed: Array<{ clipId: string; error: string }> = [];
  for (const clip of clips) {
    try {
      downloaded.push(await downloadClip(client, clip, options));
    } catch (err) {
      failed.push({ clipId: clip.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { downloaded, failed };
}
