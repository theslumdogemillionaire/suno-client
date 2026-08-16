/**
 * The canary.
 *
 * Run this on a schedule. It is the only thing in the repo that can notice Suno
 * changing: the unit tests pin our own assumptions, and assumptions do not
 * change on their own.
 *
 *   npm run canary              free probes only, no credits spent
 *   npm run canary -- --paid    also runs one real generation (10 credits)
 *   npm run canary -- --json    machine-readable, for CI
 *
 * Exit codes: 0 healthy, 1 drift detected, 2 hard failure (auth dead, endpoint
 * gone). CI should fail the build on either non-zero, and the message tells you
 * which field moved.
 */
import { billingInfo, captchaCheck, generateLyrics } from '../src/api/misc.js';
import { getClips, listClips } from '../src/api/feed.js';
import { SunoClient } from '../src/client.js';
import { formatDriftReport, type DriftReport } from '../src/drift/detect.js';
import { ALL_PROBE_VARIANTS, probeGenerateSchema, variantForDay } from '../src/drift/probe.js';
import { registryFromBaselines } from '../src/drift/registry.js';
import { SunoError } from '../src/errors.js';
import { Suno } from '../src/suno.js';

const wantPaid = process.argv.includes('--paid');
const wantJson = process.argv.includes('--json');

interface ProbeOutcome {
  name: string;
  ok: boolean;
  detail: string;
  severity: 'ok' | 'drift' | 'fail';
}

const outcomes: ProbeOutcome[] = [];
const driftReports: DriftReport[] = [];
// The same endpoint gets hit several times per run; report its drift once.
const reportedShapes = new Set<string>();

function record(name: string, ok: boolean, detail: string, severity: ProbeOutcome['severity']): void {
  outcomes.push({ name, ok, detail, severity });
  if (!wantJson) {
    const tag = severity === 'ok' ? 'ok  ' : severity === 'drift' ? 'DRIFT' : 'FAIL ';
    console.log(`${tag} ${name.padEnd(22)} ${detail}`);
  }
}

async function probe(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(name, true, await fn(), 'ok');
  } catch (err) {
    const e = err as SunoError;
    // An alert-class error means the contract moved or the session died. Both
    // need a human; neither is worth retrying into.
    record(name, false, `[${e.code ?? 'error'}] ${e.message}`, e.alert ? 'fail' : 'drift');
  }
}

const cookie = process.env['SUNO_COOKIE'];
const client = new SunoClient({
  ...(cookie ? { cookie } : {}),
  baselines: registryFromBaselines(),
  onDrift: (report) => {
    driftReports.push(report);
    if (report.degraded && !reportedShapes.has(report.endpoint)) {
      reportedShapes.add(report.endpoint);
      record(`shape:${report.endpoint}`, false, formatDriftReport(report).split('\n').slice(1).join(' | '), 'drift');
    }
  },
});
const suno = new Suno({ ...(cookie ? { cookie } : {}) });

async function main(): Promise<void> {
  if (!wantJson) console.log('== free probes ==');

  let clipId: string | undefined;

  await probe('auth + billing', async () => {
    const info = await billingInfo(client);
    return `${info.plan.name}, ${info.total_credits_left} credits, ${info.models?.length ?? 0} models`;
  });

  await probe('captcha gate', async () => {
    const check = await captchaCheck(client);
    if (check.required) throw new SunoError({ code: 'captcha_required', message: 'account is captcha-gated', alert: true });
    return `not required (v${check.captcha_version ?? '?'})`;
  });

  await probe('feed list', async () => {
    const page = await listClips(client, { limit: 5 });
    clipId = page.clips[0]?.id;
    return `${page.clips.length} clips, cursor=${page.next_cursor ? 'present' : 'absent'}`;
  });

  await probe('feed pagination', async () => {
    const first = await listClips(client, { limit: 5 });
    const cursor = first.next_cursor;
    if (typeof cursor !== 'string' || cursor === '') return 'single page, nothing to paginate';
    const second = await listClips(client, { limit: 5, cursor });
    const overlap = second.clips.filter((c) => first.clips.some((f) => f.id === c.id)).length;
    if (overlap > 0) throw new Error(`page 2 repeated ${overlap} clips: the cursor is being ignored`);
    return `page 2 distinct (${second.clips.length} clips)`;
  });

  if (clipId !== undefined) {
    const id = clipId;
    await probe('feed by ids', async () => {
      const clips = await getClips(client, [id]);
      if (clips.length !== 1) throw new Error(`expected 1 clip, got ${clips.length}`);
      return `${clips[0]?.title ?? '?'} [${clips[0]?.status ?? '?'}]`;
    });
  }

  await probe('lyrics (free)', async () => {
    const result = await generateLyrics(client, 'a short calm song about the sea');
    return `"${result.title}" ${result.text.length} chars`;
  });

  if (!wantJson) console.log('== request schema (free, no credits) ==');

  await probe('generate schema', async () => {
    // One variant per run by default, rotating daily. Probing all five at once
    // reads as abuse to Suno and can flip the account's captcha gate.
    const variants = process.argv.includes('--all-variants')
      ? ALL_PROBE_VARIANTS
      : [variantForDay()];
    const results = await probeGenerateSchema(client, { variants });
    const drifted = results.filter((r) => !r.schemaValid);
    if (drifted.length > 0) {
      throw new Error(
        drifted.map((d) => `${d.variant}: ${d.field ?? '?'} (${d.errorType ?? '?'})`).join('; '),
      );
    }
    return `${results.map((r) => r.variant).join(', ')} still accepted`;
  });

  if (wantPaid) {
    if (!wantJson) console.log('== paid probe ==');
    await probe('real generation', async () => {
      const job = await suno.generate({
        title: 'canary',
        tags: 'minimal ambient drone, no vocals',
        lyrics: '[Instrumental]',
        instrumental: true,
      });
      const clips = await job.wait({ timeoutMs: 420_000 });
      const complete = clips.filter((c) => c.status === 'complete').length;
      if (complete === 0) throw new Error(`no clip completed: ${clips.map((c) => c.status).join(', ')}`);
      return `${complete}/${clips.length} complete, ids ${job.ids.map((i) => i.slice(0, 8)).join(' ')}`;
    });
  }

  const failed = outcomes.filter((o) => o.severity === 'fail');
  const drifted = outcomes.filter((o) => o.severity === 'drift');

  if (wantJson) {
    console.log(JSON.stringify({ outcomes, driftReports }, null, 2));
  } else {
    console.log('');
    console.log(`${outcomes.length - failed.length - drifted.length} ok, ${drifted.length} drift, ${failed.length} failed`);
  }

  process.exitCode = failed.length > 0 ? 2 : drifted.length > 0 ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 2;
});
