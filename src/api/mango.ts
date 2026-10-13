/**
 * Playback decryption ("Mango"): how the web player turns `media_urls` into
 * sound, as opposed to the metered Download button.
 *
 * `media_urls` answers 200 with a ciphertext that has no container magic. The
 * player then asks `POST /api/mango/rights` for wrapped key material and
 * unwraps it locally. It does not spend a download credit, which is why the
 * default download path never calls it: callers opt in with `playTrack` or
 * `source: 'playback'`.
 *
 * Measured live on 2026-10-13, Pro account:
 *   - Sent anonymously, `/rights` returned `{ key, iv, glt }` for one of the
 *     account's PRIVATE clips, and the result decrypted to the full file.
 *     It is not a per-account access check: the clip id is enough, as it
 *     was with the old public `audio_url`.
 *   - Sent WITH the session, it returned `{ key, iv }` and no `glt`. The
 *     signed-in player unwraps with a key derived some other way, which is
 *     not known here. So the session is never sent: anonymous is the one
 *     variant this scheme decrypts.
 *   - An unknown id answers 404 `{"detail": "Content not found"}`.
 *   - `download_usage` did not move across a run of rights calls and two
 *     full decrypts.
 *
 * Scheme, matching suno.com's player:
 *   1. POST { content_params: { content_id, content_type: "clip" } }
 *      → { key, iv, glt }  (all base64 except glt, a utf-8 guest token)
 *   2. user key = SHA-256(glt)
 *   3. key and iv are AES-256-GCM wrapped: nonce = bytes[0:12], tag = bytes[-16:],
 *      additional data = the clip id
 *   4. the file is AES-CTR with the unwrapped key and counter
 */
import { createDecipheriv, createHash, type Decipher } from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import { z } from 'zod';

import type { SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import type { Clip, MediaUrl } from '../schemas.js';

export const MANGO_RIGHTS_PATH = '/api/mango/rights';

export const MangoRightsSchema = z
  .object({
    key: z.string().min(1),
    iv: z.string().min(1),
    glt: z.string().min(1),
  })
  .passthrough();

export type MangoRights = z.infer<typeof MangoRightsSchema>;

const EXT_BY_TYPE: Record<string, string> = {
  'm4a-opus': 'm4a',
  m4a: 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  mp3: 'mp3',
  wav: 'wav',
};

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
};

/**
 * Key material for one clip, asked for anonymously — see the header for why
 * the session must stay out of it.
 *
 * No refusal has ever been observed. A 401 or 403 is still mapped to
 * `playback_denied`, so that the day Suno starts refusing, the error does not
 * read as `plan_required` and send someone off to upgrade.
 */
export async function mangoRights(
  client: SunoClient,
  clipId: string,
  signal?: AbortSignal,
): Promise<MangoRights> {
  try {
    return await client.request({
      method: 'POST',
      path: MANGO_RIGHTS_PATH,
      body: { content_params: { content_id: clipId, content_type: 'clip' } },
      schema: MangoRightsSchema,
      endpointKey: 'mango.rights',
      skipAuth: true,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof SunoError && (err.status === 401 || err.status === 403)) {
      throw new SunoError({
        code: 'playback_denied',
        message: `${MANGO_RIGHTS_PATH} refused clip ${clipId} (HTTP ${err.status}): no playback keys for it`,
        status: err.status,
        path: MANGO_RIGHTS_PATH,
        ...(err.body !== undefined ? { body: err.body } : {}),
        cause: err,
      });
    }
    throw err;
  }
}

export interface PlayTrackOptions {
  signal?: AbortSignal;
}

export interface PlaybackStream {
  /**
   * Decrypted audio, ready for a player, an HTTP response or a file. Destroying
   * it aborts the CDN download, the way pausing for good does in the browser.
   */
  stream: Readable;
  clipId: string;
  /** `m4a` for every clip seen so far. */
  ext: string;
  contentType: string;
  /** From the CDN. AES-CTR keeps the length, so this is the decrypted size too. */
  contentLength: number | undefined;
}

/**
 * Play a clip the way suno.com's player does: fetch the `media_urls` ciphertext
 * and ask `/api/mango/rights` for its keys in parallel, then decrypt as the
 * bytes arrive. Nothing is buffered beyond the first 12 bytes, which are
 * checked before the stream is handed over: a failed decrypt rejects here
 * instead of feeding noise to whatever is listening.
 *
 * Works signed out: the rights call is anonymous whatever the client holds.
 */
export async function playTrack(
  client: SunoClient,
  clip: Clip,
  options: PlayTrackOptions = {},
): Promise<PlaybackStream> {
  const picked = pickPlaybackMedia(clip);
  if (!picked) {
    throw new SunoError({
      code: 'not_found',
      message: `clip ${clip.id} has no progressive audio in media_urls`,
    });
  }

  const media = fetch(picked.url, options.signal ? { signal: options.signal } : {});
  // Handled below. Without this, a CDN failure landing while rights is still
  // in flight would surface as an unhandled rejection.
  media.catch(() => undefined);

  let rights: MangoRights;
  try {
    rights = await mangoRights(client, clip.id, options.signal);
  } catch (err) {
    media.then((res) => res.body?.cancel()).catch(() => undefined);
    throw err;
  }

  let res: Response;
  try {
    res = await media;
  } catch (err) {
    throw transportError(clip.id, err);
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new SunoError({
      code: 'api_error',
      message: `playback fetch failed for ${clip.id}: HTTP ${res.status}`,
      status: res.status,
    });
  }

  let decipher: Decipher;
  try {
    decipher = createMangoDecipher(clip.id, rights);
  } catch (err) {
    await res.body.cancel().catch(() => undefined);
    throw err;
  }

  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  // pipeline rather than pipe: a CDN failure mid-song errors the returned
  // stream, and destroying the returned stream cancels the download.
  const stream: Readable = pipeline(source, decipher, () => undefined);

  let head: Buffer;
  try {
    head = await readHead(stream, 12);
  } catch (err) {
    stream.destroy();
    throw transportError(clip.id, err);
  }
  if (!isPlayableAudio(head)) {
    stream.destroy();
    throw new SunoError({
      code: 'response_invalid',
      message: `clip ${clip.id}: decrypted playback is not a recognised audio container`,
    });
  }

  const length = Number(res.headers.get('content-length'));
  return {
    stream,
    clipId: clip.id,
    ext: picked.ext,
    contentType: CONTENT_TYPE_BY_EXT[picked.ext] ?? res.headers.get('content-type') ?? 'application/octet-stream',
    contentLength: Number.isFinite(length) && length > 0 ? length : undefined,
  };
}

/** Same rule as the client: an abort is the caller's decision, never retryable. */
function transportError(clipId: string, err: unknown): SunoError {
  if (err instanceof SunoError) return err;
  const isAbort = err instanceof Error && err.name === 'AbortError';
  return new SunoError({
    code: 'network',
    message: `playback of ${clipId} failed: ${err instanceof Error ? err.message : String(err)}`,
    retryable: !isAbort,
    cause: err,
  });
}

/**
 * Read at least `size` bytes and put them back, so the caller sees the stream
 * from its first byte. Shorter only when the stream ends first.
 */
function readHead(stream: Readable, size: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = (): void => {
      stream.off('readable', onReadable);
      stream.off('end', onEnd);
      stream.off('error', onError);
    };
    const onReadable = (): void => {
      let chunk: Buffer | null;
      while (length < size && (chunk = stream.read() as Buffer | null) !== null) {
        chunks.push(chunk);
        length += chunk.length;
      }
      if (length < size) return;
      cleanup();
      const head = Buffer.concat(chunks);
      stream.unshift(head);
      resolve(head);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    stream.on('readable', onReadable);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

/**
 * Progressive audio entry from `media_urls`. Video and adaptive streams are
 * skipped: this is the file the player decrypts for listening.
 */
export function pickPlaybackMedia(clip: Clip): { url: string; ext: string } | undefined {
  for (const entry of clip.media_urls ?? []) {
    const picked = playbackEntry(entry);
    if (picked) return picked;
  }
  return undefined;
}

function playbackEntry(entry: MediaUrl): { url: string; ext: string } | undefined {
  if (typeof entry.url !== 'string' || entry.url === '') return undefined;
  const ctype = (entry.content_type ?? '').toLowerCase();
  const delivery = (entry.delivery ?? '').toLowerCase();
  if (delivery !== '' && delivery !== 'progressive') return undefined;
  if (ctype.startsWith('video') || ctype === 'mp4') return undefined;
  const ext = EXT_BY_TYPE[ctype] ?? extensionOfUrl(entry.url) ?? 'm4a';
  return { url: entry.url, ext };
}

function extensionOfUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf('.');
    if (dot === -1) return undefined;
    const ext = path.slice(dot + 1).toLowerCase();
    return ext === '' ? undefined : ext;
  } catch {
    return undefined;
  }
}

/** Cheap container sniff: decrypted bytes should look like m4a/mp4 or webm. */
export function isPlayableAudio(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true;
  return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

export function createMangoDecipher(clipId: string, rights: MangoRights): Decipher {
  const userKey = createHash('sha256').update(rights.glt, 'utf8').digest();
  const key = unwrap(rights.key, clipId, userKey);
  const counter = unwrap(rights.iv, clipId, userKey);
  if (counter.length !== 16) {
    throw new SunoError({
      code: 'response_invalid',
      message: `mango counter is ${counter.length} bytes, expected 16`,
    });
  }
  const algo = ctrAlgorithm(key.length);
  return createDecipheriv(algo, key, counter);
}

export function decryptMangoAudio(
  ciphertext: Uint8Array,
  clipId: string,
  rights: MangoRights,
): Buffer {
  const decipher = createMangoDecipher(clipId, rights);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function unwrap(wrappedB64: string, clipId: string, userKey: Buffer): Buffer {
  let wrapped: Buffer;
  try {
    wrapped = Buffer.from(wrappedB64, 'base64');
  } catch {
    throw new SunoError({ code: 'response_invalid', message: 'mango wrap is not valid base64' });
  }
  if (wrapped.length < 28) {
    throw new SunoError({
      code: 'response_invalid',
      message: `mango wrap is ${wrapped.length} bytes, need at least 28 (nonce + tag)`,
    });
  }
  const nonce = wrapped.subarray(0, 12);
  const tag = wrapped.subarray(wrapped.length - 16);
  const ciphertext = wrapped.subarray(12, wrapped.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', userKey, nonce);
    decipher.setAAD(Buffer.from(clipId, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new SunoError({
      code: 'response_invalid',
      message: 'failed to unwrap mango key material',
      cause: err,
    });
  }
}

function ctrAlgorithm(keyBytes: number): string {
  if (keyBytes === 16) return 'aes-128-ctr';
  if (keyBytes === 24) return 'aes-192-ctr';
  if (keyBytes === 32) return 'aes-256-ctr';
  throw new SunoError({
    code: 'response_invalid',
    message: `unexpected mango key length ${keyBytes}`,
  });
}
