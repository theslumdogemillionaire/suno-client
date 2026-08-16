/**
 * Live smoke test. Reads-only by default; pass --generate to spend credits.
 *
 *   SUNO_COOKIE=... npx tsx scripts/smoke.ts
 *   SUNO_COOKIE=... npx tsx scripts/smoke.ts --generate
 */
import { Suno } from '../src/index.js';
import { formatDriftReport } from '../src/drift/detect.js';

const cookie = process.env['SUNO_COOKIE'];
const wantGenerate = process.argv.includes('--generate');

const suno = new Suno({
  ...(cookie ? { cookie } : {}),
  onDrift: (r) => console.log(`[drift] ${formatDriftReport(r)}`),
  onRequest: (i) =>
    console.log(
      `[http] ${i.method} ${i.path} -> ${i.status ?? 'ERR'} in ${i.durationMs}ms${i.error ? ` (${i.error.code})` : ''}`,
    ),
});

function ok(label: string, detail: string): void {
  console.log(`  PASS  ${label}: ${detail}`);
}
function bad(label: string, err: unknown): void {
  const e = err as { code?: string; message?: string };
  console.log(`  FAIL  ${label}: [${e.code ?? 'unknown'}] ${e.message ?? String(err)}`);
}

async function main(): Promise<void> {
  console.log('== account ==');
  try {
    const c = await suno.credits();
    ok('credits', `${c.left} left on ${c.plan}`);
  } catch (e) {
    bad('credits', e);
  }

  try {
    const models = await suno.models();
    const usable = models.filter((m) => m.can_use).map((m) => `${m.name}=${m.external_key}`);
    ok('models', usable.join(' '));
  } catch (e) {
    bad('models', e);
  }

  try {
    const check = await suno.captchaCheck();
    ok('captcha', `required=${check.required} version=${check.captcha_version ?? '-'}`);
  } catch (e) {
    bad('captcha', e);
  }

  console.log('== library ==');
  let firstId: string | undefined;
  try {
    const page = await suno.list({ limit: 5 });
    firstId = page.clips[0]?.id;
    ok('list', `${page.clips.length} clips, has_more=${page.has_more} cursor=${page.next_cursor ? 'yes' : 'no'}`);
  } catch (e) {
    bad('list', e);
  }

  try {
    const page1 = await suno.list({ limit: 5 });
    const cursor = page1.next_cursor;
    if (typeof cursor === 'string' && cursor !== '') {
      const page2 = await suno.list({ limit: 5, cursor });
      const overlap = page2.clips.filter((c) => page1.clips.some((p) => p.id === c.id)).length;
      ok('pagination', `page2=${page2.clips.length} clips, overlap=${overlap}`);
    } else {
      ok('pagination', 'no second page');
    }
  } catch (e) {
    bad('pagination', e);
  }

  if (firstId !== undefined) {
    try {
      const clip = await suno.info(firstId);
      ok('info', `${clip.title} [${clip.status}]`);
    } catch (e) {
      bad('info', e);
    }
    try {
      const words = await suno.alignedLyrics(firstId);
      ok('alignedLyrics', `${words.length} words`);
    } catch (e) {
      bad('alignedLyrics', e);
    }
  }

  try {
    const found = await suno.search('a');
    ok('search', `${found.clips.length} hits`);
  } catch (e) {
    bad('search', e);
  }

  console.log('== free generation ==');
  try {
    const lyrics = await suno.lyrics('a short song about coffee at 3am');
    ok('lyrics', `"${lyrics.title}" ${lyrics.text.length} chars`);
  } catch (e) {
    bad('lyrics', e);
  }

  if (!wantGenerate) {
    console.log('\n(skipping paid paths; pass --generate to spend credits)');
    return;
  }

  console.log('== paid generation ==');
  try {
    const job = await suno.generate({
      title: 'Smoke Test',
      tags: 'minimal ambient, 80 BPM, no vocals',
      lyrics: '[Instrumental]',
      instrumental: true,
    });
    ok('generate', `submitted ${job.ids.length} clips: ${job.ids.map((i) => i.slice(0, 8)).join(' ')}`);

    for await (const update of job.watch({ timeoutMs: 300_000 })) {
      console.log(
        `  .. ${update.clips.map((c) => `${c.id.slice(0, 8)}=${c.status}`).join(' ')} (${Math.round(update.elapsedMs / 1000)}s)`,
      );
    }
    ok('wait', `${job.completed.length} complete, ${job.failed.length} failed`);

    const res = await suno.downloadAll(job.completed, { outputDir: './tmp-songs' });
    ok('download', `${res.downloaded.length} files, ${res.failed.length} failed`);
    for (const f of res.downloaded) console.log(`     ${f}`);
  } catch (e) {
    bad('generate', e);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
