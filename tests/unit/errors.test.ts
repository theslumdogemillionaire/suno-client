import { describe, expect, it } from 'vitest';

import { classifyHttpError } from '../../src/client.js';
import {
  isRouteLevelPath,
  looksLikeAuthExpired,
  looksLikeInsufficientCredits,
  looksLikeRejectedInput,
  looksLikeSchemaDrift,
  SunoError,
  truncate,
} from '../../src/errors.js';

const GENERATE = '/api/generate/v2-web/';
const STALE_TOKEN_BODY = '{"detail":"Token validation failed"}';

/** Two spellings of a body-location error that the drift matcher recognises. */
const PYDANTIC_REPR_422 =
  "{'detail': [{'loc': ['body', 'params', 'title'], 'msg': 'Field required', 'type': 'missing'}]}";
const PYDANTIC_JSON_422 =
  '{"detail": [{"loc": ["body", "params", "title"], "msg": "Field required", "type": "missing"}]}';

describe('classifyHttpError', () => {
  it('reads a 401 as a refreshable expired token, not as something to page on', () => {
    const err = classifyHttpError(401, '', GENERATE);
    expect(err.code).toBe('auth_expired');
    expect(err.retryable).toBe(false);
    expect(err.alert).toBe(false);
    expect(err.status).toBe(401);
    expect(err.path).toBe(GENERATE);
  });

  it('reads any status whose body says the token failed validation as an expired token', () => {
    // The load-bearing case. Suno returns "Token validation failed" as a 400,
    // 403 or 500 while the JWT's own exp claim still says it is valid, because
    // their staleness window is about half the token lifetime. The body check
    // therefore runs ahead of the 403 / 429 / 404 / 5xx branches on purpose: a
    // stale token must come back as auth_expired so the client refreshes and
    // replays, never as auth_dead (pages a human over nothing) and never as a
    // retryable server error (replays the same dead token until the budget is
    // gone).
    for (const status of [400, 403, 404, 429, 500]) {
      const err = classifyHttpError(status, STALE_TOKEN_BODY, GENERATE);
      expect(err.code, `status ${status}`).toBe('auth_expired');
      expect(err.retryable, `status ${status}`).toBe(false);
      expect(err.alert, `status ${status}`).toBe(false);
    }
  });

  it('reads a 403 as the plan saying no, not as a dead session', () => {
    // A dead session is a 401, which the request loop refreshes and replays. A
    // 403 arrives with a JWT that was just minted, so it is authorization: a
    // subscription-only feature, or a model above this account's tier. Calling
    // it auth_dead sent Free accounts off to re-export a cookie that was fine,
    // and paged a human over a plan limit that waiting cannot fix.
    const err = classifyHttpError(403, '{"detail":"Forbidden"}', GENERATE);
    expect(err.code).toBe('plan_required');
    expect(err.alert).toBe(false);
    expect(err.retryable).toBe(false);
  });

  it('quotes Suno\'s own explanation of the gate when it sends one', () => {
    // Captured live from a Free account creating on the default (v5.5) model.
    const body =
      '{"status_code": 403, "detail": "You don\'t have access to this model. Upgrade your plan to use it.", "error_type": "permission_denied", "retryable": false}';
    const err = classifyHttpError(403, body, GENERATE);
    expect(err.code).toBe('plan_required');
    expect(err.message).toContain('Upgrade your plan');
  });

  it('still says something useful when the 403 body is empty', () => {
    // Stems answers exactly this on a Free account: 403, no body at all.
    const err = classifyHttpError(403, '', '/api/edit/stems/abc');
    expect(err.code).toBe('plan_required');
    expect(err.message).toContain("plan does not allow");
  });

  it('makes a 429 retryable and keeps it silent', () => {
    const err = classifyHttpError(429, 'Too Many Requests', GENERATE);
    expect(err.code).toBe('rate_limited');
    expect(err.retryable).toBe(true);
    expect(err.alert).toBe(false);
  });

  it('turns a 404 on a fixed route into a route_gone alert', () => {
    for (const path of ['/api/feed/v3', GENERATE, '/api/gen/trash']) {
      const err = classifyHttpError(404, 'Not Found', path);
      expect(err.code, path).toBe('route_gone');
      expect(err.alert, path).toBe(true);
      expect(err.retryable, path).toBe(false);
    }
  });

  it('turns a 404 on an id-addressed path into a quiet not_found', () => {
    for (const path of [
      '/api/gen/9c0a4d1e-0000-4000-8000-000000000001/aligned_lyrics/v2/',
      '/api/gen/9c0a4d1e-0000-4000-8000-000000000001/set_visibility/',
      '/api/persona/7b2f/',
    ]) {
      const err = classifyHttpError(404, '{"detail":"not found"}', path);
      expect(err.code, path).toBe('not_found');
      // A caller passing a stale clip id is not an incident.
      expect(err.alert, path).toBe(false);
      expect(err.retryable, path).toBe(false);
    }
  });

  it('flags a 422 that locates the fault in the request body as schema drift and refuses to retry', () => {
    for (const body of [PYDANTIC_REPR_422, PYDANTIC_JSON_422]) {
      const err = classifyHttpError(422, body, GENERATE);
      expect(err.code).toBe('schema_drift');
      expect(err.alert).toBe(true);
      // Suno changed the request contract. Every replay costs a round trip and
      // can never succeed, so this must not enter the retry loop.
      expect(err.retryable).toBe(false);
      expect(err.body).toBe(body);
    }
  });

  it('leaves a 422 that is about the value rather than the shape as a plain api_error', () => {
    const err = classifyHttpError(422, '{"detail":"prompt exceeds 3000 characters"}', GENERATE);
    expect(err.code).toBe('api_error');
    expect(err.alert).toBe(false);
    expect(err.retryable).toBe(false);
  });

  it('makes every 5xx retryable without alerting', () => {
    for (const status of [500, 502, 503, 504]) {
      const err = classifyHttpError(status, 'Bad Gateway', GENERATE);
      expect(err.code, `status ${status}`).toBe('api_error');
      expect(err.retryable, `status ${status}`).toBe(true);
      expect(err.alert, `status ${status}`).toBe(false);
    }
  });

  it('reads an out-of-credits body as insufficient_credits and does not retry it', () => {
    const err = classifyHttpError(402, '{"detail":"Insufficient credits"}', GENERATE);
    expect(err.code).toBe('insufficient_credits');
    expect(err.retryable).toBe(false);
    expect(err.alert).toBe(false);
  });

  it('does not retry a 5xx whose body says the account is out of credits', () => {
    // The credits check deliberately precedes the 5xx branch. Retrying cannot
    // conjure credits, and a poller treating this as transient would spend its
    // whole backoff budget on requests that are guaranteed to fail.
    const err = classifyHttpError(503, 'not enough credits to generate', GENERATE);
    expect(err.code).toBe('insufficient_credits');
    expect(err.retryable).toBe(false);
  });

  it('falls back to a quiet api_error for an unclassified 4xx', () => {
    const err = classifyHttpError(400, '{"detail":"bad request"}', GENERATE);
    expect(err.code).toBe('api_error');
    expect(err.retryable).toBe(false);
    expect(err.alert).toBe(false);
  });

  it('caps a huge error body harder in the message than in the retained body', () => {
    // A Cloudflare or nginx error page arrives as kilobytes of HTML. The message
    // ends up in a log line and is cut at 300, while the body is kept at 2000
    // for drift forensics. Losing this split means one bad gateway response
    // floods the log.
    const body = 'x'.repeat(3000);
    const err = classifyHttpError(418, body, GENERATE);
    expect(err.message).toContain('(2700 more chars)');
    expect(err.message.length).toBeLessThan(400);
    expect(err.body).toContain('(1000 more chars)');
    expect(err.body?.startsWith('x'.repeat(2000))).toBe(true);
  });
});

describe('isRouteLevelPath', () => {
  it('matches registered routes exactly, so a trailing slash is a different path', () => {
    expect(isRouteLevelPath('/api/feed/v3')).toBe(true);
    expect(isRouteLevelPath('/api/gen/trash')).toBe(true);
    expect(isRouteLevelPath('/api/generate/v2-web/')).toBe(true);
    expect(isRouteLevelPath('/api/billing/info/')).toBe(true);

    expect(isRouteLevelPath('/api/feed/v3/')).toBe(false);
    expect(isRouteLevelPath('/api/generate/v2-web')).toBe(false);
    expect(isRouteLevelPath('/api/feed/v2')).toBe(false);
    expect(isRouteLevelPath('/api/gen/trash/9c0a')).toBe(false);
  });
});

describe('looksLikeAuthExpired', () => {
  it('recognises the stale-token wording whatever the casing', () => {
    expect(looksLikeAuthExpired('Token validation failed')).toBe(true);
    expect(looksLikeAuthExpired('TOKEN VALIDATION FAILED')).toBe(true);
    expect(looksLikeAuthExpired('{"detail":"token validation failed"}')).toBe(true);
  });

  it('recognises the other strings Suno uses for the same condition', () => {
    for (const body of [
      'JWT expired',
      'the jwt is expired',
      'Invalid JWT',
      'invalid token',
      'Not authenticated',
      'Unauthenticated request',
    ]) {
      expect(looksLikeAuthExpired(body), body).toBe(true);
    }
  });

  it('stays quiet on error bodies that have nothing to do with the session', () => {
    for (const body of [
      '',
      '{"detail":"clip not found"}',
      '{"detail":"prompt exceeds 3000 characters"}',
      '{"detail":"Forbidden"}',
    ]) {
      expect(looksLikeAuthExpired(body), body).toBe(false);
    }
  });
});

describe('looksLikeSchemaDrift', () => {
  it('fires on a pydantic error that locates the fault inside the request body', () => {
    expect(looksLikeSchemaDrift(PYDANTIC_REPR_422)).toBe(true);
    expect(looksLikeSchemaDrift(PYDANTIC_JSON_422)).toBe(true);
  });

  it('fires on a missing-field marker even when no body location is given', () => {
    expect(looksLikeSchemaDrift("[{'type': 'missing', 'msg': 'Field required'}]")).toBe(true);
    expect(looksLikeSchemaDrift('[{"type": "missing", "msg": "Field required"}]')).toBe(true);
  });

  it('stays quiet when the 422 is about the value rather than the shape', () => {
    expect(looksLikeSchemaDrift('{"detail":"prompt exceeds 3000 characters"}')).toBe(false);
    expect(looksLikeSchemaDrift('')).toBe(false);
  });
});

describe('looksLikeInsufficientCredits', () => {
  it('recognises both wordings regardless of casing or plural', () => {
    expect(looksLikeInsufficientCredits('Insufficient credits')).toBe(true);
    expect(looksLikeInsufficientCredits('INSUFFICIENT CREDIT')).toBe(true);
    expect(looksLikeInsufficientCredits('Not enough credits for this generation')).toBe(true);
  });

  it('does not fire on a body that merely reports a credit balance', () => {
    expect(looksLikeInsufficientCredits('{"total_credits_left":0}')).toBe(false);
  });
});

describe('looksLikeRejectedInput', () => {
  it('recognises the refusal Suno returns for a prompt it will not accept', () => {
    expect(looksLikeRejectedInput('Prompt likely malformed')).toBe(true);
    expect(looksLikeRejectedInput('PROMPT LIKELY MALFORMED')).toBe(true);
    expect(looksLikeRejectedInput('Your prompt contains an artist name')).toBe(true);
    expect(looksLikeRejectedInput('This request violates our content policy')).toBe(true);
  });

  it('does not mistake a transport or server failure for a rejected prompt', () => {
    // A rejected prompt is the submitter's problem and should produce a reply.
    // A network blip is ours and should produce a retry. Once prompts come from
    // strangers, confusing the two either retries an unretryable moderation
    // refusal forever or answers a network outage with "your prompt was
    // rejected".
    for (const message of [
      'fetch failed',
      'HTTP 500: Suno server error',
      '/api/generate/v2-web/: request timeout',
      'Token validation failed',
    ]) {
      expect(looksLikeRejectedInput(message), message).toBe(false);
    }
  });
});

describe('truncate', () => {
  it('returns the input untouched when it is at or under the limit', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('', 5)).toBe('');
  });

  it('reports how many characters were dropped', () => {
    expect(truncate('abcdef', 3)).toBe('abc... (3 more chars)');
  });

  it('returns a string longer than the limit it was given', () => {
    // The suffix is appended on top of the cap, so a caller sizing a log line
    // or a database column by `max` still overflows it.
    expect(truncate('x'.repeat(300), 200).length).toBeGreaterThan(200);
  });
});

describe('SunoError', () => {
  it('is neither retryable nor alerting unless asked', () => {
    const err = new SunoError({ code: 'api_error', message: 'boom' });
    expect(err.retryable).toBe(false);
    expect(err.alert).toBe(false);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SunoError');
    expect(err.status).toBeUndefined();
    expect(err.body).toBeUndefined();
  });

  it('survives JSON.stringify with its operational booleans intact', () => {
    // A plain Error serialises to {}, so a logger would record nothing about
    // whether the caller may retry or must alert. toJSON is what makes these
    // errors readable after the fact.
    const err = new SunoError({
      code: 'rate_limited',
      message: 'HTTP 429: rate limited',
      retryable: true,
      alert: false,
      status: 429,
      path: GENERATE,
      body: 'Too Many Requests',
    });
    expect(JSON.parse(JSON.stringify(err))).toEqual({
      name: 'SunoError',
      code: 'rate_limited',
      message: 'HTTP 429: rate limited',
      retryable: true,
      alert: false,
      status: 429,
      path: GENERATE,
      body: 'Too Many Requests',
    });
  });

  it('round-trips an alerting error without downgrading it to retryable', () => {
    const err = new SunoError({
      code: 'schema_drift',
      message: 'HTTP 422: Suno changed the request schema.',
      alert: true,
      status: 422,
      path: GENERATE,
      body: PYDANTIC_REPR_422,
    });
    const parsed = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(parsed['alert']).toBe(true);
    expect(parsed['retryable']).toBe(false);
    expect(parsed['code']).toBe('schema_drift');
  });

  it('truncates a huge body at construction so it cannot bloat a log line', () => {
    const err = new SunoError({ code: 'api_error', message: 'boom', body: 'y'.repeat(5000) });
    expect(err.body).toContain('(3000 more chars)');
    expect(err.body?.startsWith('y'.repeat(2000))).toBe(true);
  });

  it('keeps the underlying cause reachable but out of the serialised form', () => {
    const cause = new Error('ECONNRESET');
    const err = new SunoError({ code: 'network', message: 'connection reset', cause, retryable: true });
    expect(err.cause).toBe(cause);
    expect(Object.keys(JSON.parse(JSON.stringify(err)) as Record<string, unknown>)).not.toContain('cause');
  });
});
