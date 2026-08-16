import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decodeJwtClaims, clerkRefreshJwt, clerkTokenExchange } from '../../src/auth.js';
import { clipFilename } from '../../src/download.js';
import { looksLikeSchemaDrift, SunoError } from '../../src/errors.js';
import { FileAuthStore } from '../../src/store.js';

/**
 * Defects found by adversarial review of the first implementation. Each one is
 * a case that shipped broken and would have gone unnoticed in normal use.
 */

describe('schema drift detection survives reformatting', () => {
  it('matches Suno\'s current Python-repr framing', () => {
    expect(
      looksLikeSchemaDrift(
        `{"detail": "[{'type': 'string_type', 'loc': ['body', 'params', 'title'], 'msg': 'Input should be a valid string'}]"}`,
      ),
    ).toBe(true);
  });

  it('still matches when the same payload is compact JSON', () => {
    // The original substring check required a space after every colon. Suno
    // re-serialising this the obvious way would have silently disabled the one
    // signal the client exists to catch.
    expect(
      looksLikeSchemaDrift('{"detail":[{"loc":["body","params","title"],"msg":"Field required","type":"missing"}]}'),
    ).toBe(true);
  });

  it('does not fire on an unrelated error body', () => {
    expect(looksLikeSchemaDrift('{"detail": "Too many requests."}')).toBe(false);
  });
});

describe('JWT claim decoding is type-honest', () => {
  function jwtWithPayload(base64url: string): string {
    return `header.${base64url}.sig`;
  }

  it('rejects a payload that decodes to null', () => {
    // base64url of "null". Parses fine, is not an object, and would otherwise
    // escape typed as JwtClaims.
    expect(decodeJwtClaims(jwtWithPayload('bnVsbA'))).toBeUndefined();
  });

  it('rejects a payload that decodes to a number', () => {
    expect(decodeJwtClaims(jwtWithPayload('MTIz'))).toBeUndefined();
  });

  it('accepts a real claims object', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 123 }), 'utf8').toString('base64url');
    expect(decodeJwtClaims(jwtWithPayload(payload))).toEqual({ exp: 123 });
  });
});

describe('Clerk failures are classified by cause', () => {
  const cookie = 'client_cookie';

  it('reports a 401 as a dead cookie', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const err = await clerkRefreshJwt(fetchImpl, cookie, 'sess').catch((e: unknown) => e as SunoError);
    expect(err).toBeInstanceOf(SunoError);
    expect((err as SunoError).code).toBe('auth_dead');
    expect((err as SunoError).alert).toBe(true);
  });

  it('reports a 503 as transient, not as a revoked session', async () => {
    // Sending someone to re-export a cookie because Clerk had a bad minute is
    // the kind of wrong advice that wastes an afternoon.
    const fetchImpl = (async () => new Response('upstream unavailable', { status: 503 })) as unknown as typeof fetch;
    const err = await clerkTokenExchange(fetchImpl, cookie).catch((e: unknown) => e as SunoError);
    expect((err as SunoError).code).toBe('api_error');
    expect((err as SunoError).retryable).toBe(true);
    expect((err as SunoError).alert).toBe(false);
  });

  it('reports a 200 carrying HTML as an invalid response, not a crash', async () => {
    // auth.suno.com sits behind Cloudflare, whose interstitial arrives as 200.
    const fetchImpl = (async () =>
      new Response('<html>Attention Required</html>', { status: 200 })) as unknown as typeof fetch;
    const err = await clerkRefreshJwt(fetchImpl, cookie, 'sess').catch((e: unknown) => e as SunoError);
    expect(err).toBeInstanceOf(SunoError);
    expect((err as SunoError).code).toBe('response_invalid');
  });
});

describe('filenames survive real titles', () => {
  it('does not split a word where lowercasing produced a combining mark', () => {
    // toLowerCase() turns U+0130 into i + U+0307. That mark matched neither
    // \p{L} nor \p{N}, so it was treated as a separator and "İstanbul" became
    // "i-stanbul". The mark is kept now; no precomposed form exists to fold it
    // into, so the dot stays and the word stays whole.
    const name = clipFilename('İstanbul', 'abcdefgh12345678', 'mp3');
    expect(name).not.toContain('i-stanbul');
    expect(name).toBe(`${'İstanbul'.toLowerCase().normalize('NFC')}-abcdefgh.mp3`);
  });

  it('keeps accents that arrive decomposed', () => {
    const nfd = 'Déjà Vu'.normalize('NFD');
    expect(clipFilename(nfd, 'abcdefgh12345678', 'mp3')).toBe('déjà-vu-abcdefgh.mp3');
  });

  it('caps a very long title so the write does not fail ENAMETOOLONG', () => {
    const name = clipFilename('x'.repeat(300), 'abcdefgh12345678', 'mp3');
    // Room left for the ".part" suffix the download writes to first.
    expect(name.length).toBeLessThan(240);
    expect(name.endsWith('-abcdefgh.mp3')).toBe(true);
  });

  it('still keeps the id suffix when the title slugs away to nothing', () => {
    expect(clipFilename('!!! ???', 'abcdefgh12345678', 'mp3')).toBe('abcdefgh.mp3');
  });
});

describe('the session file tolerates concurrency', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'suno-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('survives two saves racing on the same path', async () => {
    // A fixed `.tmp` name made both saves write the same scratch file; the
    // first rename consumed it and the second failed ENOENT. The client
    // refreshes its JWT from several call sites, so this races in practice.
    const store = new FileAuthStore(join(dir, 'auth.json'));
    await Promise.all([
      store.save({ clerkClientCookie: 'a' }),
      store.save({ clerkClientCookie: 'b' }),
      store.save({ clerkClientCookie: 'c' }),
    ]);
    const loaded = await store.load();
    expect(['a', 'b', 'c']).toContain(loaded?.clerkClientCookie);
  });

  it('sweeps scratch files a crashed save left behind', async () => {
    // Unique names fix the race but would otherwise litter the config directory
    // with files that each hold a session cookie.
    const path = join(dir, 'auth.json');
    await writeFile(`${path}.aaaa-bbbb.tmp`, 'garbage from a killed process');
    await new FileAuthStore(path).save({ clerkClientCookie: 'fresh' });
    expect(await readdir(dir)).toEqual(['auth.json']);
  });
});
