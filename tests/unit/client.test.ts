import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AuthState, FetchLike } from '../../src/auth.js';
import { SunoClient, type DriftBaselines, type RequestInfo as ExchangeInfo } from '../../src/client.js';
import type { DriftReport } from '../../src/drift/detect.js';
import { registryFromMap } from '../../src/drift/registry.js';
import { emptyBaseline, foldIntoBaseline, type Baseline } from '../../src/drift/shape.js';
import { SunoError } from '../../src/errors.js';
import type { RetryOptions } from '../../src/internal/retry.js';
import { MemoryAuthStore } from '../../src/store.js';

/**
 * Every test drives the real SunoClient against a stub `fetch` and an in-memory
 * store. Nothing here touches the network, the filesystem, or a real clock.
 */

const STUDIO = 'https://studio-api-prod.suno.com';
const CLERK = 'https://auth.suno.com';

type FetchInit = Parameters<FetchLike>[1];
type FetchResponse = Awaited<ReturnType<FetchLike>>;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = (call: Call) => FetchResponse | Promise<FetchResponse>;

interface Stub {
  fetch: FetchLike;
  calls: Call[];
  studio: () => Call[];
  clerk: () => Call[];
}

function headerMap(init: FetchInit): Record<string, string> {
  const raw = init?.headers;
  if (raw === undefined || raw === null) return {};
  if (Array.isArray(raw)) return Object.fromEntries(raw as Array<[string, string]>);
  return { ...(raw as unknown as Record<string, string>) };
}

function stub(responder: Responder): Stub {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    // Without this cap, a regression in the 401-replay guard hangs the whole
    // run instead of failing one test.
    if (calls.length >= 20) {
      return Promise.reject(new Error('stub called 21 times: runaway request loop'));
    }
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headerMap(init),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    return Promise.resolve(responder(call));
  };
  return {
    fetch: fetchImpl,
    calls,
    studio: () => calls.filter((c) => c.url.startsWith(STUDIO)),
    clerk: () => calls.filter((c) => c.url.startsWith(CLERK)),
  };
}

function jsonResponse(body: unknown, status = 200): FetchResponse {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as FetchResponse;
}

function textResponse(body: string, status: number): FetchResponse {
  return new Response(body, { status }) as FetchResponse;
}

/** Plays each responder once, then repeats the last one. */
function sequence(...responders: Responder[]): Responder {
  let i = 0;
  return (call) => {
    const next = responders[Math.min(i, responders.length - 1)];
    i += 1;
    if (!next) throw new Error('sequence needs at least one responder');
    return next(call);
  };
}

function clerkResponder(newJwt: string, sessionId = 'sess_discovered'): Responder {
  return (call) =>
    call.url.includes('/tokens')
      ? jsonResponse({ jwt: newJwt })
      : jsonResponse({ response: { last_active_session_id: sessionId } });
}

function route(studio: Responder, clerk: Responder): Responder {
  return (call) => (call.url.startsWith(CLERK) ? clerk(call) : studio(call));
}

/** A JWT with a real base64url payload, so decodeJwtClaims reads a genuine `exp`. */
function signedJwt(label: string, secondsOfLifeLeft: number): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + secondsOfLifeLeft;
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: label, exp })}.signature`;
}

interface SessionOverrides {
  jwt?: string | undefined;
  sessionId?: string | undefined;
  deviceId?: string | undefined;
}

function session(over: SessionOverrides = {}): AuthState {
  return {
    clerkClientCookie: 'client-cookie-value',
    deviceId: 'deviceId' in over ? over.deviceId : 'device-1234',
    sessionId: 'sessionId' in over ? over.sessionId : 'sess_known',
    jwt: 'jwt' in over ? over.jwt : signedJwt('initial', 3600),
  };
}

function fastRetry(maxRetries = 3): RetryOptions {
  return { maxRetries, baseDelayMs: 1, maxDelayMs: 2, jitter: true };
}

interface Extras {
  retry?: Partial<RetryOptions>;
  baselines?: DriftBaselines;
  onDrift?: (report: DriftReport) => void;
  onRequest?: (info: ExchangeInfo) => void;
}

function makeClient(fetchImpl: FetchLike, state: AuthState | undefined, extras: Extras = {}): SunoClient {
  return new SunoClient({
    fetch: fetchImpl,
    store: new MemoryAuthStore(state),
    retry: extras.retry ?? fastRetry(),
    ...(extras.baselines ? { baselines: extras.baselines } : {}),
    ...(extras.onDrift ? { onDrift: extras.onDrift } : {}),
    ...(extras.onRequest ? { onRequest: extras.onRequest } : {}),
  });
}

async function failure(promise: Promise<unknown>): Promise<SunoError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SunoError);
    return err as SunoError;
  }
  throw new Error('expected the request to reject, but it resolved');
}

describe('JWT freshness', () => {
  it('refuses to make any request when there is no stored session', async () => {
    const s = stub(() => jsonResponse({ ok: true }));

    const err = await failure(makeClient(s.fetch, undefined).request({ method: 'GET', path: '/api/x' }));

    expect(err.code).toBe('auth_missing');
    expect(err.alert).toBe(true);
    expect(s.calls).toHaveLength(0);
  });

  it('mints a new JWT for a token that is inside the staleness margin but not yet expired', async () => {
    // Suno starts rejecting tokens roughly halfway through their one hour life
    // while the JWT's own `exp` still says they are good. Trusting `exp` alone
    // means intermittent failures for the last 30 minutes of every token.
    const refreshed = signedJwt('refreshed', 3600);
    const s = stub(route(() => jsonResponse({ ok: true }), clerkResponder(refreshed)));

    await makeClient(s.fetch, session({ jwt: signedJwt('stale', 600) })).request({
      method: 'GET',
      path: '/api/x',
    });

    expect(s.clerk()).toHaveLength(1);
    expect(s.clerk()[0]?.url).toContain('/v1/client/sessions/sess_known/tokens');
    expect(s.studio()).toHaveLength(1);
    expect(s.studio()[0]?.headers['authorization']).toBe(`Bearer ${refreshed}`);
  });

  it('reuses a JWT that still has plenty of life left', async () => {
    const s = stub(route(() => jsonResponse({ ok: true }), clerkResponder('should-not-be-used')));
    const jwt = signedJwt('good', 3600);

    await makeClient(s.fetch, session({ jwt })).request({ method: 'GET', path: '/api/x' });

    expect(s.clerk()).toHaveLength(0);
    expect(s.studio()[0]?.headers['authorization']).toBe(`Bearer ${jwt}`);
  });
});

describe('401 handling', () => {
  it('refreshes and replays exactly once when Suno rejects the JWT', async () => {
    const s = stub(
      route(
        sequence(
          () => textResponse('Unauthorized', 401),
          () => jsonResponse({ ok: true }),
        ),
        clerkResponder(signedJwt('refreshed', 3600)),
      ),
    );

    const result = await makeClient(s.fetch, session()).request({ method: 'GET', path: '/api/x' });

    expect(result).toEqual({ ok: true });
    expect(s.studio()).toHaveLength(2);
    expect(s.clerk()).toHaveLength(1);
  });

  it('sends the newly minted bearer token on the replayed request', async () => {
    const initial = signedJwt('initial', 3600);
    const refreshed = signedJwt('refreshed', 3600);
    const s = stub(
      route(
        sequence(
          () => textResponse('Unauthorized', 401),
          () => jsonResponse({ ok: true }),
        ),
        clerkResponder(refreshed),
      ),
    );

    await makeClient(s.fetch, session({ jwt: initial })).request({ method: 'GET', path: '/api/x' });

    expect(s.studio().map((c) => c.headers['authorization'])).toEqual([
      `Bearer ${initial}`,
      `Bearer ${refreshed}`,
    ]);
  });

  it('gives up after a second consecutive 401 rather than refreshing forever', async () => {
    const s = stub(route(() => textResponse('Unauthorized', 401), clerkResponder(signedJwt('refreshed', 3600))));

    const err = await failure(makeClient(s.fetch, session()).request({ method: 'GET', path: '/api/x' }));

    expect(err.code).toBe('auth_expired');
    expect(s.studio()).toHaveLength(2);
    expect(s.clerk()).toHaveLength(1);
  });

  it('replays a rejected JWT even when retries are switched off', async () => {
    // The refresh-and-replay is bookkeeping, not a retry: a caller who disables
    // retrying still expects a routine token rotation to be handled for them.
    const s = stub(
      route(
        sequence(
          () => textResponse('Unauthorized', 401),
          () => jsonResponse({ ok: true }),
        ),
        clerkResponder(signedJwt('refreshed', 3600)),
      ),
    );

    const result = await makeClient(s.fetch, session(), {
      retry: { maxRetries: 0, baseDelayMs: 1 },
    }).request({ method: 'GET', path: '/api/x' });

    expect(result).toEqual({ ok: true });
    expect(s.studio()).toHaveLength(2);
  });

  it('treats a non-401 "Token validation failed" body as a stale JWT', async () => {
    // Suno's generate endpoint signals a stale token with a 4xx that is not a
    // 401. Keying only on the status code turns a routine token rotation into a
    // hard generation failure.
    const refreshed = signedJwt('refreshed', 3600);
    const s = stub(
      route(
        sequence(
          () => textResponse('{"detail":"Token validation failed"}', 400),
          () => jsonResponse({ ok: true }),
        ),
        clerkResponder(refreshed),
      ),
    );

    const result = await makeClient(s.fetch, session()).request({
      method: 'GET',
      path: '/api/generate/v2-web/',
    });

    expect(result).toEqual({ ok: true });
    expect(s.clerk()).toHaveLength(1);
    expect(s.studio()[1]?.headers['authorization']).toBe(`Bearer ${refreshed}`);
  });

  it('calls out a captcha gate when a freshly minted JWT is rejected the same way', async () => {
    // token_validation_failed is overloaded: it covers both a stale JWT and a
    // captcha token Suno will not accept. Surviving one refresh proves the JWT
    // was never the problem, so reporting "session expired" would send the
    // caller off to re-authenticate a session that is already fine.
    const body = '{"detail":{"error_type":"token_validation_failed"}}';
    const s = stub(route(() => textResponse(body, 401), clerkResponder(signedJwt('refreshed', 3600))));

    const err = await failure(
      makeClient(s.fetch, session()).request({ method: 'POST', path: '/api/generate/v2-web/', body: {} }),
    );

    expect(err.code).toBe('captcha_required');
    expect(err.alert).toBe(true);
    expect(err.retryable).toBe(false);
    expect(s.studio()).toHaveLength(2);
  });
});

describe('retrying', () => {
  it('retries a 429 up to maxRetries and then reports rate_limited', async () => {
    const s = stub(route(() => textResponse('slow down', 429), clerkResponder('unused')));

    const err = await failure(
      makeClient(s.fetch, session(), { retry: fastRetry(2) }).request({ method: 'GET', path: '/api/x' }),
    );

    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(s.studio()).toHaveLength(3);
  });

  it('retries a 500 and returns the response once Suno recovers', async () => {
    const s = stub(
      route(
        sequence(
          () => textResponse('upstream exploded', 500),
          () => textResponse('upstream exploded', 500),
          () => jsonResponse({ ok: true }),
        ),
        clerkResponder('unused'),
      ),
    );

    const result = await makeClient(s.fetch, session()).request({ method: 'GET', path: '/api/x' });

    expect(result).toEqual({ ok: true });
    expect(s.studio()).toHaveLength(3);
  });

  it('makes a single attempt when maxRetries is 0', async () => {
    const s = stub(route(() => textResponse('upstream exploded', 500), clerkResponder('unused')));

    const err = await failure(
      makeClient(s.fetch, session(), { retry: { maxRetries: 0, baseDelayMs: 1 } }).request({
        method: 'GET',
        path: '/api/x',
      }),
    );

    expect(err.code).toBe('api_error');
    expect(s.studio()).toHaveLength(1);
  });

  it('lets a per-request retry override beat the client default', async () => {
    const s = stub(route(() => textResponse('slow down', 429), clerkResponder('unused')));

    const err = await failure(
      makeClient(s.fetch, session(), { retry: fastRetry(3) }).request({
        method: 'GET',
        path: '/api/x',
        retry: { maxRetries: 1 },
      }),
    );

    expect(err.code).toBe('rate_limited');
    expect(s.studio()).toHaveLength(2);
  });

  it('never retries a request Suno rejected as the wrong shape', async () => {
    // A 422 pointing at body.params is Suno's pydantic layer refusing our
    // request shape. Retrying burns quota on something that can never succeed.
    const s = stub(
      route(
        () => textResponse('{"detail": [{"loc": ["body", "params", "title"], "type": "missing"}]}', 422),
        clerkResponder('unused'),
      ),
    );

    const err = await failure(
      makeClient(s.fetch, session()).request({
        method: 'POST',
        path: '/api/generate/v2-web/',
        body: { title: null },
      }),
    );

    expect(err.code).toBe('schema_drift');
    expect(err.retryable).toBe(false);
    expect(err.alert).toBe(true);
    expect(s.studio()).toHaveLength(1);
  });

  it('never retries a 404 for an id that does not exist', async () => {
    const s = stub(route(() => textResponse('no such clip', 404), clerkResponder('unused')));

    const err = await failure(
      makeClient(s.fetch, session()).request({ method: 'GET', path: '/api/clip/deadbeef' }),
    );

    expect(err.code).toBe('not_found');
    expect(err.retryable).toBe(false);
    expect(err.alert).toBe(false);
    expect(s.studio()).toHaveLength(1);
  });

  it('raises a 404 on a known route as route_gone so a human hears about it', async () => {
    // An id-level 404 is the caller's problem; a route-level 404 means Suno
    // moved the endpoint and this library is broken for everyone.
    const s = stub(route(() => textResponse('not found', 404), clerkResponder('unused')));

    const err = await failure(makeClient(s.fetch, session()).request({ method: 'GET', path: '/api/feed/v3' }));

    expect(err.code).toBe('route_gone');
    expect(err.alert).toBe(true);
    expect(s.studio()).toHaveLength(1);
  });
});

describe('single-flight refresh', () => {
  it('runs one Clerk exchange when many requests race on a stale JWT', async () => {
    // Ten workers waking to an expired token used to fire ten exchanges, and
    // Clerk rate-limits.
    const s = stub(route(() => jsonResponse({ ok: true }), clerkResponder(signedJwt('refreshed', 3600))));
    const client = makeClient(s.fetch, session({ jwt: undefined, sessionId: undefined }));

    await Promise.all(['/a', '/b', '/c', '/d', '/e'].map((path) => client.request({ method: 'GET', path })));

    expect(s.clerk().filter((c) => !c.url.includes('/tokens'))).toHaveLength(1);
    expect(s.clerk().filter((c) => c.url.includes('/tokens'))).toHaveLength(1);
    expect(s.studio()).toHaveLength(5);
  });

  it('lets a later request retry the exchange after a refresh failed', async () => {
    // A failed refresh must not latch: if the in-flight promise were left in
    // place, one blip at Clerk would poison every request for the process life.
    //
    // 401 rather than 500 on purpose. A 5xx from Clerk is transient and the
    // client retries through it, so it cannot express "the first attempt ended
    // in failure". Only an explicit rejection of the cookie is terminal.
    let sessionLookups = 0;
    const s = stub(
      route(
        () => jsonResponse({ ok: true }),
        (call) => {
          if (call.url.includes('/tokens')) return jsonResponse({ jwt: signedJwt('refreshed', 3600) });
          sessionLookups += 1;
          return sessionLookups === 1
            ? textResponse('cookie rejected', 401)
            : jsonResponse({ response: { last_active_session_id: 'sess_discovered' } });
        },
      ),
    );
    const client = makeClient(s.fetch, session({ jwt: undefined, sessionId: undefined }));

    const err = await failure(client.request({ method: 'GET', path: '/api/x' }));
    expect(err.code).toBe('auth_dead');

    await expect(client.request({ method: 'GET', path: '/api/x' })).resolves.toEqual({ ok: true });
    expect(sessionLookups).toBe(2);
  });

  it('falls back to a full exchange when the stored session id is no longer good', async () => {
    // A dead session id is recoverable. Declaring the cookie dead here would
    // send the caller to re-export a cookie that still works perfectly well.
    const refreshed = signedJwt('refreshed', 3600);
    const s = stub(
      route(
        () => jsonResponse({ ok: true }),
        (call) => {
          if (!call.url.includes('/tokens')) {
            return jsonResponse({ response: { last_active_session_id: 'sess_current' } });
          }
          return call.url.includes('sess_stale')
            ? textResponse('session not found', 404)
            : jsonResponse({ jwt: refreshed });
        },
      ),
    );

    await makeClient(s.fetch, session({ jwt: undefined, sessionId: 'sess_stale' })).request({
      method: 'GET',
      path: '/api/x',
    });

    expect(s.studio()[0]?.headers['authorization']).toBe(`Bearer ${refreshed}`);
    expect(s.clerk().some((c) => c.url.includes('sess_current/tokens'))).toBe(true);
  });
});

describe('request shape', () => {
  it('sends the browser headers Suno expects on every request', async () => {
    const jwt = signedJwt('good', 3600);
    const s = stub(route(() => jsonResponse({ ok: true }), clerkResponder('unused')));

    await makeClient(s.fetch, session({ jwt, deviceId: 'device-abcdef' })).request({
      method: 'GET',
      path: '/api/x',
    });

    const headers = s.studio()[0]?.headers ?? {};
    expect(headers['authorization']).toBe(`Bearer ${jwt}`);
    expect(headers['device-id']).toBe('device-abcdef');
    expect(headers['origin']).toBe('https://suno.com');
    expect(headers['referer']).toBe('https://suno.com/');
    // Deliberately absent: the real web app does not send it, so sending it is
    // a fingerprint rather than good manners.
    expect(headers['accept']).toBeUndefined();
    expect(headers['accept-language']).toBe('en');
    expect(headers['sec-fetch-site']).toBe('same-site');

    const envelope = JSON.parse(headers['browser-token'] ?? '{}') as { token?: string };
    const decoded = JSON.parse(Buffer.from(envelope.token ?? '', 'base64').toString('utf8')) as {
      timestamp?: number;
    };
    expect(typeof decoded.timestamp).toBe('number');
  });

  it('falls back to a stable random device id when the session never captured one', async () => {
    // An all-zeros placeholder would be the most identifiable value available:
    // every deployment sharing one visibly synthetic id.
    const s1 = stub(route(() => jsonResponse({ ok: true }), clerkResponder('unused')));
    const client = makeClient(s1.fetch, session({ deviceId: undefined }));
    await client.request({ method: 'GET', path: '/api/x' });
    await client.request({ method: 'GET', path: '/api/y' });

    const ids = s1.studio().map((c) => c.headers['device-id']);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe('00000000-0000-0000-0000-000000000000');
    // Stable within one client: a device id that changes per request is as much
    // of a tell as a constant one.
    expect(new Set(ids).size).toBe(1);
  });

  it('sets content-type only when it actually sends a body', async () => {
    const s = stub(route(() => jsonResponse({ ok: true }), clerkResponder('unused')));
    const client = makeClient(s.fetch, session());

    await client.request({ method: 'GET', path: '/api/x' });
    await client.request({ method: 'POST', path: '/api/y', body: { title: 'Song', tags: 'pop' } });

    expect(s.studio()[0]?.headers['content-type']).toBeUndefined();
    expect(s.studio()[0]?.body).toBeUndefined();
    expect(s.studio()[1]?.headers['content-type']).toBe('application/json');
    expect(s.studio()[1]?.body).toBe('{"title":"Song","tags":"pop"}');
  });

  it('drops undefined query values instead of serialising them', async () => {
    const s = stub(route(() => jsonResponse({ ok: true }), clerkResponder('unused')));

    await makeClient(s.fetch, session()).request({
      method: 'GET',
      path: '/api/feed/v3',
      query: { page: 2, is_liked: false, cursor: undefined },
    });

    const url = new URL(s.studio()[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe(`${STUDIO}/api/feed/v3`);
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('is_liked')).toBe('false');
    expect(url.searchParams.has('cursor')).toBe(false);
  });
});

describe('response handling', () => {
  it('reports a body that fails its schema as response_invalid', async () => {
    const s = stub(route(() => jsonResponse({ clips: [{ id: 42 }] }), clerkResponder('unused')));
    const schema = z.object({ clips: z.array(z.object({ id: z.string() })) });

    const err = await failure(
      makeClient(s.fetch, session()).request({ method: 'GET', path: '/api/feed/v3', schema }),
    );

    expect(err.code).toBe('response_invalid');
    expect(err.retryable).toBe(false);
    expect(err.alert).toBe(true);
    expect(err.message).toContain('clips.0.id');
    // The offending payload is kept so the drift can be diagnosed from the log.
    expect(err.body).toContain('42');
    expect(s.studio()).toHaveLength(1);
  });

  it('reports a 200 that is not JSON as response_invalid rather than a network fault', async () => {
    // A maintenance page served with a 200 must not be retried as though it
    // were a transient transport fault; it will say the same thing next time.
    const s = stub(route(() => textResponse('<html>maintenance</html>', 200), clerkResponder('unused')));

    const err = await failure(makeClient(s.fetch, session()).request({ method: 'GET', path: '/api/x' }));

    expect(err.code).toBe('response_invalid');
    expect(s.studio()).toHaveLength(1);
  });

  it('returns null for a 204 instead of trying to parse an empty body', async () => {
    const s = stub(route(() => new Response(null, { status: 204 }) as FetchResponse, clerkResponder('unused')));

    await expect(
      makeClient(s.fetch, session()).request({ method: 'DELETE', path: '/api/gen/trash' }),
    ).resolves.toBeNull();
  });

  it('returns the schema output rather than the raw body', async () => {
    const s = stub(route(() => jsonResponse({ id: 'c1', extra: 'ignored' }), clerkResponder('unused')));
    const schema = z.object({ id: z.string() });

    await expect(
      makeClient(s.fetch, session()).request({ method: 'GET', path: '/api/clip/c1', schema }),
    ).resolves.toEqual({ id: 'c1' });
  });
});

describe('drift reporting', () => {
  const clip = {
    id: 'c1',
    status: 'complete',
    title: 'Song',
    audio_url: 'https://cdn.suno.com/1.mp3',
    created_at: '2026-08-01T00:00:00Z',
    model_name: 'chirp-fenix',
  };
  const feedSample = { clips: [clip], next_cursor: 'cur-1', has_more: true };
  const clipWithoutStatus = {
    id: clip.id,
    title: clip.title,
    audio_url: clip.audio_url,
    created_at: clip.created_at,
    model_name: clip.model_name,
  };
  const driftedSample = { ...feedSample, clips: [clipWithoutStatus] };

  /** Occurrences must reach DEFAULT_MIN_SAMPLES or nothing counts as required. */
  function baselineFor(occurrences: number): Baseline {
    let baseline = emptyBaseline('feed.v3', '2026-08-17T00:00:00Z');
    for (let i = 0; i < occurrences; i++) baseline = foldIntoBaseline(baseline, feedSample);
    return baseline;
  }

  function registry(key: string, occurrences = 5): DriftBaselines {
    return registryFromMap(new Map([[key, baselineFor(occurrences)]]));
  }

  it('calls onDrift when a field this client reads disappears from the response', async () => {
    const reports: DriftReport[] = [];
    const s = stub(route(() => jsonResponse(driftedSample), clerkResponder('unused')));

    await makeClient(s.fetch, session(), {
      baselines: registry('feed.v3'),
      onDrift: (report) => reports.push(report),
    }).request({ method: 'GET', path: '/api/feed/v3', endpointKey: 'feed.v3' });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.endpoint).toBe('feed.v3');
    const finding = reports[0]?.findings.find((f) => f.path === 'clips[].status');
    expect(finding?.kind).toBe('removed');
    expect(finding?.severity).toBe('error');
    expect(reports[0]?.degraded).toBe(true);
  });

  it('stays silent when the response still matches its baseline', async () => {
    const reports: DriftReport[] = [];
    const s = stub(route(() => jsonResponse(feedSample), clerkResponder('unused')));

    await makeClient(s.fetch, session(), {
      baselines: registry('feed.v3'),
      onDrift: (report) => reports.push(report),
    }).request({ method: 'GET', path: '/api/feed/v3', endpointKey: 'feed.v3' });

    expect(reports).toHaveLength(0);
  });

  it('stays silent when a thinly recorded baseline is the only evidence', async () => {
    // Two recorded occurrences are a coincidence, not a contract. Alerting on
    // them produced false "field removed" pages for fields that were merely
    // optional and happened to be set on both samples.
    const reports: DriftReport[] = [];
    const s = stub(route(() => jsonResponse(driftedSample), clerkResponder('unused')));

    await makeClient(s.fetch, session(), {
      baselines: registry('feed.v3', 2),
      onDrift: (report) => reports.push(report),
    }).request({ method: 'GET', path: '/api/feed/v3', endpointKey: 'feed.v3' });

    expect(reports).toHaveLength(0);
  });

  it('does not read an empty clips array as every clip field being deleted', async () => {
    // No clip came back, so nothing under clips[] could have appeared. Reading
    // that as removal would page you on every empty page of a quiet account.
    const reports: DriftReport[] = [];
    const s = stub(
      route(() => jsonResponse({ clips: [], next_cursor: 'cur-1', has_more: true }), clerkResponder('unused')),
    );

    await makeClient(s.fetch, session(), {
      baselines: registry('feed.v3'),
      onDrift: (report) => reports.push(report),
    }).request({ method: 'GET', path: '/api/feed/v3', endpointKey: 'feed.v3' });

    expect(reports.flatMap((r) => r.findings).filter((f) => f.kind === 'removed')).toHaveLength(0);
  });

  it('looks the baseline up by request path when no endpointKey is given', async () => {
    const reports: DriftReport[] = [];
    const s = stub(route(() => jsonResponse(driftedSample), clerkResponder('unused')));

    await makeClient(s.fetch, session(), {
      baselines: registry('/api/feed/v3'),
      onDrift: (report) => reports.push(report),
    }).request({ method: 'GET', path: '/api/feed/v3' });

    expect(reports).toHaveLength(1);
  });

  it('still delivers the response when the onDrift hook throws', async () => {
    const s = stub(route(() => jsonResponse(driftedSample), clerkResponder('unused')));

    const result = await makeClient(s.fetch, session(), {
      baselines: registry('feed.v3'),
      onDrift: () => {
        throw new Error('the Discord webhook is down');
      },
    }).request({ method: 'GET', path: '/api/feed/v3', endpointKey: 'feed.v3' });

    expect(result).toEqual(driftedSample);
  });
});

describe('the onRequest hook', () => {
  it('still delivers the response when the hook throws', async () => {
    const s = stub(route(() => jsonResponse({ ok: true }), clerkResponder('unused')));

    const result = await makeClient(s.fetch, session(), {
      onRequest: () => {
        throw new Error('the metrics sink is down');
      },
    }).request({ method: 'GET', path: '/api/x' });

    expect(result).toEqual({ ok: true });
  });

  it('reports the failed attempt as well as the successful one', async () => {
    const seen: ExchangeInfo[] = [];
    const s = stub(
      route(
        sequence(
          () => textResponse('upstream exploded', 500),
          () => jsonResponse({ ok: true }),
        ),
        clerkResponder('unused'),
      ),
    );

    await makeClient(s.fetch, session(), { onRequest: (info) => seen.push(info) }).request({
      method: 'GET',
      path: '/api/x',
    });

    expect(seen.map((i) => i.status)).toEqual([500, 200]);
    expect(seen.map((i) => i.attempt)).toEqual([0, 1]);
    expect(seen[0]?.error?.code).toBe('api_error');
    expect(seen[1]?.error).toBeUndefined();
    expect(seen.every((i) => i.path === '/api/x' && i.method === 'GET')).toBe(true);
  });
});

describe('cancellation', () => {
  it('turns a caller abort into a non-retryable error and stops', async () => {
    // Retrying an abort would resurrect work the caller just killed.
    const controller = new AbortController();
    const attempts: string[] = [];
    const fetchImpl: FetchLike = (input, init) =>
      new Promise<FetchResponse>((_resolve, reject) => {
        attempts.push(String(input));
        const signal = init?.signal;
        const fail = (): void => {
          const reason: unknown = signal?.reason;
          reject(
            reason instanceof Error ? reason : Object.assign(new Error('aborted'), { name: 'AbortError' }),
          );
        };
        if (signal?.aborted === true) fail();
        else signal?.addEventListener('abort', fail, { once: true });
        controller.abort();
      });

    const err = await failure(
      makeClient(fetchImpl, session()).request({
        method: 'GET',
        path: '/api/x',
        signal: controller.signal,
      }),
    );

    expect(err.code).toBe('network');
    expect(err.retryable).toBe(false);
    expect(attempts).toHaveLength(1);
  });
});
