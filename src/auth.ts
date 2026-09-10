import { SunoError } from './errors.js';

const CLERK_BASE = 'https://auth.suno.com';
const CLERK_JS_VERSION = '5.117.0';
const CLERK_API_VERSION = '2025-11-10';

/**
 * Suno issues 1-hour JWTs, but their generation endpoint starts rejecting
 * tokens with `Token validation failed` roughly 30 minutes in, while the JWT's
 * own `exp` claim still says it is good. So we treat "under 30 minutes of life
 * left" as expired and mint a new one. This costs one cheap Clerk round trip
 * and removes an entire class of intermittent failure.
 */
const STALENESS_MARGIN_SECONDS = 1800;

export interface AuthState {
  jwt?: string | undefined;
  sessionId?: string | undefined;
  deviceId?: string | undefined;
  /**
   * The Clerk `__client` cookie. The real secret; everything else here is
   * derived from it and can be re-minted while it lives.
   *
   * Long-lived, and by more than this comment used to claim: read straight out
   * of a browser profile on 2026-09-10, its expiry was 2027-09-09 — a year, not
   * the week originally assumed. Which means a dead session is almost never an
   * expired cookie. It is a cookie that was rotated by signing in again
   * somewhere else, or one that was never stored in the first place.
   */
  clerkClientCookie: string;
}

export interface JwtClaims {
  exp?: number;
  iat?: number;
  sid?: string;
  [key: string]: unknown;
}

export function decodeJwtClaims(jwt: string): JwtClaims | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (payload === undefined) return undefined;
  try {
    const json = Buffer.from(payload, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    // A payload of `null` or `123` parses fine and would otherwise escape as a
    // JwtClaims, so every caller reading `.exp` would need its own guard.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as JwtClaims;
  } catch {
    return undefined;
  }
}

export function isJwtExpired(jwt: string | undefined, nowMs: number = Date.now()): boolean {
  if (!jwt) return true;
  const claims = decodeJwtClaims(jwt);
  const exp = claims?.exp;
  if (typeof exp !== 'number') return true;
  return Math.floor(nowMs / 1000) + STALENESS_MARGIN_SECONDS >= exp;
}

/**
 * The `browser-token` header the web app sends on every studio-api request.
 * It is a base64 of a timestamp wrapped in a JSON envelope, regenerated per
 * request. Not a security measure so much as a liveness check, but requests
 * without it are treated as suspicious.
 */
export function browserToken(nowMs: number = Date.now()): string {
  const payload = JSON.stringify({ timestamp: nowMs });
  return JSON.stringify({ token: Buffer.from(payload, 'utf8').toString('base64') });
}

export interface NormalizedCookie {
  clerkClientCookie: string;
  cookieHeader: string;
  deviceId: string | undefined;
}

function stripCookiePrefix(input: string): string {
  const trimmed = input.trim();
  return trimmed.slice(0, 7).toLowerCase() === 'cookie:' ? trimmed.slice(7).trim() : trimmed;
}

function sanitizeDeviceId(value: string): string | undefined {
  const cleaned = value.trim().replaceAll('%22', '"').replace(/^["']|["']$/g, '').trim();
  if (cleaned === '' || cleaned.includes(';')) return undefined;
  return cleaned;
}

/**
 * Accepts either a bare `__client` value or a full `Cookie:` header pasted out
 * of devtools. Both are things a human will realistically hand us, and getting
 * this wrong produces a 401 that looks like an expired session rather than a
 * paste error.
 */
export function normalizeCookieInput(input: string): NormalizedCookie {
  const normalized = stripCookiePrefix(input);
  const pairs = new Map<string, string>();
  for (const part of normalized.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name !== '') pairs.set(name, value);
  }

  const client = pairs.get('__client');
  if (client !== undefined && client !== '') {
    const anon = pairs.get('ajs_anonymous_id');
    return {
      clerkClientCookie: client,
      cookieHeader: normalized,
      deviceId: anon === undefined ? undefined : sanitizeDeviceId(anon),
    };
  }

  if (normalized.includes(';') || normalized.includes('=')) {
    throw new SunoError({
      code: 'invalid_input',
      message: 'cookie header did not contain a __client field',
    });
  }
  if (normalized === '') {
    throw new SunoError({ code: 'invalid_input', message: 'empty Clerk __client cookie' });
  }
  return {
    clerkClientCookie: normalized,
    cookieHeader: `__client=${normalized}`,
    deviceId: undefined,
  };
}

function clerkUrl(path: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${CLERK_BASE}${path}${sep}__clerk_api_version=${CLERK_API_VERSION}&_clerk_js_version=${CLERK_JS_VERSION}`;
}

function clerkHeaders(clerkCookie: string): Record<string, string> {
  return {
    authorization: clerkCookie,
    cookie: `__client=${clerkCookie}`,
    origin: 'https://suno.com',
    referer: 'https://suno.com/',
  };
}

export type FetchLike = typeof fetch;

/**
 * Not every Clerk failure means the cookie is dead.
 *
 * 401 and 403 do. A 429 or a 5xx is Clerk having a bad minute, and reporting
 * that as a revoked session sends someone to re-export a cookie that was fine.
 */
function clerkError(status: number, body: string, what: string): SunoError {
  if (status === 401 || status === 403) {
    return new SunoError({
      code: 'auth_dead',
      message: `${what} rejected the session cookie (${status})`,
      status,
      body,
      alert: true,
    });
  }
  return new SunoError({
    code: status === 429 ? 'rate_limited' : 'api_error',
    message: `${what} failed transiently (${status})`,
    status,
    body,
    retryable: true,
  });
}

async function readJson(res: Response, what: string): Promise<unknown> {
  // A 2xx carrying HTML is a real failure mode here: auth.suno.com sits behind
  // Cloudflare, whose interstitial arrives with status 200. An unguarded
  // res.json() would surface that as a bare SyntaxError with no context.
  try {
    return await res.json();
  } catch (cause) {
    throw new SunoError({
      code: 'response_invalid',
      message: `${what} returned a non-JSON body (HTTP ${res.status}); an interstitial or captcha page is the usual cause`,
      status: res.status,
      cause,
      retryable: true,
    });
  }
}

async function clerkPost(
  fetchImpl: FetchLike,
  url: string,
  clerkCookie: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { ...clerkHeaders(clerkCookie), 'content-type': 'application/x-www-form-urlencoded' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw clerkError(res.status, await res.text().catch(() => ''), 'Clerk token refresh');
  }
  return readJson(res, 'Clerk token refresh');
}

/** Mint a fresh JWT from a known session id. One round trip, the hot path. */
export async function clerkRefreshJwt(
  fetchImpl: FetchLike,
  clerkCookie: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  const body = (await clerkPost(
    fetchImpl,
    clerkUrl(`/v1/client/sessions/${sessionId}/tokens`),
    clerkCookie,
    signal,
  )) as { jwt?: unknown };
  if (typeof body.jwt !== 'string' || body.jwt === '') {
    throw new SunoError({
      code: 'auth_dead',
      message: 'Clerk returned no JWT: the session cookie is no longer valid',
      alert: true,
    });
  }
  return body.jwt;
}

/** Discover the session id from the cookie, then mint a JWT. Two round trips. */
export async function clerkTokenExchange(
  fetchImpl: FetchLike,
  clerkCookie: string,
  signal?: AbortSignal,
): Promise<{ sessionId: string; jwt: string }> {
  const res = await fetchImpl(clerkUrl('/v1/client'), {
    method: 'GET',
    headers: clerkHeaders(clerkCookie),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw clerkError(res.status, await res.text().catch(() => ''), 'Clerk session lookup');
  }
  const parsed = (await readJson(res, 'Clerk session lookup')) as {
    response?: { last_active_session_id?: unknown; sessions?: Array<{ id?: unknown }> };
  };
  const response = parsed.response;
  const direct = response?.last_active_session_id;
  const first = response?.sessions?.[0]?.id;
  const sessionId = typeof direct === 'string' ? direct : typeof first === 'string' ? first : undefined;
  if (sessionId === undefined) {
    throw new SunoError({
      code: 'auth_dead',
      message: 'no active Suno session on this cookie: sign in at suno.com and re-export it',
      alert: true,
    });
  }
  const jwt = await clerkRefreshJwt(fetchImpl, clerkCookie, sessionId, signal);
  return { sessionId, jwt };
}
