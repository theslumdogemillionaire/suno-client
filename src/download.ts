import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import NodeID3 from 'node-id3';

import { alignedLyrics } from './api/misc.js';
import { resolveDownloadUrl, type DownloadFormat } from './api/download-unlock.js';
import { playTrack } from './api/mango.js';
import type { SunoClient } from './client.js';
import { abortedError, SunoError, type SunoErrorCode } from './errors.js';
import { isFetchableUrl, type AlignedWord, type Clip } from './schemas.js';

export type DownloadSource = 'download' | 'playback';

export interface DownloadOptions {
  /** Directory. Created if missing. */
  outputDir: string;
  /** Grab the mp4 instead of the mp3, when the clip has one. */
  video?: boolean;
  /**
   * Where the bytes come from.
   *
   * `download` (default) is the sanctioned button: quota, unlock, ID3-friendly
   * mp3. `playback` is the player path, `playTrack` written to disk:
   * `media_urls` ciphertext plus `POST /api/mango/rights`. It does not spend a
   * credit and needs no session. Never mixed into the default path: a silent
   * fallback would write an encrypted file the day rights fail.
   */
  source?: DownloadSource;
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

/** Filesystems cap a path component at 255 BYTES; leave room for the id
 * suffix, the extension and the unique `.<uuid>.part` we write to first. */
const MAX_SLUG_BYTES = 180;

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
  if (Buffer.byteLength(slug) > MAX_SLUG_BYTES) {
    // Cut by UTF-8 bytes, whole code points only. Counting UTF-16 units let an
    // 80-character CJK title past 255 bytes (ENAMETOOLONG on every download)
    // and could split a surrogate pair.
    let cut = '';
    let bytes = 0;
    for (const ch of slug) {
      bytes += Buffer.byteLength(ch);
      if (bytes > MAX_SLUG_BYTES) break;
      cut += ch;
    }
    slug = cut;
  }
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
 * change. `media_urls` is never consulted here: the ciphertext needs an
 * explicit `source: 'playback'` so a failed rights call cannot look like a
 * successful mp3.
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
  if (options.source === 'playback') {
    return downloadPlayback(client, clip, options);
  }

  const { url, ext } = await resolveSource(client, clip, options);
  await mkdir(options.outputDir, { recursive: true });
  const target = join(options.outputDir, clipFilename(clip.title, clip.id, ext));
  // Download to a temp name and rename on success, so an interrupted transfer
  // never leaves a truncated mp3 that looks like a finished download.
  const tmp = scratchPath(target);

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

/**
 * The player path, written to disk. `playTrack` has already checked the
 * decrypted header by the time it returns, so whatever reaches the `.part`
 * file is audio; this only adds progress and the atomic rename.
 */
async function downloadPlayback(
  client: SunoClient,
  clip: Clip,
  options: DownloadOptions,
): Promise<string> {
  if (options.video === true) {
    throw new SunoError({
      code: 'invalid_input',
      message: 'playback source is audio-only; drop video: true or use source: "download"',
    });
  }

  await mkdir(options.outputDir, { recursive: true });
  const playing = await playTrack(client, clip, options.signal ? { signal: options.signal } : {});
  const target = join(options.outputDir, clipFilename(clip.title, clip.id, playing.ext));
  const tmp = scratchPath(target);

  let bytes = 0;
  playing.stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    options.onProgress?.({ clipId: clip.id, bytes });
  });

  try {
    await pipeline(playing.stream, createWriteStream(tmp));
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }

  if (options.saveArtwork === true) {
    await saveArtwork(clip, options.outputDir, options.signal).catch(() => undefined);
  }

  return target;
}

/**
 * A scratch name unique to this download. A fixed `<target>.part` was shared by
 * two concurrent downloads of one clip: the second rename failed ENOENT after
 * the first consumed it, and an aborted one's cleanup deleted the other's
 * file mid-transfer. With one each, the last rename simply wins.
 */
function scratchPath(target: string): string {
  return `${target}.${randomUUID()}.part`;
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
): Promise<{ downloaded: string[]; failed: Array<{ clipId: string; error: string; code?: SunoErrorCode }> }> {
  const downloaded: string[] = [];
  const failed: Array<{ clipId: string; error: string; code?: SunoErrorCode }> = [];
  for (const clip of clips) {
    try {
      downloaded.push(await downloadClip(client, clip, options));
    } catch (err) {
      // A refusal about one clip (locked, not rendered yet) is the normal state
      // of a library and belongs in `failed`. A cancel, or anything that needs
      // a human - a dead session, a moved route, a changed response - is not
      // about this clip: every remaining one would fail the same way, so stop.
      if (options.signal?.aborted === true) throw abortedError(options.signal.reason);
      if (err instanceof SunoError && err.alert) throw err;
      failed.push({
        clipId: clip.id,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof SunoError ? { code: err.code } : {}),
      });
    }
  }
  return { downloaded, failed };
}
