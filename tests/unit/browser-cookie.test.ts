import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  chooseCookie,
  chromeTime,
  clientIdOf,
  decryptValue,
  preferLongestLived,
  type FoundCookie,
} from '../../src/browser-cookie.js';

/** The macOS key derivation, restated here so a change to it fails a test. */
const KEY = pbkdf2Sync('a fake safe storage password', 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, ' ');

/** Build the blob Chromium would have written for `value`. */
function encrypt(value: string, options: { domainHash?: string; version?: string } = {}): Buffer {
  const prefix =
    options.domainHash === undefined
      ? Buffer.alloc(0)
      : createHash('sha256').update(options.domainHash).digest();
  const cipher = createCipheriv('aes-128-cbc', KEY, IV);
  const body = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])), cipher.final()]);
  return Buffer.concat([Buffer.from(options.version ?? 'v10', 'latin1'), body]);
}

describe('decrypting a Chromium cookie', () => {
  const COOKIE = 'eyJhbGciOiJSUzI1NiJ9.eyJzaWQiOiJzZXNzaW9uX2Zha2UifQ.signature-part';

  it('round-trips a plain v10 blob', () => {
    expect(decryptValue(encrypt(COOKIE), KEY)).toBe(COOKIE);
  });

  it('picks the cookie even when the 32-byte prefix is itself printable text', () => {
    // The regression this guards. A domain hash is random bytes, and a "no
    // control characters" test accepts one 2.18% of the time, at which point
    // the decode returns hash-plus-cookie, login sends it, and Suno answers 401
    // blaming the session. Here the prefix is chosen to be entirely printable,
    // which is the worst case that heuristic can meet: the shape test must
    // still find the cookie behind it.
    const prefix = Buffer.from('A'.repeat(32), 'utf8');
    const cipher = createCipheriv('aes-128-cbc', KEY, IV);
    const body = Buffer.concat([
      cipher.update(Buffer.concat([prefix, Buffer.from(COOKIE, 'utf8')])),
      cipher.final(),
    ]);
    const blob = Buffer.concat([Buffer.from('v10', 'latin1'), body]);
    expect(decryptValue(blob, KEY)).toBe(COOKIE);
  });

  it('refuses rather than guessing when neither candidate has a known shape', () => {
    // Two printable candidates and no JWT among them: returning either would be
    // a coin flip, and a wrong cookie costs a 401 that points at the session.
    const cipher = createCipheriv('aes-128-cbc', KEY, IV);
    const body = Buffer.concat([cipher.update(Buffer.from('B'.repeat(80), 'utf8')), cipher.final()]);
    const blob = Buffer.concat([Buffer.from('v10', 'latin1'), body]);
    expect(decryptValue(blob, KEY)).toBeUndefined();
  });

  it('strips the 32-byte domain hash Chrome 127 puts in front of the value', () => {
    // Without the strip this returns 32 bytes of binary followed by the cookie,
    // which is not an error and not a usable cookie either: login would send it
    // and Suno would answer 401, blaming the session rather than the decode.
    const blob = encrypt(COOKIE, { domainHash: 'auth.suno.com' });
    expect(decryptValue(blob, KEY)).toBe(COOKIE);
  });

  it('handles v11 blobs the same way', () => {
    expect(decryptValue(encrypt(COOKIE, { version: 'v11' }), KEY)).toBe(COOKIE);
  });

  it('returns undefined rather than garbage when the key is wrong', () => {
    const wrong = pbkdf2Sync('not the password', 'saltysalt', 1003, 16, 'sha1');
    expect(decryptValue(encrypt(COOKIE), wrong)).toBeUndefined();
  });

  it('passes through a value that was never encrypted', () => {
    expect(decryptValue(Buffer.from(COOKIE, 'utf8'), KEY)).toBe(COOKIE);
  });

  it('does not mistake a truncated blob for a cookie', () => {
    expect(decryptValue(Buffer.from('v1', 'latin1'), KEY)).toBeUndefined();
    expect(decryptValue(Buffer.alloc(0), KEY)).toBeUndefined();
  });
});

describe('choosing between profiles', () => {
  const at = (iso: string | undefined, clientId = 'client_same'): FoundCookie => ({
    value: 'x',
    cookieHeader: '__client=x',
    browser: 'chrome',
    profile: iso ?? 'session',
    expiresAt: iso === undefined ? undefined : new Date(iso),
    clientId,
  });

  it('takes the cookie that stays valid longest, within one account', () => {
    const chosen = preferLongestLived([at('2026-10-01'), at('2027-09-09'), at('2026-09-11')]);
    expect(chosen?.profile).toBe('2027-09-09');
  });

  it('prefers a dated cookie over a session cookie with no expiry', () => {
    expect(preferLongestLived([at(undefined), at('2026-10-01')])?.profile).toBe('2026-10-01');
  });

  it('has nothing to choose from an empty list', () => {
    expect(preferLongestLived([])).toBeUndefined();
    expect(chooseCookie([])).toEqual({ kind: 'none' });
  });

  it('refuses to pick between two DIFFERENT accounts', () => {
    // The real machine this was written on: two Chrome profiles, two Clerk
    // clients, cookies seven seconds apart. Longest-lived happened to be right.
    // Eight seconds the other way and a stream bot signs in as the wrong
    // account, silently, with everything still appearing to work.
    const choice = chooseCookie([
      at('2027-09-09T19:49:01Z', 'client_U3YKNsC'),
      at('2027-09-09T19:49:08Z', 'client_UtesQVW'),
    ]);
    expect(choice.kind).toBe('ambiguous');
  });

  it('lets an already-stored session settle it outright', () => {
    // The reconnect case, which is the common one: we are not choosing an
    // account, we are refreshing the one already in use. Note the match wins
    // even though the other cookie lives longer.
    const choice = chooseCookie(
      [at('2028-01-01T00:00:00Z', 'client_other'), at('2027-09-09T19:49:08Z', 'client_mine')],
      { knownClientId: 'client_mine' },
    );
    expect(choice.kind === 'one' && choice.cookie.clientId).toBe('client_mine');
  });

  it('still picks freely when every candidate is the same account', () => {
    const choice = chooseCookie([at('2026-10-01'), at('2027-09-09')]);
    expect(choice.kind === 'one' && choice.cookie.profile).toBe('2027-09-09');
  });
});

describe('reading the client out of a cookie', () => {
  it('finds the Clerk client id in the payload', () => {
    const payload = Buffer.from(
      JSON.stringify({ 'suno.com/claims/client_id': 'client_UtesQVW' }),
      'utf8',
    ).toString('base64url');
    expect(clientIdOf(`header.${payload}.sig`)).toBe('client_UtesQVW');
  });

  it('returns undefined rather than throwing on anything else', () => {
    expect(clientIdOf('not-a-jwt')).toBeUndefined();
    expect(clientIdOf('a.!!!not-base64!!!.c')).toBeUndefined();
    expect(clientIdOf('')).toBeUndefined();
  });
});

describe('Chromium timestamps', () => {
  it('reads microseconds since 1601 as a real date', () => {
    // Read straight out of a live Chrome profile on 2026-09-10, where sqlite's
    // own `datetime(expires_utc/1000000-11644473600)` said 2027-09-09 19:49:01.
    // Anchoring on a real row rather than a hand-computed epoch is the point:
    // the 1601 offset is easy to write down slightly wrong and still look
    // plausible, which puts the expiry two years out and warns about nothing.
    const observed = chromeTime(13_464_992_941_193_585);
    expect(observed?.toISOString().slice(0, 19)).toBe('2027-09-09T19:49:01');
  });

  it('treats zero as a session cookie rather than the year 1601', () => {
    expect(chromeTime(0)).toBeUndefined();
    expect(chromeTime(Number.NaN)).toBeUndefined();
  });
});
