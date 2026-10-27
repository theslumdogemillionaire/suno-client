import { randomUUID } from 'node:crypto';

import type { ZodType, ZodTypeDef } from 'zod';

import {
  browserToken,
  clerkRefreshJwt,
  clerkTokenExchange,
  isJwtExpired,
  normalizeCookieInput,
  type AuthState,
  type FetchLike,
} from './auth.js';
import { detectDrift, type DriftReport } from './drift/detect.js';
import type { Baseline } from './drift/shape.js';
import {
  abortedError,
  isRouteLevelPath,
  looksLikeMissingRoute,
  isTokenValidationFailure,
  looksLikeAuthExpired,
  looksLikeInsufficientCredits,
  looksLikeSchemaDrift,
  planGateDetail,
  SunoError,
  truncate,
} from './errors.js';
import { backoffDelay, DEFAULT_RETRY, singleFlight, sleep, type RetryOptions } from './internal/retry.js';
import { FileAuthStore, MemoryAuthStore, type AuthStore } from './store.js';

const DEFAULT_BASE_URL = 'https://studio-api-prod.suno.com';
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

export interface DriftBaselines {
  get(endpointKey: string): Baseline | undefined;
  consumedPaths(endpointKey: string): readonly string[] | undefined;
}

export interface SunoClientOptions {
  /** A `__client` cookie value, or a full Cookie header pasted from devtools. */
  cookie?: string;
  /** Where the session is persisted. Defaults to a 0600 file under XDG config. */
  store?: AuthStore;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Per-request timeout. Generation submits are fast; polling does the waiting. */
  timeoutMs?: number;
  retry?: Partial<RetryOptions>;
  userAgent?: string;
  /** Matches the web app's own header. Defaults to `en`. */
  acceptLanguage?: string;
  /**
   * Stable device id. Defaults to a random UUID generated once per client and
   * persisted with the session. Set it explicitly to keep one identity across
   * restarts when you are not using a file-backed store.
   */
  deviceId?: string;
  baselines?: DriftBaselines;
  /**
   * Called whenever a response's shape diverges from its recorded baseline.
   * This is the hook you wire to Sentry, a Discord webhook, or a log line you
   * will actually read. Drift is silent by default and that silence is exactly
   * how a client rots.
   */
  onDrift?: (report: DriftReport) => void;
  /** Called for every completed HTTP exchange. Useful for metrics. */
  onRequest?: (info: RequestInfo) => void;
}

export interface RequestInfo {
  method: string;
  path: string;
  status: number | undefined;
  durationMs: number;
  attempt: number;
  error?: SunoError;
}

export interface RequestOptions<T> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  // Input type is deliberately `any`: zod's passthrough + default schemas have
  // an input type that differs from their output type, and we only ever feed
  // these parsed JSON.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema?: ZodType<T, ZodTypeDef, any>;
  /** Key under which this response's drift baseline is registered. */
  endpointKey?: string;
  signal?: AbortSignal;
  /** Send no session at all, even when one is stored. */
  skipAuth?: boolean;
  /** Override retry behaviour for a single call. */
  retry?: Partial<RetryOptions>;
}

export class SunoClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions;
  private readonly userAgent: string;
  private readonly store: AuthStore;
  private readonly baselines: DriftBaselines | undefined;
  private readonly onDrift: ((report: DriftReport) => void) | undefined;
  private readonly onRequest: ((info: RequestInfo) => void) | undefined;

  private readonly acceptLanguage: string;
  /**
   * Used when the session carries no `ajs_anonymous_id`. Random per process and
   * persisted with the session on first save, so it stays stable for an
   * installation instead of announcing itself as a placeholder.
   */
  private readonly fallbackDeviceId: string;

  private auth: AuthState | undefined;
  private loaded = false;
  private readonly refreshOnce = singleFlight<void>();

  constructor(options: SunoClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.userAgent = options.userAgent ?? DEFAULT_UA;
    this.acceptLanguage = options.acceptLanguage ?? 'en';
    this.fallbackDeviceId = options.deviceId ?? randomUUID();
    this.baselines = options.baselines;
    this.onDrift = options.onDrift;
    this.onRequest = options.onRequest;

    if (options.cookie !== undefined && options.cookie !== '') {
      const normalized = normalizeCookieInput(options.cookie);
      this.auth = {
        clerkClientCookie: normalized.clerkClientCookie,
        deviceId: normalized.deviceId ?? this.fallbackDeviceId,
      };
      this.loaded = true;
      this.store = options.store ?? new MemoryAuthStore(this.auth);
    } else {
      this.store = options.store ?? new FileAuthStore();
    }
  }

  /**
   * Resolve a usable session: load from the store if needed, then mint or
   * refresh the JWT. Safe to call concurrently; the refresh is single-flighted.
   */
  async ensureAuth(signal?: AbortSignal): Promise<AuthState> {
    if (!this.loaded) {
      const loaded = await this.store.load();
      // Re-check after the await. A concurrent caller may have refreshed the
      // JWT while this one was reading from disk, and assigning the stale state
      // over the top makes it look expired again - defeating the single-flight
      // and firing a second Clerk exchange for one stale token.
      if (!this.loaded) {
        // A stored session without a device id (a bare-cookie login, or one
        // saved by an older version) adopts this process's fallback, which the
        // next save persists. Otherwise every process sent a fresh random id.
        this.auth =
          loaded !== undefined && loaded.deviceId === undefined
            ? { ...loaded, deviceId: this.fallbackDeviceId }
            : loaded;
        this.loaded = true;
      }
    }
    const auth = this.auth;
    if (!auth) {
      throw new SunoError({
        code: 'auth_missing',
        message:
          'no Suno session. Pass { cookie } or run `suno-client login` with the __client cookie from suno.com.',
        alert: true,
      });
    }
    if (!isJwtExpired(auth.jwt)) return auth;

    await this.refreshOnce(async () => {
      const current = this.auth;
      if (!current) return;
      // Another caller may have refreshed while we queued.
      if (!isJwtExpired(current.jwt)) return;
      if (current.sessionId !== undefined) {
        let jwt: string | undefined;
        try {
          jwt = await clerkRefreshJwt(
            this.fetchImpl,
            current.clerkClientCookie,
            current.sessionId,
            signal,
          );
        } catch (err) {
          // A stale session id is recoverable: Clerk refuses it with a 4xx,
          // and a full exchange finds the live one. Anything else - Clerk
          // throttling or failing, the network, an abort - says nothing about
          // the session id, and falling through only hit Clerk again, harder.
          if (!isStaleSessionError(err)) throw err;
        }
        if (jwt !== undefined) {
          await this.adoptRefreshed(current, { jwt });
          return;
        }
      }
      const { sessionId, jwt } = await clerkTokenExchange(
        this.fetchImpl,
        current.clerkClientCookie,
        signal,
      );
      await this.adoptRefreshed(current, { sessionId, jwt });
    });

    const refreshed = this.auth;
    if (!refreshed) {
      throw new SunoError({ code: 'auth_missing', message: 'the session was cleared while this request refreshed it' });
    }
    if (!refreshed.jwt) {
      throw new SunoError({ code: 'auth_dead', message: 'JWT refresh produced no token', alert: true });
    }
    return refreshed;
  }

  /**
   * Keep a freshly minted token, unless the session changed while Clerk was
   * answering. A logout, or a login with another cookie, made during the round
   * trip must win: writing the captured state back resurrected the old session.
   */
  private async adoptRefreshed(from: AuthState, update: Partial<AuthState>): Promise<void> {
    if (this.auth === undefined || this.auth.clerkClientCookie !== from.clerkClientCookie) return;
    this.auth = { ...this.auth, ...update };
    await this.store.save(this.auth);
  }

  /**
   * Drop the JWT Suno just rejected, so the next attempt mints a fresh one.
   *
   * Only that JWT. A 401 for a request sent with the old token can land after
   * a concurrent request already refreshed, and clearing whatever was current
   * threw that fresh token away and fired another Clerk exchange per
   * straggler: the herd the single-flight exists to prevent.
   */
  private async invalidateJwt(rejected: string | undefined): Promise<void> {
    if (!this.auth || rejected === undefined || this.auth.jwt !== rejected) return;
    this.auth = { ...this.auth, jwt: undefined };
    await this.store.save(this.auth).catch(() => undefined);
  }

  private buildUrl(path: string, query: RequestOptions<unknown>['query']): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * Headers, matched against what suno.com actually sends.
   *
   * Captured from the live web app on 2026-08-17. Its own code sets only four:
   * `accept-language`, `authorization`, `browser-token`, `device-id`, plus
   * `content-type` on a POST. `origin`, `referer`, `user-agent` and the
   * `sec-*` family are added by the browser itself, so a non-browser client has
   * to supply them by hand or it stands out immediately.
   *
   * Two things deliberately differ from a naive port:
   *
   *   - No `accept: application/json`. The web app does not send it, so sending
   *     it is a tell rather than good manners.
   *   - `device-id` is a stable random UUID per installation, never a constant.
   *     The all-zeros placeholder a fallback would give you is the single most
   *     obvious fingerprint available: every deployment sharing one device id,
   *     and that id being visibly synthetic.
   *
   * What this does NOT do, and cannot from Node: match Chrome's TLS handshake
   * or HTTP/2 SETTINGS frames. JA3/JA4 fingerprinting sees straight through
   * this. If you need that, the request has to leave from a real browser or
   * from something like curl-impersonate. See docs/STATUS.md.
   */
  private headers(auth: AuthState | undefined, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'accept-language': this.acceptLanguage,
      'user-agent': this.userAgent,
      'browser-token': browserToken(),
      origin: 'https://suno.com',
      referer: 'https://suno.com/',
      'device-id': auth?.deviceId ?? this.fallbackDeviceId,
      // Chrome sends these on every same-site XHR. Their absence is as much a
      // signal as a wrong value would be.
      'sec-fetch-site': 'same-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    };
    if (auth?.jwt) headers['authorization'] = `Bearer ${auth.jwt}`;
    if (hasBody) headers['content-type'] = 'application/json';
    return headers;
  }

  async request<T = unknown>(options: RequestOptions<T>): Promise<T> {
    const retry = { ...this.retry, ...options.retry };
    let authRetried = false;

    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      let status: number | undefined;
      // One budget for the whole attempt: the session refresh, the headers AND
      // the body. Clearing the timer once headers arrived left a stalled body,
      // and every Clerk call, waiting on undici's 300s defaults or forever.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('request timeout')), this.timeoutMs);
      const onOuterAbort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', onOuterAbort, { once: true });
      try {
        // An 'abort' listener added to a signal that already fired never runs,
        // so without these checks a create cancelled before it was sent - or
        // during the session refresh - still went out and was billed.
        options.signal?.throwIfAborted();
        const auth = options.skipAuth ? undefined : await this.ensureAuth(controller.signal);
        options.signal?.throwIfAborted();
        const hasBody = options.body !== undefined;

        const res = await this.fetchImpl(this.buildUrl(options.path, options.query), {
          method: options.method,
          headers: this.headers(auth, hasBody),
          ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
          signal: controller.signal,
        });
        status = res.status;

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = classifyHttpError(res.status, text, options.path);
          // A stale JWT is not a failure, it is bookkeeping. Refresh and replay
          // the request once before it counts against the retry budget.
          if (err.code === 'auth_expired' && !authRetried && !options.skipAuth) {
            authRetried = true;
            await this.invalidateJwt(auth?.jwt);
            this.emitRequest({ method: options.method, path: options.path, status, durationMs: Date.now() - started, attempt, error: err });
            continue;
          }
          // Same failure with a JWT we just minted: the token Suno is rejecting
          // is the captcha one, not ours. Say so, rather than sending the caller
          // to re-authenticate a session that is already fine.
          if (err.code === 'auth_expired' && authRetried && isTokenValidationFailure(text)) {
            throw new SunoError({
              code: 'captcha_required',
              message:
                'Suno rejected the request token even with a fresh JWT: the account is captcha-gated and no create will succeed until the gate lifts. Measured 2026-08-18 - `/api/c/check` flipped to `required: true` and the identical body that had generated fine minutes earlier started answering 422 token_validation_failed. Nothing was charged. Pass a solved hCaptcha token as captchaToken, or wait: the flag has been seen clearing itself within the hour.',
              status: res.status,
              path: options.path,
              body: text,
              alert: true,
            });
          }
          throw err;
        }

        const raw = res.status === 204 ? null : await res.json().catch((cause: unknown) => {
          // Only a body that arrived and is not JSON is invalid. A timeout, an
          // abort or a connection reset mid-body is transport, and stays so.
          if (!(cause instanceof SyntaxError)) throw cause;
          throw new SunoError({
            code: 'response_invalid',
            message: `response was not JSON (HTTP ${res.status})`,
            status: res.status,
            path: options.path,
            cause,
          });
        });

        this.checkDrift(options.endpointKey ?? options.path, raw);

        if (!options.schema) {
          this.emitRequest({ method: options.method, path: options.path, status, durationMs: Date.now() - started, attempt });
          return raw as T;
        }
        const parsed = options.schema.safeParse(raw);
        if (!parsed.success) {
          // Deliberately before the emit: one HTTP exchange must produce exactly
          // one onRequest callback, and the catch below will emit this failure.
          throw new SunoError({
            code: 'response_invalid',
            message: `response failed validation for ${options.path}: ${parsed.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join('.')} ${i.message}`)
              .join('; ')}`,
            status: res.status,
            path: options.path,
            body: truncate(JSON.stringify(raw), 2000),
            alert: true,
          });
        }
        this.emitRequest({ method: options.method, path: options.path, status, durationMs: Date.now() - started, attempt });
        return parsed.data;
      } catch (err) {
        // Decided by the caller's signal, not by the error's name: an abort
        // reason can be any value, and none of them is worth retrying.
        const wrapped =
          options.signal?.aborted === true
            ? abortedError(options.signal.reason, options.path)
            : toSunoError(err, options.path);
        this.emitRequest({ method: options.method, path: options.path, status, durationMs: Date.now() - started, attempt, error: wrapped });
        if (!wrapped.retryable || attempt >= retry.maxRetries) throw wrapped;
        clearTimeout(timer);
        try {
          await sleep(backoffDelay(attempt, retry), options.signal);
        } catch (abort) {
          // An abort landing inside the backoff delay would otherwise escape as
          // a raw DOMException, the one path in this method that does not yield
          // a SunoError. Callers branching on err.code would read undefined.
          throw toSunoError(abort, options.path);
        }
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onOuterAbort);
      }
    }
  }

  private emitRequest(info: RequestInfo): void {
    try {
      this.onRequest?.(info);
    } catch {
      // A broken metrics hook must never take down a request.
    }
  }

  private checkDrift(endpointKey: string, raw: unknown): void {
    if (!this.baselines || !this.onDrift) return;
    const baseline = this.baselines.get(endpointKey);
    if (!baseline) return;
    const consumed = this.baselines.consumedPaths(endpointKey);
    const report = detectDrift(baseline, raw, consumed ? { consumedPaths: consumed } : {});
    if (report.findings.length > 0) {
      try {
        this.onDrift(report);
      } catch {
        // Same reasoning as the metrics hook.
      }
    }
  }

  /** Replace the stored session with a new cookie and prove it works. */
  async login(cookie: string, signal?: AbortSignal): Promise<AuthState> {
    const normalized = normalizeCookieInput(cookie);
    const { sessionId, jwt } = await clerkTokenExchange(
      this.fetchImpl,
      normalized.clerkClientCookie,
      signal,
    );
    // A bare `__client` carries no device id. Keep the one this installation
    // already has, or persist the fallback, rather than storing none and
    // sending a fresh random id from every process.
    const previous = this.loaded ? this.auth : await this.store.load().catch(() => undefined);
    this.auth = {
      clerkClientCookie: normalized.clerkClientCookie,
      deviceId: normalized.deviceId ?? previous?.deviceId ?? this.fallbackDeviceId,
      sessionId,
      jwt,
    };
    this.loaded = true;
    await this.store.save(this.auth);
    return this.auth;
  }

  async logout(): Promise<void> {
    this.auth = undefined;
    this.loaded = true;
    await this.store.clear();
  }
}

/**
 * One caller-supplied id, made safe to put in a URL path.
 *
 * Ids reach these paths from callers - a chat bot passes along whatever a
 * viewer typed - and `new URL()` resolves `..` while fetch drops `#...`.
 * Unencoded, `../billing/info/#` turned a waveform lookup into an
 * authenticated read of the account's billing. Encoding keeps an id inside
 * its one segment; `.` and `..` are refused because encoding leaves them
 * dot segments.
 */
export function pathSegment(id: string): string {
  if (id === '' || id === '.' || id === '..') {
    throw new SunoError({ code: 'invalid_input', message: `not a usable id: ${JSON.stringify(id)}` });
  }
  return encodeURIComponent(id);
}

/** Clerk refusing a session id (4xx other than throttling), as opposed to Clerk having trouble. */
function isStaleSessionError(err: unknown): boolean {
  if (!(err instanceof SunoError)) return false;
  if (err.code === 'auth_dead') return true;
  return err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 429;
}

export function classifyHttpError(status: number, body: string, path: string): SunoError {
  const base = { status, path, body };

  if (status === 401) {
    return new SunoError({ ...base, code: 'auth_expired', message: 'HTTP 401: JWT rejected', retryable: false });
  }
  if (looksLikeAuthExpired(body)) {
    return new SunoError({
      ...base,
      code: 'auth_expired',
      message: `HTTP ${status}: Suno rejected the JWT as stale`,
      retryable: false,
    });
  }
  if (status === 403) {
    // Not a dead session: that is a 401, which the retry loop above refreshes
    // and replays. A 403 with a freshly minted JWT is the account being told no
    // - a subscription-only feature, or a model above its tier. Reporting it as
    // auth_dead sent Free accounts off to re-export a cookie that was fine, and
    // paged a human for a plan limit that waiting will never fix.
    const detail = planGateDetail(body);
    return new SunoError({
      ...base,
      code: 'plan_required',
      message:
        detail === undefined
          ? `HTTP 403 on ${path}: this account's plan does not allow that`
          : `HTTP 403 on ${path}: ${detail}`,
      retryable: false,
    });
  }
  if (status === 429) {
    return new SunoError({ ...base, code: 'rate_limited', message: 'HTTP 429: rate limited', retryable: true });
  }
  if (status === 404) {
    // Both conditions, never the path alone: see looksLikeMissingRoute.
    return isRouteLevelPath(path) && looksLikeMissingRoute(body)
      ? new SunoError({
          ...base,
          code: 'route_gone',
          message: `HTTP 404 on ${path}: this endpoint moved. The client needs updating.`,
          alert: true,
        })
      : new SunoError({ ...base, code: 'not_found', message: `HTTP 404: ${path}` });
  }
  if (looksLikeInsufficientCredits(body)) {
    return new SunoError({ ...base, code: 'insufficient_credits', message: 'out of Suno credits' });
  }
  if (status === 422 && looksLikeSchemaDrift(body)) {
    return new SunoError({
      ...base,
      code: 'schema_drift',
      message: `HTTP 422 on ${path}: Suno changed the request schema. Retrying will not help.`,
      alert: true,
    });
  }
  if (status >= 500) {
    return new SunoError({ ...base, code: 'api_error', message: `HTTP ${status}: Suno server error`, retryable: true });
  }
  return new SunoError({ ...base, code: 'api_error', message: `HTTP ${status}: ${truncate(body, 300)}` });
}

function toSunoError(err: unknown, path: string): SunoError {
  if (err instanceof SunoError) return err;
  if (err instanceof Error) {
    const isTimeout = err.message.includes('timeout') || err.name === 'TimeoutError';
    const isAbort = err.name === 'AbortError';
    return new SunoError({
      code: isTimeout ? 'timeout' : 'network',
      message: `${path}: ${err.message}`,
      path,
      // An abort is a deliberate cancellation by the caller, never a transient
      // fault. Retrying one would resurrect work the caller just killed.
      retryable: !isAbort,
      cause: err,
    });
  }
  return new SunoError({ code: 'network', message: `${path}: unknown transport failure`, path, retryable: true, cause: err });
}
