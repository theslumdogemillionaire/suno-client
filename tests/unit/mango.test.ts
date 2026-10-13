import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptMangoAudio,
  isPlayableAudio,
  mangoRights,
  pickPlaybackMedia,
  playTrack,
} from '../../src/api/mango.js';
import type { AuthState, FetchLike } from '../../src/auth.js';
import { SunoClient } from '../../src/client.js';
import { MemoryAuthStore } from '../../src/store.js';
import { AUDIO_FORBIDDEN_URL, ClipSchema } from '../../src/schemas.js';

const CLIP_ID = 'b1a2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d';

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

describe('decryptMangoAudio', () => {
  it('round-trips AES-CTR ciphertext wrapped the way the player unwraps it', () => {
    const plain = ftypStub();
    const packed = encryptPlayback(plain, CLIP_ID);
    expect(isPlayableAudio(packed.ciphertext)).toBe(false);
    const out = decryptMangoAudio(packed.ciphertext, CLIP_ID, packed.rights);
    expect(out.equals(plain)).toBe(true);
    expect(isPlayableAudio(out)).toBe(true);
  });

  it('refuses key material whose AAD is a different clip id', () => {
    const packed = encryptPlayback(ftypStub(), CLIP_ID);
    expect(() => decryptMangoAudio(packed.ciphertext, '00000000-0000-0000-0000-000000000000', packed.rights)).toThrow(
      /unwrap mango key material/,
    );
  });
});

describe('isPlayableAudio', () => {
  it('accepts an ftyp box and a webm EBML header, and nothing else', () => {
    expect(isPlayableAudio(ftypStub())).toBe(true);
    expect(isPlayableAudio(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(isPlayableAudio(Buffer.alloc(12, 0xff))).toBe(false);
    expect(isPlayableAudio(Buffer.alloc(4))).toBe(false);
  });
});

/** A JWT with a real `exp`, so the client sends it instead of refreshing. */
function freshJwt(): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

function rightsClient(
  answer: () => Response,
  session?: AuthState,
): { client: SunoClient; calls: Array<{ url: string; body: unknown; authorization: string | undefined }> } {
  const calls: Array<{ url: string; body: unknown; authorization: string | undefined }> = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: headerMap(init)['authorization'],
    });
    return Promise.resolve(answer());
  };
  const client = new SunoClient({
    fetch: fetchImpl,
    baseUrl: 'https://suno.test',
    store: new MemoryAuthStore(session),
    retry: { maxRetries: 0 },
  });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('mangoRights', () => {
  it('posts the player body anonymously when no session is stored', async () => {
    const { client, calls } = rightsClient(() => json({ key: 'k', iv: 'i', glt: 'g' }));
    const rights = await mangoRights(client, CLIP_ID);
    expect(rights).toMatchObject({ key: 'k', iv: 'i', glt: 'g' });
    expect(calls).toEqual([
      {
        url: 'https://suno.test/api/mango/rights',
        body: { content_params: { content_id: CLIP_ID, content_type: 'clip' } },
        authorization: undefined,
      },
    ]);
  });

  it('keeps a stored session out of it: with one, rights come back without the glt', async () => {
    // Measured 2026-10-13: the signed-in answer is `{ key, iv }` only, which
    // this unwrap cannot use. Anonymous returned all three, private clip included.
    const jwt = freshJwt();
    const { client, calls } = rightsClient(() => json({ key: 'k', iv: 'i', glt: 'g' }), {
      clerkClientCookie: 'client-cookie-value',
      deviceId: 'device-1234',
      sessionId: 'sess_known',
      jwt,
    });
    await mangoRights(client, CLIP_ID);
    expect(jwt).not.toBe('');
    expect(calls.map((c) => c.authorization)).toEqual([undefined]);
  });

  it('reports a refusal as playback_denied, not as a plan to upgrade', async () => {
    const { client } = rightsClient(() => new Response('', { status: 403 }));
    await expect(mangoRights(client, CLIP_ID)).rejects.toMatchObject({
      code: 'playback_denied',
      status: 403,
      retryable: false,
      alert: false,
    });
  });
});

function headerMap(init: Parameters<FetchLike>[1]): Record<string, string> {
  const raw = init?.headers;
  if (raw === undefined || raw === null) return {};
  if (Array.isArray(raw)) return Object.fromEntries(raw as Array<[string, string]>);
  return { ...(raw as unknown as Record<string, string>) };
}

describe('pickPlaybackMedia', () => {
  it('takes the first progressive audio entry and skips video', () => {
    const clip = ClipSchema.parse({
      id: CLIP_ID,
      title: 'x',
      status: 'complete',
      model_name: 'chirp-hawk',
      created_at: '2026-09-10T00:00:00.000Z',
      audio_url: AUDIO_FORBIDDEN_URL,
      media_urls: [
        { url: 'https://cdn.example/v.mp4', content_type: 'mp4', delivery: 'progressive' },
        { url: 'https://cdn.example/a.m4a', content_type: 'm4a-opus', delivery: 'progressive', encoding: '1.0.0' },
      ],
    });
    expect(pickPlaybackMedia(clip)).toEqual({ url: 'https://cdn.example/a.m4a', ext: 'm4a' });
  });

  it('skips adaptive streams', () => {
    const clip = ClipSchema.parse({
      id: CLIP_ID,
      title: 'x',
      status: 'complete',
      model_name: 'chirp-hawk',
      created_at: '2026-09-10T00:00:00.000Z',
      media_urls: [{ url: 'https://cdn.example/a.m3u8', content_type: 'm4a-opus', delivery: 'hls' }],
    });
    expect(pickPlaybackMedia(clip)).toBeUndefined();
  });
});

describe('playTrack', () => {
  const CDN = 'https://cdn.example/a.m4a';
  const playable = ClipSchema.parse({
    id: CLIP_ID,
    title: 'x',
    status: 'complete',
    model_name: 'chirp-hawk',
    created_at: '2026-09-10T00:00:00.000Z',
    media_urls: [{ url: CDN, content_type: 'm4a-opus', delivery: 'progressive' }],
  });

  /** Serves `bytes` lazily: 5 bytes first, so the header check has to wait for a second chunk. */
  function cdnBody(bytes: Buffer, onCancel: () => void = () => undefined): ReadableStream<Uint8Array> {
    let offset = 0;
    return new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const size = offset === 0 ? 5 : 4096;
        controller.enqueue(new Uint8Array(bytes.subarray(offset, offset + size)));
        offset += size;
      },
      cancel: onCancel,
    });
  }

  async function withCdn<T>(body: ReadableStream<Uint8Array>, length: number, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      if (String(input) !== CDN) throw new Error(`unexpected fetch ${String(input)}`);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'audio/mp4', 'content-length': String(length) },
      });
    }) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('streams the decrypted audio from its first byte, as the player hears it', async () => {
    const plain = Buffer.concat([ftypStub(), randomBytes(50_000)]);
    const packed = encryptPlayback(plain, CLIP_ID);
    const { client } = rightsClient(() => json(packed.rights));
    const out = await withCdn(cdnBody(packed.ciphertext), plain.length, async () => {
      const playing = await playTrack(client, playable);
      expect(playing).toMatchObject({
        clipId: CLIP_ID,
        ext: 'm4a',
        contentType: 'audio/mp4',
        contentLength: plain.length,
      });
      return Buffer.concat(await playing.stream.toArray());
    });
    expect(out.equals(plain)).toBe(true);
  });

  it('drops the CDN download when rights are refused', async () => {
    const packed = encryptPlayback(ftypStub(), CLIP_ID);
    let cancelled = false;
    const { client } = rightsClient(() => new Response('', { status: 403 }));
    await withCdn(
      cdnBody(packed.ciphertext, () => {
        cancelled = true;
      }),
      packed.ciphertext.length,
      async () => {
        await expect(playTrack(client, playable)).rejects.toMatchObject({ code: 'playback_denied' });
        await tick();
      },
    );
    expect(cancelled).toBe(true);
  });

  it('rejects rather than streaming noise when the decrypted header is not audio', async () => {
    const packed = encryptPlayback(randomBytes(20_000), CLIP_ID);
    let cancelled = false;
    const { client } = rightsClient(() => json(packed.rights));
    await withCdn(
      cdnBody(packed.ciphertext, () => {
        cancelled = true;
      }),
      packed.ciphertext.length,
      async () => {
        await expect(playTrack(client, playable)).rejects.toMatchObject({
          code: 'response_invalid',
          message: expect.stringMatching(/not a recognised audio container/),
        });
        await tick();
      },
    );
    expect(cancelled).toBe(true);
  });

  it('stops downloading when the listener destroys the stream', async () => {
    const plain = Buffer.concat([ftypStub(), randomBytes(2_000_000)]);
    const packed = encryptPlayback(plain, CLIP_ID);
    let cancelled = false;
    const { client } = rightsClient(() => json(packed.rights));
    await withCdn(
      cdnBody(packed.ciphertext, () => {
        cancelled = true;
      }),
      plain.length,
      async () => {
        const playing = await playTrack(client, playable);
        playing.stream.destroy();
        await tick();
      },
    );
    expect(cancelled).toBe(true);
  });

  it('says so when the clip has nothing to play', async () => {
    const { client, calls } = rightsClient(() => json({}));
    const silent = ClipSchema.parse({ ...playable, media_urls: [] });
    await expect(playTrack(client, silent)).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toEqual([]);
  });
});
