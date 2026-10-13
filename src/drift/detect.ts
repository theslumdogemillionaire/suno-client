import { containerOf, fingerprint, type Baseline, type TypeKind } from './shape.js';

export type DriftSeverity = 'info' | 'warn' | 'error';

export interface DriftFinding {
  severity: DriftSeverity;
  kind: 'added' | 'removed' | 'retyped';
  path: string;
  expected?: TypeKind[];
  actual?: TypeKind[];
  detail: string;
}

export interface DriftReport {
  endpoint: string;
  findings: DriftFinding[];
  /** True if anything at `warn` or above showed up. */
  degraded: boolean;
}

export interface DetectOptions {
  /**
   * Paths this client actually reads. A change under one of these is an `error`;
   * a change anywhere else is at most a `warn`. Without this, a Suno feature
   * launch that adds and removes fields we never touch would page you at 3am.
   */
  consumedPaths?: readonly string[];
  /**
   * How many samples a baseline needs before "present in every sample" counts
   * as evidence that a field is required.
   *
   * Learned the hard way: a 2-sample baseline reported `display_tags` and
   * `metadata.gpt_description_prompt` as removed, when in truth both happened
   * to be set on the two clips that got sampled and absent on newer ones. Two
   * samples is a coincidence; five is a pattern.
   */
  minSamplesForRequired?: number;
}

export const DEFAULT_MIN_SAMPLES = 5;

function isConsumed(path: string, consumed: readonly string[] | undefined): boolean {
  if (!consumed || consumed.length === 0) return false;
  return consumed.some((c) => path === c || path.startsWith(`${c}.`) || path.startsWith(`${c}[]`));
}

/** `clips` for a consumed `clips[].id`: the field every consumed path below it lives in. */
function holdsConsumed(path: string, consumed: readonly string[] | undefined): boolean {
  if (!consumed) return false;
  return consumed.some((c) => c.startsWith(`${path}[]`) || c.startsWith(`${path}.`));
}

/**
 * Compare one live response against a recorded baseline.
 *
 * Only paths present in EVERY baseline sample count as load-bearing. A field
 * that was present in 3 of 5 recorded responses is naturally optional, and its
 * absence today is not news.
 */
export function detectDrift(
  baseline: Baseline,
  observed: unknown,
  options: DetectOptions = {},
): DriftReport {
  const { consumedPaths } = options;
  const minSamples = options.minSamplesForRequired ?? DEFAULT_MIN_SAMPLES;
  const { shape, containers } = fingerprint(observed);
  const findings: DriftFinding[] = [];

  for (const [path, entry] of Object.entries(baseline.paths)) {
    // Required means: every container that could have carried this field did,
    // across enough containers for that to mean something. `total` counts
    // containers, not responses, so a field on 40% of clips is correctly
    // optional even when every sampled page contained at least one clip with it.
    //
    // A field that holds paths we read is held to a lower bar: present in
    // every sample is enough, however few. Its absence is what a rename looks
    // like (`clips` becoming `items`), every consumed path below it is skipped
    // as an empty container, and the minimum-sample guard - meant for optional
    // fields that merely happened to be sampled - hid it entirely.
    const holder = holdsConsumed(path, consumedPaths);
    const alwaysPresent =
      (entry.total >= minSamples || holder) && entry.seen === entry.total && entry.seen > 0;
    const actual = shape[path];

    if (!actual) {
      if (!alwaysPresent) continue;
      // The container itself was empty this time (an empty `clips` or `tags`
      // array). Nothing under it could appear, so its absence is not evidence.
      if ((containers.get(containerOf(path)) ?? 0) === 0) continue;
      findings.push({
        severity: isConsumed(path, consumedPaths) || holder ? 'error' : 'warn',
        kind: 'removed',
        path,
        expected: entry.types,
        detail: `present in all ${entry.total} baseline occurrences, absent now`,
      });
      continue;
    }

    // `null` showing up where a value used to live is a value-level change, not
    // a schema change: Suno leaves audio_url null until rendering finishes. Only
    // flag it when null was never once observed at this path.
    const newTypes = actual.filter((t) => !entry.types.includes(t));
    if (newTypes.length > 0) {
      const onlyNull = newTypes.length === 1 && newTypes[0] === 'null';
      findings.push({
        severity: isConsumed(path, consumedPaths) && !onlyNull ? 'error' : 'warn',
        kind: 'retyped',
        path,
        expected: entry.types,
        actual,
        detail: `type widened to include ${newTypes.join(', ')}`,
      });
    }
  }

  for (const [path, types] of Object.entries(shape)) {
    if (!baseline.paths[path]) {
      findings.push({
        severity: 'info',
        kind: 'added',
        path,
        actual: types,
        detail: 'new field, not in baseline',
      });
    }
  }

  findings.sort((a, b) => rank(b.severity) - rank(a.severity) || a.path.localeCompare(b.path));

  return {
    endpoint: baseline.endpoint,
    findings,
    degraded: findings.some((f) => f.severity !== 'info'),
  };
}

function rank(s: DriftSeverity): number {
  return s === 'error' ? 2 : s === 'warn' ? 1 : 0;
}

export function formatDriftReport(report: DriftReport): string {
  if (report.findings.length === 0) return `${report.endpoint}: no drift`;
  const lines = [`${report.endpoint}: ${report.findings.length} finding(s)`];
  for (const f of report.findings) {
    lines.push(`  [${f.severity}] ${f.kind} ${f.path} - ${f.detail}`);
  }
  return lines.join('\n');
}
