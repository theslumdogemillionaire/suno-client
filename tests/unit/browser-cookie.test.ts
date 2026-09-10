import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { chromeTime, decryptValue, preferLongestLived, type FoundCookie } from '../../src/browser-cookie.js';

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
  const at = (iso: string | undefined): FoundCookie => ({
    value: 'x',
    browser: 'chrome',
    profile: iso ?? 'session',
    expiresAt: iso === undefined ? undefined : new Date(iso),
  });

  it('takes the cookie that stays valid longest', () => {
    // Two profiles signed into the same account is the normal case on a machine
    // where someone tested something in a second profile. Picking arbitrarily
    // would authenticate a bot as whichever account that happened to be.
    const chosen = preferLongestLived([at('2026-10-01'), at('2027-09-09'), at('2026-09-11')]);
    expect(chosen?.profile).toBe('2027-09-09');
  });

  it('prefers a dated cookie over a session cookie with no expiry', () => {
    expect(preferLongestLived([at(undefined), at('2026-10-01')])?.profile).toBe('2026-10-01');
  });

  it('has nothing to choose from an empty list', () => {
    expect(preferLongestLived([])).toBeUndefined();
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
