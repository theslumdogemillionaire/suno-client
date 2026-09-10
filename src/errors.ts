/**
 * Error taxonomy.
 *
 * Two booleans carry the operational meaning, and callers are expected to branch
 * on them rather than on the class name:
 *
 *   retryable - the same request, unchanged, may succeed later.
 *   alert     - a human needs to know. Either the session is dead, or Suno moved
 *               the API out from under us. Neither resolves by waiting.
 *
 * The distinction matters because a long-running consumer (a Twitch bot, a queue
 * worker) must keep going through the retryable class and stop loudly on the
 * alert class. Treating a schema drift as a transient failure means burning
 * credits on requests that can never succeed.
 */

export type SunoErrorCode =
  | 'auth_missing'
  | 'auth_expired'
  | 'auth_dead'
  | 'plan_required'
  | 'captcha_required'
  | 'insufficient_credits'
  // Suno metered downloads on 2026-09-10. The clip exists and is finished; the
  // account simply has not spent one of its per-period downloads on it. Neither
  // retryable (waiting changes nothing) nor alert (a library of locked clips is
  // the normal state, and 48 of 50 alerting would be noise): the caller skips
  // the clip, or unlocks it and accepts the cost.
  | 'download_locked'
  | 'rate_limited'
  | 'schema_drift'
  | 'route_gone'
  | 'not_found'
  | 'invalid_input'
  | 'api_error'
  | 'network'
  | 'timeout'
  | 'response_invalid';

export interface SunoErrorInit {
  code: SunoErrorCode;
  message: string;
  retryable?: boolean;
  alert?: boolean;
  status?: number;
  path?: string;
  body?: string;
  cause?: unknown;
}

export class SunoError extends Error {
  readonly code: SunoErrorCode;
  readonly retryable: boolean;
  /** A human needs to know: the session is dead or the API contract moved. */
  readonly alert: boolean;
  readonly status: number | undefined;
  readonly path: string | undefined;
  /** Response body, truncated. Kept for drift forensics. */
  readonly body: string | undefined;

  constructor(init: SunoErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'SunoError';
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.alert = init.alert ?? false;
    this.status = init.status;
    this.path = init.path;
    this.body = init.body === undefined ? undefined : truncate(init.body, 2000);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      alert: this.alert,
      status: this.status,
      path: this.path,
      body: this.body,
    };
  }
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}... (${s.length - max} more chars)`;
}

/**
 * Route-level 404s mean the endpoint moved; ID-addressed 404s mean the caller
 * passed a bad id. Retrying helps in neither case, but only the first is a bug
 * in this library, so only the first should page anyone.
 *
 * Ported from the reference client, which learned this the hard way when
 * /api/feed/trash became /api/gen/trash and every delete started reporting
 * "clip not found".
 */
const ROUTE_LEVEL_PATHS = new Set([
  '/api/billing/info/',
  '/api/c/check',
  '/api/generate/v2-web/',
  '/api/generate/concat/v2/',
  '/api/generate/lyrics/',
  '/api/feed/v3',
  '/api/gen/trash',
]);

export function isRouteLevelPath(path: string): boolean {
  return ROUTE_LEVEL_PATHS.has(path);
}

/**
 * Suno signals a stale JWT with several different strings and two different
 * status codes. Notably `Token validation failed` arrives as a 4xx that is NOT
 * 401, while the JWT's own `exp` claim still says it is valid: their
 * server-side staleness window is roughly half the token lifetime.
 */
const AUTH_EXPIRED_PATTERNS = [
  'token validation failed',
  'jwt expired',
  'jwt is expired',
  'invalid jwt',
  'invalid token',
  'not authenticated',
  'unauthenticated',
];

export function looksLikeAuthExpired(body: string): boolean {
  const lower = body.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => lower.includes(p));
}

/**
 * `token_validation_failed` is overloaded, and finding that out cost a
 * confusing debugging session.
 *
 * Suno returns the same error_type for two unrelated things: a JWT past their
 * server-side staleness window, and a create whose hCaptcha `token` field they
 * will not accept. Verified live 2026-08-17 - a request with a perfectly fresh
 * JWT and an incomplete body came back with exactly this.
 *
 * The string alone cannot separate them, so the client does it by outcome: try
 * one JWT refresh, and if the very next attempt fails the same way, the JWT was
 * never the problem and the account is captcha-gated. That produces an
 * actionable message instead of an endless "your session expired" that a fresh
 * session does not fix.
 */
export function isTokenValidationFailure(body: string): boolean {
  return body.toLowerCase().includes('token_validation_failed');
}

/**
 * A 422 whose error locations point at `body.params.*` is Suno's pydantic layer
 * rejecting our request shape. This is the single highest-value signal in the
 * whole client: it is the exact failure that took the reference implementation
 * down for two weeks in August 2026 when `title: null` stopped being accepted.
 */
export function looksLikeSchemaDrift(body: string): boolean {
  // Matched with a regex rather than substring equality because the framing is
  // not ours to rely on: Suno currently echoes Python's repr (single quotes, a
  // space after each colon), but the same payload re-serialised as compact JSON
  // would slip past a literal match and a schema change would go unnoticed.
  return /['"]loc['"]\s*:\s*\[\s*['"]body['"]/.test(body) ||
    /['"]type['"]\s*:\s*['"](missing|[a-z_]+_type)['"]/.test(body);
}

/**
 * A 403 from studio-api is authorization, not authentication.
 *
 * A dead session produces 401, which `request()` already answers by refreshing
 * the JWT and replaying. So a 403 arriving after `ensureAuth()` has just minted
 * a token means the account is not allowed to do this - a Pro-only feature, or
 * a model above its tier. Measured on a Free account 2026-08-18: stems answers
 * 403 with an empty body, and a create on the default (v5.5) model answers 403
 * `{"error_type":"permission_denied","detail":"You don't have access to this
 * model. Upgrade your plan to use it."}`.
 *
 * The body only ever enriches the message. Suno sends the same 403 with and
 * without an explanation, so deciding the code on the text would classify the
 * identical situation two different ways depending on which endpoint answered.
 */
export function planGateDetail(body: string): string | undefined {
  const trimmed = body.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = JSON.parse(trimmed) as { detail?: unknown; detail_fallback?: unknown };
    const detail = parsed.detail ?? parsed.detail_fallback;
    if (typeof detail === 'string' && detail !== '') return detail;
  } catch {
    // Not JSON. Fall through to the raw text, which is still better than nothing.
  }
  return truncate(trimmed, 200);
}

export function looksLikeInsufficientCredits(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes('insufficient credit') || lower.includes('not enough credit');
}

/**
 * Suno's content filter rejecting the input, as opposed to anything being
 * broken. Observed live: a lyrics prompt comes back with
 * `error_message: "Prompt likely malformed"`.
 *
 * This distinction earns its keep the moment prompts come from strangers, which
 * for a chat bot is immediately. A moderation rejection is the user's problem
 * and should produce a reply, not a retry and not a page.
 */
const REJECTED_INPUT_PATTERNS = [
  'prompt likely malformed',
  'artist name',
  'moderation',
  'violates',
  'not allowed',
  'inappropriate',
];

export function looksLikeRejectedInput(message: string): boolean {
  const lower = message.toLowerCase();
  return REJECTED_INPUT_PATTERNS.some((p) => lower.includes(p));
}
