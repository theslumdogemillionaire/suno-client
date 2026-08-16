import { buildCoverBody, buildExtendBody, buildRemasterBody } from '../api/derive.js';
import { buildCustomBody, buildDescribeBody, GENERATE_PATH } from '../api/generate.js';
import type { SunoClient } from '../client.js';
import { SunoError, isTokenValidationFailure, looksLikeSchemaDrift } from '../errors.js';
import { sleep } from '../internal/retry.js';

/**
 * Free request-schema validation.
 *
 * The problem this solves: response drift is cheap to detect (compare shapes),
 * but REQUEST drift is invisible until a real call fails, because only Suno's
 * server knows what it requires today. Waiting to find out means finding out
 * from a production 422, which is how the reference client lost two weeks in
 * August 2026 when `title: null` stopped being accepted.
 *
 * The trick, verified live on 2026-08-17: Suno validates the request body
 * BEFORE it validates the request token. So a body that is schema-correct but
 * carries a nonsense model never reaches generation, never bills a credit, and
 * still tells us whether the schema still accepts our shape.
 *
 *   body ok, bogus model  -> 422 token_validation_failed   => schema is FINE
 *   body missing a field  -> 422 body.params.X "missing"   => schema DRIFTED
 *   body has a bad type   -> 422 body.params.X "string_type" => schema DRIFTED
 *
 * Evidence for the ordering, from the live probe:
 *   { ...validBody, mv: "__probe_invalid_model__" }              -> token_validation_failed
 *   { ...validBody, mv: "__probe_invalid_model__", title: null } -> body.params.title
 *
 * If the second had also returned token_validation_failed, the probe would be
 * worthless. It did not, so schema errors provably surface first.
 *
 * Re-verified 2026-08-17 on a captcha-GATED account, which is the case that
 * could have made this whole thing a lie: if gating short-circuited ahead of
 * body validation, the probe would answer "schema fine" unconditionally and the
 * canary would sit permanently green while blind. It does not. A `title: null`
 * body on a gated account still returns `body.params.title`, so the probe stays
 * honest in both states.
 */

/**
 * A model key Suno cannot possibly accept. This is the safety interlock: even
 * if every other guard failed, a generation cannot be created for a model that
 * does not exist.
 */
export const PROBE_MODEL = '__suno_client_schema_probe__';

/**
 * Gap between probe variants. Suno's create endpoint 429s well below this rate,
 * and a tripped limiter is not just noise: see the trust warning on
 * `probeGenerateSchema`.
 */
export const PROBE_SPACING_MS = 15_000;

export interface SchemaProbeResult {
  endpoint: string;
  variant: string;
  /** True when Suno accepted the body shape. */
  schemaValid: boolean;
  /** Field path Suno rejected, e.g. `title`. Undefined when schemaValid. */
  field?: string;
  /** Pydantic error type, e.g. `missing`, `string_type`. */
  errorType?: string;
  detail: string;
}

interface Loc {
  field: string;
  type: string;
}

function parseValidationError(body: string): Loc | undefined {
  // Suno echoes Python's repr, so the payload is single-quoted and not JSON.
  const type = /'type':\s*'([^']*)'/.exec(body)?.[1] ?? /"type":\s*"([^"]*)"/.exec(body)?.[1];
  const locRaw = /'loc':\s*\[([^\]]*)\]/.exec(body)?.[1] ?? /"loc":\s*\[([^\]]*)\]/.exec(body)?.[1];
  if (type === undefined || locRaw === undefined) return undefined;
  const parts = locRaw.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, ''));
  const field = parts[parts.length - 1];
  if (field === undefined) return undefined;
  return { field, type };
}

async function probeBody(
  client: SunoClient,
  variant: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<SchemaProbeResult> {
  const probed = { ...body, mv: PROBE_MODEL };
  try {
    await client.request({
      method: 'POST',
      path: GENERATE_PATH,
      body: probed,
      // Unlike a real create, a probe is free and idempotent, so retrying a 429
      // is safe. It is also necessary: Suno rate-limits this endpoint hard
      // enough that five probes back to back trip it.
      retry: { maxRetries: 3, baseDelayMs: 4000, maxDelayMs: 30_000, jitter: true },
      ...(signal ? { signal } : {}),
    });
    // Should be unreachable: PROBE_MODEL cannot generate. If Suno ever starts
    // accepting unknown models, treat it as a loud failure rather than quietly
    // billing the account on every canary run.
    throw new SunoError({
      code: 'api_error',
      message: `schema probe for ${variant} was ACCEPTED with model ${PROBE_MODEL}. Stop running the probe until this is understood: it may now cost credits.`,
      alert: true,
    });
  } catch (err) {
    if (!(err instanceof SunoError)) throw err;
    const body = err.body ?? '';

    // Got past body validation and died on the token check: the shape is fine.
    if (isTokenValidationFailure(body) || err.code === 'captcha_required') {
      return {
        endpoint: GENERATE_PATH,
        variant,
        schemaValid: true,
        detail: 'body accepted; rejected downstream at the token check, as designed',
      };
    }

    if (looksLikeSchemaDrift(body)) {
      const loc = parseValidationError(body);
      return {
        endpoint: GENERATE_PATH,
        variant,
        schemaValid: false,
        ...(loc ? { field: loc.field, errorType: loc.type } : {}),
        detail: loc
          ? `Suno rejected \`${loc.field}\` (${loc.type}). The request body needs updating.`
          : `Suno rejected the body: ${body.slice(0, 300)}`,
      };
    }

    // Anything else (auth dead, 5xx, network) is not a schema verdict.
    throw err;
  }
}

export type ProbeVariant = 'custom' | 'describe' | 'cover' | 'remaster' | 'extend';

export const ALL_PROBE_VARIANTS: readonly ProbeVariant[] = [
  'custom',
  'describe',
  'cover',
  'remaster',
  'extend',
];

function bodyFor(variant: ProbeVariant): Record<string, unknown> {
  const dummyClip = '00000000-0000-0000-0000-000000000000';
  switch (variant) {
    case 'custom':
      return buildCustomBody({ title: 'schema probe', tags: 'probe', lyrics: '[Verse]\nprobe' });
    case 'describe':
      return buildDescribeBody({ prompt: 'schema probe' });
    case 'cover':
      return buildCoverBody(dummyClip, { tags: 'probe' });
    case 'remaster':
      return buildRemasterBody(dummyClip);
    case 'extend':
      return buildExtendBody(dummyClip, { at: 10, lyrics: '[Verse]\nprobe' });
  }
}

export interface ProbeOptions {
  /** Defaults to `['custom']`. See the trust warning before widening this. */
  variants?: readonly ProbeVariant[];
  spacingMs?: number;
  signal?: AbortSignal;
}

/**
 * Check that Suno still accepts our create bodies. Free in credits.
 *
 * NOT free in reputation, and this is the part to take seriously. Every probe
 * is a rejected create, and a burst of rejected creates looks exactly like
 * abuse. Running all five variants back to back during development on
 * 2026-08-17 tripped a 429 and then flipped the account's captcha gate from
 * `required: false` to `required: true`, which blocks real generation until a
 * song is created by hand in the web UI.
 *
 * Hence the defaults: ONE variant, spaced, meant for a once-a-day schedule.
 * Rotate which variant you probe across days if you want full coverage. Do not
 * put this in a loop, a health check, or anything that runs per request.
 */
export async function probeGenerateSchema(
  client: SunoClient,
  options: ProbeOptions = {},
): Promise<SchemaProbeResult[]> {
  const variants = options.variants ?? (['custom'] as const);
  const spacing = options.spacingMs ?? PROBE_SPACING_MS;

  const results: SchemaProbeResult[] = [];
  for (const [index, variant] of variants.entries()) {
    if (index > 0) await sleep(spacing, options.signal);
    results.push(await probeBody(client, variant, bodyFor(variant), options.signal));
  }
  return results;
}

/** Pick today's variant, so a daily canary covers all five over a work week. */
export function variantForDay(date: Date = new Date()): ProbeVariant {
  const dayIndex = Math.floor(date.getTime() / 86_400_000);
  return ALL_PROBE_VARIANTS[dayIndex % ALL_PROBE_VARIANTS.length] ?? 'custom';
}
