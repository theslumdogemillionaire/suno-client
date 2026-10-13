import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { clipFilename, downloadClip, toSyncedLyrics } from '../../src/download.js';
import {
  AUDIO_FORBIDDEN_URL,
  ClipSchema,
  isFetchableUrl,
  type AlignedWord,
  type Clip,
} from '../../src/schemas.js';

const ID = 'b1a2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
const SHORT = 'b1a2c3d4';

function wrap(plain: Buffer, clipId: string, userKey: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', userKey, nonce);
  cipher.setAAD(Buffer.from(clipId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString('base64');
}

function ftypStub(): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(24, 0);
  buf.write('ftyp', 4);
  buf.write('isom', 8);
  return buf;
}

function encryptPlayback(plain: Buffer, clipId: string, glt = 'guest-token') {
  const userKey = createHash('sha256').update(glt, 'utf8').digest();
  const key = randomBytes(16);
  const counter = randomBytes(16);
  const cipher = createCipheriv('aes-128-ctr', key, counter);
  return {
    ciphertext: Buffer.concat([cipher.update(plain), cipher.final()]),
    rights: {
      key: wrap(key, clipId, userKey),
      iv: wrap(counter, clipId, userKey),
      glt,
    },
  };
}

function word(text: string, start_s: number): AlignedWord {
  return { word: text, start_s, end_s: start_s + 0.4 };
}

describe('clipFilename', () => {
  it('lowercases the title and collapses every run of punctuation and spaces into one dash', () => {
    expect(clipFilename('Take 2 ---  Final!!!  Mix', ID, 'mp3')).toBe(`take-2-final-mix-${SHORT}.mp3`);
    expect(clipFilename('hello_world', ID, 'mp3')).toBe(`hello-world-${SHORT}.mp3`);
  });

  it('never emits a leading dash, a trailing dash, or a doubled dash', () => {
    const titles = [
      '!!!Bang',
      'Bang!!!',
      '  spaced  out  ',
      '--- Dashes ---',
      '(Live) [2024]',
      "Rock 'n' Roll",
      '\t\nnewline lead',
    ];
    for (const title of titles) {
      const name = clipFilename(title, ID, 'mp3');
      expect(name.startsWith('-')).toBe(false);
      // A slug ending in a dash would surface as `--` once the id is appended,
      // so this one assertion covers both the collapse and the trailing trim.
      expect(name).not.toContain('--');
    }
    expect(clipFilename('(Live) [2024]', ID, 'mp3')).toBe(`live-2024-${SHORT}.mp3`);
    expect(clipFilename("Rock 'n' Roll", ID, 'mp3')).toBe(`rock-n-roll-${SHORT}.mp3`);
  });

  it('returns the bare id when the title slugs away to nothing', () => {
    for (const title of ['', '   ', '!!! ??? ...', '\u{1F3B5}\u{1F3B6}', '--- ---']) {
      const name = clipFilename(title, ID, 'mp3');
      expect(name).toBe(`${SHORT}.mp3`);
    }
  });

  it('keeps accented latin letters instead of dropping them', () => {
    // The normalisation form is load-bearing and invisible in a rendered
    // literal, hence the escapes: these are precomposed (NFC) code points,
    // which are \p{L}. The same titles in NFD carry combining marks, which
    // are not, and slug differently.
    expect(clipFilename('Caf\u00e9 D\u00e9j\u00e0 Vu', ID, 'mp3')).toBe(`caf\u00e9-d\u00e9j\u00e0-vu-${SHORT}.mp3`);
    expect(clipFilename('\u00dcBER STRASSE', ID, 'mp3')).toBe(`\u00fcber-strasse-${SHORT}.mp3`);
  });

  it('keeps non-latin scripts so a Japanese or Cyrillic title is not reduced to an id', () => {
    expect(clipFilename('\u6771\u4EAC\u306E\u591C', ID, 'mp3')).toBe(`\u6771\u4EAC\u306E\u591C-${SHORT}.mp3`);
    expect(clipFilename('\u041F\u0440\u0438\u0432\u0435\u0442 \u041C\u0438\u0440', ID, 'mp3')).toBe(`\u043F\u0440\u0438\u0432\u0435\u0442-\u043C\u0438\u0440-${SHORT}.mp3`);
    expect(clipFilename('\uD55C\uAD6D\uC5B4 \uB178\uB798', ID, 'mp3')).toBe(`\uD55C\uAD6D\uC5B4-\uB178\uB798-${SHORT}.mp3`);
  });

  it('keeps letters outside the BMP whole', () => {
    // A charCodeAt-indexed loop would split this into two lone surrogates,
    // neither of which matches \p{L}, and the title would vanish.
    expect(clipFilename('\u{10300}\u{10301} runes', ID, 'mp3')).toBe(`\u{10300}\u{10301}-runes-${SHORT}.mp3`);
  });

  it('appends the first 8 characters of the id so the two same-titled clips of one generation do not overwrite each other', () => {
    const a = clipFilename('Midnight Drive', '8f3a91c2-1111-4aaa-8bbb-ccccdddddddd', 'mp3');
    const b = clipFilename('Midnight Drive', 'd47e0b16-2222-4aaa-8bbb-ccccdddddddd', 'mp3');
    expect(a).toBe('midnight-drive-8f3a91c2.mp3');
    expect(b).toBe('midnight-drive-d47e0b16.mp3');
    expect(a).not.toBe(b);
  });

  it('carries the id suffix whatever the title looks like', () => {
    const titles = ['Midnight Drive', '', '   ', '\u{1F3B5}', '\u6771\u4EAC', 'a', '...', '9', 'x'.repeat(200)];
    for (const title of titles) {
      const name = clipFilename(title, ID, 'mp3');
      expect(name.endsWith(`${SHORT}.mp3`)).toBe(true);
    }
  });

  it('uses the whole id when it is shorter than 8 characters', () => {
    expect(clipFilename('Demo', 'abc', 'mp3')).toBe('demo-abc.mp3');
  });

  it('strips path separators and dots so a title cannot escape the output directory', () => {
    // downloadClip feeds this straight into join(outputDir, ...), so a title
    // Suno never validated is the only thing between us and an arbitrary write.
    for (const title of ['../../etc/passwd', 'C:\\Windows\\system32', 'a/b/c', '..', '.']) {
      const name = clipFilename(title, ID, 'mp3');
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain('..');
    }
    expect(clipFilename('../../etc/passwd', ID, 'mp3')).toBe(`etc-passwd-${SHORT}.mp3`);
    expect(clipFilename('..', ID, 'mp3')).toBe(`${SHORT}.mp3`);
  });

  it('uses the extension it is handed', () => {
    expect(clipFilename('Night Drive', ID, 'mp4')).toBe(`night-drive-${SHORT}.mp4`);
  });
});

describe('toSyncedLyrics', () => {
  it('converts each start time from seconds to whole milliseconds', () => {
    const result = toSyncedLyrics([word('hello', 0), word('world', 1.5), word('again', 12.25)]);
    expect(result).toEqual([
      { text: 'hello', timeStamp: 0 },
      { text: 'world', timeStamp: 1500 },
      { text: 'again', timeStamp: 12250 },
    ]);
    for (const entry of result) {
      expect(Number.isInteger(entry.timeStamp)).toBe(true);
    }
  });

  it('rounds instead of truncating, so binary float error never shifts a word a millisecond early', () => {
    // 16.08 * 1000 is 16079.999999999998 in IEEE 754. `(s * 1000) | 0` or
    // Math.floor yields 16079 and every such word drifts against the audio.
    expect(toSyncedLyrics([word('drift', 16.08)])[0]?.timeStamp).toBe(16080);
    expect(toSyncedLyrics([word('drift', 1.005)])[0]?.timeStamp).toBe(1005);
    expect(toSyncedLyrics([word('drift', 0.1 + 0.2)])[0]?.timeStamp).toBe(300);
  });

  it('rounds sub-millisecond timings to the nearest millisecond rather than dropping them', () => {
    expect(toSyncedLyrics([word('a', 0.0004)])[0]?.timeStamp).toBe(0);
    expect(toSyncedLyrics([word('a', 0.0006)])[0]?.timeStamp).toBe(1);
  });

  it('timestamps a word from its start only and ignores end_s', () => {
    const long: AlignedWord = { word: 'heeey', start_s: 4, end_s: 9.9 };
    expect(toSyncedLyrics([long])).toEqual([{ text: 'heeey', timeStamp: 4000 }]);
  });

  it('preserves word order, repeats, and the exact word text', () => {
    const words: readonly AlignedWord[] = [word('na,', 2), word('na,', 1), word(' Na!', 3)];
    expect(toSyncedLyrics(words)).toEqual([
      { text: 'na,', timeStamp: 2000 },
      { text: 'na,', timeStamp: 1000 },
      { text: ' Na!', timeStamp: 3000 },
    ]);
  });

  it('returns an empty list for a clip with no aligned words', () => {
    expect(toSyncedLyrics([])).toEqual([]);
  });

  it("leaves the caller's array untouched", () => {
    const words: AlignedWord[] = [word('one', 1)];
    toSyncedLyrics(words);
    expect(words).toEqual([{ word: 'one', start_s: 1, end_s: 1.4 }]);
  });
});

const clip = (audio_url: string | null): Clip =>
  ClipSchema.parse({
    id: ID,
    title: 'Paroles Ici',
    status: 'complete',
    model_name: 'chirp-hawk',
    audio_url,
    created_at: '2026-09-10T14:13:00.000Z',
    media_urls: [
      {
        url: `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${ID}.m4a`,
        content_type: 'm4a-opus',
        delivery: 'progressive',
        encoding: '1.0.0',
      },
    ],
  });

describe('the audio_url sentinel', () => {
  it('is not fetchable, even though it is a perfectly well-formed non-empty URL', () => {
    expect(AUDIO_FORBIDDEN_URL).not.toBe('');
    expect(Boolean(AUDIO_FORBIDDEN_URL)).toBe(true); // the trap, spelled out
    expect(isFetchableUrl(AUDIO_FORBIDDEN_URL)).toBe(false);
  });

  it('is recognised wherever Suno moves the host, because only the path is matched', () => {
    expect(isFetchableUrl('https://studio-api-prod.suno.com/api/forbidden')).toBe(false);
    expect(isFetchableUrl('https://anything.example/api/forbidden')).toBe(false);
  });

  it('still passes real URLs, empty strings and nullish through correctly', () => {
    expect(isFetchableUrl('https://cdn2.suno.ai/x.mp3')).toBe(true);
    expect(isFetchableUrl('')).toBe(false);
    expect(isFetchableUrl(null)).toBe(false);
    expect(isFetchableUrl(undefined)).toBe(false);
  });

  /** A client whose download endpoint answers exactly what Suno answers. */
  const clientAnswering = (body: unknown) =>
    ({ request: async () => body }) as never;

  const LOCKED = { ok: false, reason: 'not_authorized' };

  it('does not let a forbidden url be mistaken for "still rendering"', async () => {
    // The two cases carry different codes on purpose: one is a clip that needs
    // a paid unlock, the other is a clip that is not finished. Collapsing them
    // sends a caller to wait for something that will never arrive.
    await expect(
      downloadClip(clientAnswering(LOCKED), clip(AUDIO_FORBIDDEN_URL), { outputDir: '/tmp' }),
    ).rejects.toMatchObject({ code: 'download_locked' });

    await expect(
      downloadClip(clientAnswering(LOCKED), clip(null), { outputDir: '/tmp' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('asks the download endpoint rather than falling back to media_urls', async () => {
    const withMedia = clip(AUDIO_FORBIDDEN_URL);
    expect(withMedia.media_urls?.[0]?.url).toContain('cloudfront.net');
    // A fallback to media_urls would fetch 200 and write an encrypted file,
    // which is strictly worse than failing. The sentinel must route to the
    // sanctioned endpoint and surface its refusal.
    let askedPath = '';
    const spy = {
      request: async (opts: { path: string }) => {
        askedPath = opts.path;
        return LOCKED;
      },
    } as never;
    await expect(downloadClip(spy, withMedia, { outputDir: '/tmp' })).rejects.toMatchObject({
      code: 'download_locked',
    });
    expect(askedPath).toBe(`/api/download/clip/${ID}`);
  });

  it('reports a refusal that is not a lock as an api error, not as a lock', async () => {
    // Treating every `ok: false` as "unlock it" would send someone to spend a
    // metered download on a clip that is refused for an unrelated reason.
    await expect(
      downloadClip(clientAnswering({ ok: false, reason: 'invalid_format' }), clip(AUDIO_FORBIDDEN_URL), {
        outputDir: '/tmp',
      }),
    ).rejects.toMatchObject({ code: 'api_error' });
  });

  it('treats an unlocked clip with an empty video_url as downloadable', async () => {
    // Real shape: unlocked clips carry `video_url: ""` while their mp3 is ready.
    // An emptiness check alone would refuse exactly the clips already paid for.
    const unlocked = ClipSchema.parse({
      id: ID,
      title: 'Paroles Ici',
      status: 'complete',
      model_name: 'chirp-hawk',
      audio_url: AUDIO_FORBIDDEN_URL,
      video_url: '',
      created_at: '2026-09-10T14:13:00.000Z',
      is_download_unlocked: true,
    });
    await expect(
      downloadClip(clientAnswering(LOCKED), unlocked, { outputDir: '/tmp', video: true }),
    ).rejects.toMatchObject({ code: 'download_locked' }); // not not_found
  });

  it('keeps media_urls typed rather than passing it through untyped', () => {
    const parsed = clip(AUDIO_FORBIDDEN_URL);
    expect(parsed.media_urls).toHaveLength(1);
    expect(parsed.media_urls?.[0]?.content_type).toBe('m4a-opus');
  });

  it('does not call mango unless source is playback', async () => {
    const paths: string[] = [];
    const spy = {
      request: async (opts: { path: string }) => {
        paths.push(opts.path);
        return LOCKED;
      },
    } as never;
    await expect(downloadClip(spy, clip(AUDIO_FORBIDDEN_URL), { outputDir: '/tmp' })).rejects.toMatchObject({
      code: 'download_locked',
    });
    expect(paths.some((p) => p.includes('mango'))).toBe(false);
  });
});

describe('downloadClip playback', () => {
  it('decrypts media_urls instead of hitting the metered download endpoint', async () => {
    const packed = encryptPlayback(ftypStub(), ID);
    const dir = await mkdtemp(join(tmpdir(), 'suno-dl-'));
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('cloudfront.net')) {
        return new Response(packed.ciphertext, { status: 200 });
      }
      return originalFetch(input as never);
    }) as typeof fetch;
    try {
      const spy = {
        request: async (opts: { path: string; skipAuth?: boolean }) => {
          paths.push(opts.path);
          expect(opts.skipAuth).toBe(true);
          return packed.rights;
        },
      } as never;
      let progressed = 0;
      const target = await downloadClip(spy, clip(AUDIO_FORBIDDEN_URL), {
        outputDir: dir,
        source: 'playback',
        embedTags: false,
        onProgress: ({ bytes }) => {
          progressed = bytes;
        },
      });
      expect(paths).toEqual([`/api/mango/rights`]);
      expect(progressed).toBe(ftypStub().length);
      expect(target.endsWith('.m4a')).toBe(true);
      const bytes = await readFile(target);
      expect(bytes.equals(ftypStub())).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses video on the playback path', async () => {
    await expect(
      downloadClip({ request: async () => ({}) } as never, clip(AUDIO_FORBIDDEN_URL), {
        outputDir: '/tmp',
        source: 'playback',
        video: true,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
