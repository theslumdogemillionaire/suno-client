import { describe, expect, it } from 'vitest';

import { describeAccount, pickDefaultModel, pickRemasterModel } from '../../src/api/account.js';
import { DEFAULT_MODEL } from '../../src/api/generate.js';
import type { FetchLike } from '../../src/auth.js';
import { BillingInfoSchema } from '../../src/schemas.js';
import { MemoryAuthStore } from '../../src/store.js';
import { Suno } from '../../src/suno.js';

/**
 * Account tiers, against payloads captured live rather than imagined.
 *
 * The Free payload below is a trimmed copy of a real one (2026-08-18). Its
 * shape is the whole point: no `plan` object, a `plans` catalogue that is the
 * shop rather than your receipt, and exactly one model with `can_use: true`.
 * The first release assumed the paid shape and broke on every one of those.
 */

const FREE_BILLING = {
  is_active: false,
  is_past_due: false,
  credits: 0,
  subscription_type: false,
  monthly_usage: 40,
  monthly_limit: 100,
  total_credits_left: 60,
  accessible_features: [{ name: 'tag_upsample' }],
  free_cover_clips_remaining: 0,
  free_remasters_remaining: 0,
  credit_rate_limit: { available_credits: 60, replenish_credits: 100, replenish_interval_secs: 300 },
  plans: [
    { id: 'p0', level: 0, plan_key: 'free', name: 'Free Plan', usage_plan_features: [{ name: 'tag_upsample' }] },
    { id: 'p1', level: 10, plan_key: 'pro', name: 'Pro Plan', usage_plan_features: [{ name: 'get_stems' }] },
  ],
  models: [
    { name: 'v5.5', external_key: 'chirp-fenix', can_use: false, is_default_model: false, is_default_free_model: false, badges: ['pro'] },
    { name: 'v5', external_key: 'chirp-crow', can_use: false, is_default_model: false, is_default_free_model: false, badges: ['pro'] },
    { name: 'v4.5-all', external_key: 'chirp-auk-turbo', can_use: true, is_default_model: true, is_default_free_model: true, badges: [] },
    { name: 'v4', external_key: 'chirp-v4', can_use: false, is_default_model: false, is_default_free_model: false, badges: ['pro'] },
  ],
};

const PAID_BILLING = {
  is_active: true,
  subscription_type: true,
  total_credits_left: 2500,
  monthly_limit: 2500,
  plan: {
    id: 'p1',
    level: 10,
    plan_key: 'pro',
    name: 'Pro Plan',
    usage_plan_features: [{ name: 'get_stems' }, { name: 'cover' }],
  },
  models: [
    { name: 'v5.5', external_key: 'chirp-fenix', can_use: true, is_default_model: true, is_default_free_model: false },
    { name: 'v4.5-all', external_key: 'chirp-auk-turbo', can_use: true, is_default_model: false, is_default_free_model: true },
  ],
  remaster_model_types: [
    { name: 'remaster v5.5', external_key: 'chirp-flounder', can_use: true, is_default_model: true },
  ],
};

describe('BillingInfoSchema across tiers', () => {
  it('parses a Free payload that has no plan object at all', () => {
    // The regression that took out billing(), credits() and models() at once on
    // every Free account: `plan` was required, and Suno simply does not send it.
    const parsed = BillingInfoSchema.safeParse(FREE_BILLING);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.plan).toBeUndefined();
  });

  it('still parses a subscription payload', () => {
    const parsed = BillingInfoSchema.safeParse(PAID_BILLING);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.plan?.name).toBe('Pro Plan');
  });

  it('keeps total_credits_left required, because nothing works without it', () => {
    const { total_credits_left: _dropped, ...rest } = FREE_BILLING;
    expect(BillingInfoSchema.safeParse(rest).success).toBe(false);
  });
});

describe('describeAccount', () => {
  it('reads a Free account without mistaking the plan catalogue for a plan', () => {
    const info = describeAccount(BillingInfoSchema.parse(FREE_BILLING));
    expect(info.tier).toBe('free');
    expect(info.planKey).toBe('free');
    expect(info.planName).toBe('Free Plan');
    expect(info.creditsLeft).toBe(60);
    expect(info.isActive).toBe(false);
    // `plans` lists Pro too. Reading features from it would claim get_stems.
    expect(info.features).toEqual(['tag_upsample']);
    expect(info.usableModels.map((m) => m.external_key)).toEqual(['chirp-auk-turbo']);
  });

  it('reads a subscription', () => {
    const info = describeAccount(BillingInfoSchema.parse(PAID_BILLING));
    expect(info.tier).toBe('paid');
    expect(info.planKey).toBe('pro');
    expect(info.planName).toBe('Pro Plan');
    expect(info.features).toContain('get_stems');
    expect(info.defaultModel).toBe('chirp-fenix');
  });
});

describe('model resolution', () => {
  it('picks the one model a Free account may use', () => {
    // chirp-fenix is the hardcoded DEFAULT_MODEL and answers 403
    // "You don't have access to this model" here. Verified live 2026-08-18.
    expect(pickDefaultModel(FREE_BILLING.models)).toBe('chirp-auk-turbo');
    expect(pickDefaultModel(FREE_BILLING.models)).not.toBe(DEFAULT_MODEL);
  });

  it('picks the account default on a subscription', () => {
    expect(pickDefaultModel(PAID_BILLING.models)).toBe('chirp-fenix');
  });

  it('never returns a model the account cannot use', () => {
    const locked = [{ name: 'v5.5', external_key: 'chirp-fenix', can_use: false, is_default_model: true }];
    expect(pickDefaultModel(locked)).toBeUndefined();
  });

  it('falls back to the free default when no model is flagged as the default', () => {
    const models = [
      { name: 'v5.5', external_key: 'chirp-fenix', can_use: false },
      { name: 'v4.5-all', external_key: 'chirp-auk-turbo', can_use: true, is_default_free_model: true },
    ];
    expect(pickDefaultModel(models)).toBe('chirp-auk-turbo');
  });

  it('resolves remaster models from their own list', () => {
    expect(pickRemasterModel(BillingInfoSchema.parse(PAID_BILLING))).toBe('chirp-flounder');
    expect(pickRemasterModel(BillingInfoSchema.parse(FREE_BILLING))).toBeUndefined();
  });
});

// --- the facade actually using the resolution --------------------------------

const JWT = `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(
  JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sid: 'sess' }),
).toString('base64url')}.sig`;

interface Recorded {
  fetch: FetchLike;
  bodies: () => Record<string, unknown>[];
  billingCalls: () => number;
}

function studioStub(billing: unknown | Error): Recorded {
  const generateBodies: Record<string, unknown>[] = [];
  let billingCalls = 0;
  const fetchImpl: FetchLike = (input, init) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? init.body : undefined;
    if (url.includes('/api/billing/info/')) {
      billingCalls += 1;
      if (billing instanceof Error) return Promise.resolve(new Response('nope', { status: 500 }) as never);
      return Promise.resolve(new Response(JSON.stringify(billing), { status: 200 }) as never);
    }
    if (url.includes('/api/generate/v2-web/')) {
      generateBodies.push(JSON.parse(body ?? '{}') as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify({
          clips: [
            { id: 'c1', title: 'x', status: 'submitted', model_name: 'chirp-auk-turbo', created_at: '2026-08-18T00:00:00Z' },
          ],
        }), { status: 200 }) as never,
      );
    }
    return Promise.resolve(new Response('{}', { status: 200 }) as never);
  };
  return { fetch: fetchImpl, bodies: () => generateBodies, billingCalls: () => billingCalls };
}

function sunoWith(stub: Recorded, options: Record<string, unknown> = {}): Suno {
  return new Suno({
    fetch: stub.fetch,
    store: new MemoryAuthStore({ clerkClientCookie: 'cookie', jwt: JWT, sessionId: 'sess' }),
    retry: { maxRetries: 0 },
    ...options,
  });
}

const CREATE = { title: 'T', tags: 'lofi', lyrics: '[Instrumental]' };

describe('Suno.generate model resolution', () => {
  it('sends a model the Free account can use instead of the hardcoded default', async () => {
    const s = studioStub(FREE_BILLING);
    await sunoWith(s).generate(CREATE);
    expect(s.bodies()[0]?.['mv']).toBe('chirp-auk-turbo');
  });

  it('leaves an explicit model alone and does not even ask billing', async () => {
    const s = studioStub(FREE_BILLING);
    await sunoWith(s).generate({ ...CREATE, model: 'chirp-crow' });
    expect(s.bodies()[0]?.['mv']).toBe('chirp-crow');
    expect(s.billingCalls()).toBe(0);
  });

  it('asks billing once however many creates follow', async () => {
    const s = studioStub(FREE_BILLING);
    const suno = sunoWith(s);
    await Promise.all([suno.generate(CREATE), suno.generate(CREATE)]);
    await suno.generate(CREATE);
    expect(s.billingCalls()).toBe(1);
  });

  it('still generates when billing is unreachable', async () => {
    // A resolver that hard-depends on billing would add a new way for every
    // create to fail. Falling back to DEFAULT_MODEL keeps the old behaviour.
    const s = studioStub(new Error('down'));
    await sunoWith(s).generate(CREATE);
    expect(s.bodies()[0]?.['mv']).toBe(DEFAULT_MODEL);
  });

  it('honours resolveModel: false', async () => {
    const s = studioStub(FREE_BILLING);
    await sunoWith(s, { resolveModel: false }).generate(CREATE);
    expect(s.bodies()[0]?.['mv']).toBe(DEFAULT_MODEL);
    expect(s.billingCalls()).toBe(0);
  });

  it('re-reads billing on every credits() call', async () => {
    // The account cache must not swallow this one. A queue worker checks
    // headroom before each create, and a frozen balance either spends blind or
    // pauses the queue forever. See examples/request-queue.ts.
    const s = studioStub(FREE_BILLING);
    const suno = sunoWith(s);
    await suno.credits();
    await suno.credits();
    expect(s.billingCalls()).toBe(2);
  });

  it('reports the tier through credits() on an account with no plan object', async () => {
    const s = studioStub(FREE_BILLING);
    const credits = await sunoWith(s).credits();
    expect(credits).toMatchObject({ left: 60, plan: 'Free Plan', tier: 'free' });
  });
});
