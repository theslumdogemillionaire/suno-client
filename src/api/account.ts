import type { SunoClient } from '../client.js';
import type { BillingInfo, Model } from '../schemas.js';

import { billingInfo } from './misc.js';

/**
 * What Suno lets this session do, derived rather than assumed.
 *
 * The client shipped its first release having only ever been run against a paid
 * account, and every tier assumption baked in that way was wrong on a Free one:
 * the plan object is absent, the default model is not usable, and half the
 * feature surface answers 403. None of that is visible until you look, so this
 * module does the looking and everything else reads the answer from here.
 */
export type AccountTier = 'free' | 'paid';

export interface AccountInfo {
  tier: AccountTier;
  /** `"free"`, `"pro"`, `"premier"`. Derived when Suno omits the plan object. */
  planKey: string;
  /** Human label, e.g. `"Free Plan"` or `"Pro Plan"`. */
  planName: string;
  creditsLeft: number;
  monthlyLimit: number | undefined;
  monthlyUsage: number | undefined;
  /** True only for a live subscription. Free accounts report false. */
  isActive: boolean;
  /** Feature names unlocked right now, e.g. `get_stems`, `cover`, `persona`. */
  features: string[];
  models: Model[];
  /** The subset this account may actually generate with. */
  usableModels: Model[];
  /** What `generate()` will use when the caller names no model. */
  defaultModel: string | undefined;
  raw: BillingInfo;
}

function featureNames(info: BillingInfo): string[] {
  // `accessible_features` is the authoritative list on a Free account, where
  // there is no plan object to read features from. On a subscription both are
  // present and agree, so the union is safe and neither source is load-bearing.
  const names = new Set<string>();
  for (const f of info.accessible_features ?? []) names.add(f.name);
  for (const f of info.plan?.usage_plan_features ?? []) names.add(f.name);
  return [...names];
}

/**
 * Pick a model the account can actually use.
 *
 * `DEFAULT_MODEL` is v5.5, which is behind a subscription: a Free account gets
 * HTTP 403 `You don't have access to this model` for every create that does not
 * override it. Both tiers flag their own default with `is_default_model`, so
 * that flag combined with `can_use` resolves correctly for either.
 */
export function pickDefaultModel(models: readonly Model[] | undefined): string | undefined {
  const usable = (models ?? []).filter((m) => m.can_use !== false);
  return (
    usable.find((m) => m.is_default_model === true)?.external_key ??
    usable.find((m) => m.is_default_free_model === true)?.external_key ??
    usable[0]?.external_key
  );
}

/** Same idea for remaster, which uses its own model keys. */
export function pickRemasterModel(info: BillingInfo): string | undefined {
  const usable = (info.remaster_model_types ?? []).filter((m) => m.can_use !== false);
  return usable.find((m) => m.is_default_model === true)?.external_key ?? usable[0]?.external_key;
}

/**
 * Read the tier out of a billing payload.
 *
 * The discriminator is the presence of `plan`, backed up by
 * `subscription_type`. A Free payload carries a `plans` catalogue that looks
 * temptingly like plan data and is not: it lists what you could buy, including
 * plans this account has never held.
 */
export function describeAccount(info: BillingInfo): AccountInfo {
  const subscribed = info.plan !== undefined || info.subscription_type === true;
  const models = info.models ?? [];
  const catalogueFree = info.plans?.find((p) => p.plan_key === 'free' || p.level === 0);

  return {
    tier: subscribed ? 'paid' : 'free',
    planKey: info.plan?.plan_key ?? (subscribed ? 'unknown' : 'free'),
    planName: info.plan?.name ?? (subscribed ? 'Unknown Plan' : (catalogueFree?.name ?? 'Free Plan')),
    creditsLeft: info.total_credits_left,
    monthlyLimit: info.monthly_limit,
    monthlyUsage: info.monthly_usage,
    isActive: info.is_active ?? subscribed,
    features: featureNames(info),
    models,
    usableModels: models.filter((m) => m.can_use !== false),
    defaultModel: pickDefaultModel(models),
    raw: info,
  };
}

export async function getAccount(client: SunoClient, signal?: AbortSignal): Promise<AccountInfo> {
  return describeAccount(await billingInfo(client, signal));
}
