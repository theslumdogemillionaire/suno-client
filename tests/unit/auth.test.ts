import { describe, expect, it } from 'vitest';

import {
  browserToken,
  clerkRefreshJwt,
  clerkTokenExchange,
  decodeJwtClaims,
  isJwtExpired,
  normalizeCookieInput,
  type FetchLike,
} from '../../src/auth.js';
import { SunoError } from '../../src/errors.js';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** A structurally real token: three segments, unpadded base64url payload. */
function tokenWith(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.c2ln`;
}

function tokenExpiringIn(seconds: number, nowMs: number): string {
  const nowS = Math.floor(nowMs / 1000);
  return tokenWith({ exp: nowS + seconds, iat: nowS - 60, sid: 'sess_live' });
}

function decodeBrowserToken(raw: string): unknown {
  const envelope = JSON.parse(raw) as { token?: unknown };
  return JSON.parse(Buffer.from(String(envelope.token), 'base64').toString('utf8'));
}

function caught(fn: () => unknown): SunoError {
  try {
    fn();
  } catch (err) {
    if (err instanceof SunoError) return err;
    throw err;
  }
  throw new Error('expected the call to throw a SunoError, but it returned');
}

async function rejection(p: Promise<unknown>): Promise<SunoError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SunoError) return err;
    throw err;
  }
  throw new Error('expected the call to reject with a SunoError, but it resolved');
}

interface Call {
  url: string;
  init: Record<string, unknown>;
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init['headers'] ?? {}) as Record<string, string>;
}

const jsonRes =
  (body: unknown, status = 200) =>
  (): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const textRes =
  (body: string, status: number) =>
  (): Response =>
    new Response(body, { status });

function fakeFetch(responses: Array<() => Response>): { impl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const impl = async (input: unknown, init?: unknown): Promise<Response> => {
    calls.push({ url: String(input), init: (init ?? {}) as Record<string, unknown> });
    const next = responses[i++];
    if (next === undefined) throw new Error(`unexpected extra fetch call: ${String(input)}`);
    return next();
  };
  return { impl: impl as unknown as FetchLike, calls };
}

const COOKIE = 'eyJvYmoiOiJjbGllbnQifQ.payload.signature';

describe('browserToken', () => {
  it('wraps a base64 timestamp in a single-field token envelope', () => {
    const raw = browserToken(1_700_000_000_000);
    expect(Object.keys(JSON.parse(raw) as object)).toEqual(['token']);
    expect(decodeBrowserToken(raw)).toEqual({ timestamp: 1_700_000_000_000 });
  });

  it('produces a different token as the clock advances', () => {
    expect(browserToken(1_700_000_000_000)).not.toBe(browserToken(1_700_000_001_000));
  });

  it('stamps the current time when no clock is given', () => {
    // A token frozen at module load would still parse but reads as a replay, so
    // the default argument has to be evaluated per call.
    const before = Date.now();
    const decoded = decodeBrowserToken(browserToken()) as { timestamp: number };
    expect(decoded.timestamp).toBeGreaterThanOrEqual(before);
    expect(decoded.timestamp).toBeLessThanOrEqual(Date.now());
  });
});

describe('decodeJwtClaims', () => {
  it('returns the claims carried by a well-formed token', () => {
    const claims = decodeJwtClaims(tokenWith({ exp: 1_700_003_600, sid: 'sess_abc', tier: 'pro' }));
    expect(claims?.exp).toBe(1_700_003_600);
    expect(claims?.sid).toBe('sess_abc');
    expect(claims?.['tier']).toBe('pro');
  });

  it('returns undefined when the token does not have three segments', () => {
    expect(decodeJwtClaims('')).toBeUndefined();
    expect(decodeJwtClaims('header.payload')).toBeUndefined();
    expect(decodeJwtClaims('a.b.c.d')).toBeUndefined();
  });

  it('returns undefined when the payload segment is empty', () => {
    expect(decodeJwtClaims('header..signature')).toBeUndefined();
  });

  it('returns undefined when the payload is not JSON', () => {
    expect(decodeJwtClaims(`header.${b64url('definitely not json')}.signature`)).toBeUndefined();
  });

  it('returns undefined when the payload is not base64 at all', () => {
    expect(decodeJwtClaims('header.@@@@@@.signature')).toBeUndefined();
  });

  it('never throws on hostile input, whatever the payload decodes to', () => {
    // Everything here reaches this function straight from a config file or a
    // human paste, so a throw would surface as a crash rather than a re-login.
    for (const jwt of ['', 'not-a-jwt', 'a.b.c', `h.${b64url('123')}.s`, `h.${b64url('"str"')}.s`]) {
      expect(() => decodeJwtClaims(jwt)).not.toThrow();
    }
  });
});

describe('isJwtExpired', () => {
  const now = 1_700_000_000_000;

  it('calls a token with 40 minutes of life left fresh', () => {
    expect(isJwtExpired(tokenExpiringIn(40 * 60, now), now)).toBe(false);
  });

  it('calls a token with 20 minutes of life left stale even though its exp is still in the future', () => {
    // The whole point of the margin: Suno's generation endpoint starts
    // answering `Token validation failed` about halfway through the hour, long
    // before exp says the token is done.
    const jwt = tokenExpiringIn(20 * 60, now);
    expect(decodeJwtClaims(jwt)?.exp).toBeGreaterThan(Math.floor(now / 1000));
    expect(isJwtExpired(jwt, now)).toBe(true);
  });

  it('flips to stale at exactly 30 minutes of remaining life', () => {
    expect(isJwtExpired(tokenExpiringIn(1801, now), now)).toBe(false);
    expect(isJwtExpired(tokenExpiringIn(1800, now), now)).toBe(true);
  });

  it('treats an absent or empty token as expired', () => {
    expect(isJwtExpired(undefined, now)).toBe(true);
    expect(isJwtExpired('', now)).toBe(true);
  });

  it('treats a token with no exp claim as expired', () => {
    expect(isJwtExpired(tokenWith({ sid: 'sess_abc' }), now)).toBe(true);
  });

  it('treats a non-numeric exp as expired rather than coercing it', () => {
    expect(isJwtExpired(tokenWith({ exp: '9999999999' }), now)).toBe(true);
    expect(isJwtExpired(tokenWith({ exp: null }), now)).toBe(true);
  });

  it('treats undecodable garbage as expired', () => {
    expect(isJwtExpired('not-a-jwt', now)).toBe(true);
    expect(isJwtExpired('a.b.c', now)).toBe(true);
    expect(isJwtExpired(`h.${b64url('123')}.s`, now)).toBe(true);
  });

  it('treats an already-elapsed exp as expired', () => {
    expect(isJwtExpired(tokenExpiringIn(-1, now), now)).toBe(true);
  });

  it('compares against the current clock when no time is given', () => {
    expect(isJwtExpired(tokenExpiringIn(40 * 60, Date.now()))).toBe(false);
    expect(isJwtExpired(tokenExpiringIn(20 * 60, Date.now()))).toBe(true);
  });
});

describe('normalizeCookieInput', () => {
  it('accepts a bare __client value and builds the Cookie header around it', () => {
    const result = normalizeCookieInput(COOKIE);
    expect(result.clerkClientCookie).toBe(COOKIE);
    expect(result.cookieHeader).toBe(`__client=${COOKIE}`);
    expect(result.deviceId).toBeUndefined();
  });

  it('trims the whitespace a copy-paste drags along', () => {
    // A trailing newline off a terminal paste otherwise ends up inside the
    // header value and comes back as a 401 that reads like a dead session.
    expect(normalizeCookieInput(`  ${COOKIE}\n`).clerkClientCookie).toBe(COOKIE);
  });

  it('accepts a full devtools Cookie header and drops the header name from the value', () => {
    const result = normalizeCookieInput(`Cookie: __client=${COOKIE}; ajs_anonymous_id=dev-1; __cf_bm=xyz`);
    expect(result.clerkClientCookie).toBe(COOKIE);
    expect(result.cookieHeader.toLowerCase().startsWith('cookie:')).toBe(false);
    expect(result.cookieHeader).toContain('__cf_bm=xyz');
    expect(result.deviceId).toBe('dev-1');
  });

  it('ignores the case of the Cookie prefix', () => {
    expect(normalizeCookieInput(`cookie: __client=${COOKIE}`).clerkClientCookie).toBe(COOKIE);
  });

  it('does not mistake a value that merely starts with the letters "cookie" for a header', () => {
    expect(normalizeCookieInput('cookiemonster').clerkClientCookie).toBe('cookiemonster');
  });

  it('tolerates spaces around the separators in a hand-edited header', () => {
    const result = normalizeCookieInput(`__client = ${COOKIE} ; ajs_anonymous_id = dev-1`);
    expect(result.clerkClientCookie).toBe(COOKIE);
    expect(result.deviceId).toBe('dev-1');
  });

  it('unwraps the URL-encoded quotes Segment writes around ajs_anonymous_id', () => {
    // Segment stores the anonymous id JSON-quoted, so the raw cookie value is
    // %22uuid%22. Sending those quotes as the device-id header is a mismatch
    // against every other request the account has ever made.
    const result = normalizeCookieInput(`__client=${COOKIE}; ajs_anonymous_id=%2263f0-42%22`);
    expect(result.deviceId).toBe('63f0-42');
  });

  it('unwraps literal quotes around ajs_anonymous_id too', () => {
    expect(normalizeCookieInput(`__client=${COOKIE}; ajs_anonymous_id="63f0-42"`).deviceId).toBe('63f0-42');
  });

  it('leaves the device id undefined rather than empty when ajs_anonymous_id is blank', () => {
    // Undefined lets the caller fall back to the zero UUID; an empty string
    // would be sent as an empty device-id header.
    expect(normalizeCookieInput(`__client=${COOKIE}; ajs_anonymous_id=`).deviceId).toBeUndefined();
    expect(normalizeCookieInput(`__client=${COOKIE}; ajs_anonymous_id=%22%22`).deviceId).toBeUndefined();
  });

  it('leaves the device id undefined when the header carries no ajs_anonymous_id', () => {
    expect(normalizeCookieInput(`__client=${COOKIE}; __cf_bm=xyz`).deviceId).toBeUndefined();
  });

  it('rejects a Cookie header that has no __client field', () => {
    const err = caught(() => normalizeCookieInput('Cookie: __session=abc; ajs_anonymous_id=dev-1'));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('__client');
  });

  it('rejects a header whose __client field is present but empty', () => {
    expect(caught(() => normalizeCookieInput('__client=; __session=abc')).code).toBe('invalid_input');
  });

  it('rejects empty input in every shape it arrives in', () => {
    for (const input of ['', '   ', '\n', 'Cookie:', 'Cookie:   ']) {
      expect(caught(() => normalizeCookieInput(input)).code).toBe('invalid_input');
    }
  });

  it('rejects a bare value containing a semicolon instead of silently truncating it', () => {
    // A semicolon means the paste is a header fragment. Keeping only the part
    // before it would send a cookie that is a prefix of the real one, which
    // Suno answers with a 401 indistinguishable from an expired session.
    expect(caught(() => normalizeCookieInput('abc;def')).code).toBe('invalid_input');
  });
});

describe('clerkRefreshJwt', () => {
  it('returns the minted token', async () => {
    const { impl } = fakeFetch([jsonRes({ jwt: 'minted.jwt.value' })]);
    await expect(clerkRefreshJwt(impl, COOKIE, 'sess_1')).resolves.toBe('minted.jwt.value');
  });

  it('presents the client cookie as both the authorization header and the __client cookie', async () => {
    // Clerk 401s if either half is missing, and a 401 here is misread as a dead
    // session by everything downstream.
    const { impl, calls } = fakeFetch([jsonRes({ jwt: 'x' })]);
    await clerkRefreshJwt(impl, COOKIE, 'sess_1');
    const headers = headersOf(calls[0]);
    expect(headers['authorization']).toBe(COOKIE);
    expect(headers['cookie']).toBe(`__client=${COOKIE}`);
    expect(calls[0]?.init['method']).toBe('POST');
  });

  it('mints against the session it was given, with the Clerk version query Clerk requires', async () => {
    const { impl, calls } = fakeFetch([jsonRes({ jwt: 'x' })]);
    await clerkRefreshJwt(impl, COOKIE, 'sess_1');
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/client/sessions/sess_1/tokens');
    expect(url.searchParams.get('__clerk_api_version')).not.toBeNull();
    expect(url.searchParams.get('_clerk_js_version')).not.toBeNull();
  });

  it('treats a 200 that carries no jwt as a dead session', async () => {
    // Clerk answers 200 with an empty body once the client cookie is revoked,
    // so the status code alone never proves the refresh worked.
    for (const body of [{}, { jwt: '' }, { jwt: null }]) {
      const { impl } = fakeFetch([jsonRes(body)]);
      const err = await rejection(clerkRefreshJwt(impl, COOKIE, 'sess_1'));
      expect(err.code).toBe('auth_dead');
      expect(err.alert).toBe(true);
    }
  });

  it('reports 401 and 403 as a dead session and keeps the body for forensics', async () => {
    for (const status of [401, 403]) {
      const { impl } = fakeFetch([textRes('{"errors":[{"code":"session_not_found"}]}', status)]);
      const err = await rejection(clerkRefreshJwt(impl, COOKIE, 'sess_1'));
      expect(err.code).toBe('auth_dead');
      expect(err.alert).toBe(true);
      expect(err.status).toBe(status);
      expect(err.body).toContain('session_not_found');
    }
  });

  it('does not blame the cookie when Clerk itself returns a server error', async () => {
    const { impl } = fakeFetch([textRes('bad gateway', 502)]);
    const err = await rejection(clerkRefreshJwt(impl, COOKIE, 'sess_1'));
    expect(err.code).not.toBe('auth_dead');
    expect(err.code).toBe('api_error');
    expect(err.status).toBe(502);
  });

  it('passes an abort signal through, and omits the key entirely when there is none', async () => {
    // fetch implementations differ on `signal: undefined`; some reject it.
    const controller = new AbortController();
    const withSignal = fakeFetch([jsonRes({ jwt: 'x' })]);
    await clerkRefreshJwt(withSignal.impl, COOKIE, 'sess_1', controller.signal);
    expect(withSignal.calls[0]?.init['signal']).toBe(controller.signal);

    const without = fakeFetch([jsonRes({ jwt: 'x' })]);
    await clerkRefreshJwt(without.impl, COOKIE, 'sess_1');
    expect('signal' in (without.calls[0]?.init ?? {})).toBe(false);
  });
});

describe('clerkTokenExchange', () => {
  const lookup = (body: unknown) => jsonRes(body);

  it('discovers the active session, then mints a token against it', async () => {
    const { impl, calls } = fakeFetch([
      lookup({ response: { last_active_session_id: 'sess_A', sessions: [{ id: 'sess_B' }] } }),
      jsonRes({ jwt: 'fresh.jwt.value' }),
    ]);
    const result = await clerkTokenExchange(impl, COOKIE);
    expect(result).toEqual({ sessionId: 'sess_A', jwt: 'fresh.jwt.value' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init['method']).toBe('GET');
    expect(new URL(calls[1]?.url ?? '').pathname).toBe('/v1/client/sessions/sess_A/tokens');
  });

  it('falls back to the first listed session when Clerk sends no last_active_session_id', async () => {
    // Clerk leaves last_active_session_id null on a client that has not made a
    // request since signing in, which is exactly the freshly-exported cookie
    // case this function exists to serve.
    const { impl } = fakeFetch([
      lookup({ response: { last_active_session_id: null, sessions: [{ id: 'sess_B' }] } }),
      jsonRes({ jwt: 'fresh.jwt.value' }),
    ]);
    await expect(clerkTokenExchange(impl, COOKIE)).resolves.toEqual({
      sessionId: 'sess_B',
      jwt: 'fresh.jwt.value',
    });
  });

  it('reports a dead session when the cookie has no session on it', async () => {
    for (const body of [{ response: { sessions: [] } }, { response: {} }, {}]) {
      const { impl, calls } = fakeFetch([lookup(body)]);
      const err = await rejection(clerkTokenExchange(impl, COOKIE));
      expect(err.code).toBe('auth_dead');
      expect(err.alert).toBe(true);
      expect(calls).toHaveLength(1);
    }
  });

  it('reports a dead session when the session id is not a string', async () => {
    const { impl } = fakeFetch([lookup({ response: { last_active_session_id: 42, sessions: [{ id: 7 }] } })]);
    expect((await rejection(clerkTokenExchange(impl, COOKIE))).code).toBe('auth_dead');
  });

  it('sends the client cookie on the session lookup', async () => {
    const { impl, calls } = fakeFetch([
      lookup({ response: { last_active_session_id: 'sess_A' } }),
      jsonRes({ jwt: 'x' }),
    ]);
    await clerkTokenExchange(impl, COOKIE);
    expect(headersOf(calls[0])['cookie']).toBe(`__client=${COOKIE}`);
  });

  it('carries the abort signal into both round trips', async () => {
    const controller = new AbortController();
    const { impl, calls } = fakeFetch([
      lookup({ response: { last_active_session_id: 'sess_A' } }),
      jsonRes({ jwt: 'x' }),
    ]);
    await clerkTokenExchange(impl, COOKIE, controller.signal);
    expect(calls.map((c) => c.init['signal'])).toEqual([controller.signal, controller.signal]);
  });

  it('surfaces a failed session lookup with the status and body attached', async () => {
    const { impl } = fakeFetch([textRes('client not found', 401)]);
    const err = await rejection(clerkTokenExchange(impl, COOKIE));
    expect(err.status).toBe(401);
    expect(err.body).toContain('client not found');
    expect(err.alert).toBe(true);
  });
});
