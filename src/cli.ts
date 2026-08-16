#!/usr/bin/env node
/**
 * A thin CLI over the library. Deliberately small: the library is the product,
 * this exists so you can log in, check a session and run a canary without
 * writing a script.
 */
import { readFileSync } from 'node:fs';

import { Suno } from './suno.js';
import { SunoError } from './errors.js';
import { formatDriftReport } from './drift/detect.js';
import { registryFromBaselines } from './drift/registry.js';

const USAGE = `suno-client <command>

  login [--stdin]      store a session from SUNO_COOKIE, a file, or stdin
  logout               forget the stored session
  credits              plan and remaining credits
  models               models this account can use
  list [n]             most recent clips
  search <query>       search your library
  info <id>            one clip
  lyrics <prompt>      generate lyrics (free)
  generate             --title T --tags T --lyrics-file F [--model M] [--wait] [--download DIR]
  describe <prompt>    inspiration mode [--wait] [--download DIR]
  download <id...>     --out DIR
  trash <id...>        move clips to trash
  restore <id...>      undo a trash

Auth: SUNO_COOKIE, or a session stored by \`login\` (0600, under XDG config).
`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function out(value: unknown): void {
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const cookie = process.env['SUNO_COOKIE'];
  const suno = new Suno({
    ...(cookie ? { cookie } : {}),
    baselines: registryFromBaselines(),
    onDrift: (report) => {
      if (report.degraded) console.error(`[drift] ${formatDriftReport(report)}`);
    },
  });

  switch (command) {
    case undefined:
    case 'help':
    case '--help':
      out(USAGE);
      return;

    case 'login': {
      const value = flag('stdin') ? await readStdin() : (cookie ?? '');
      if (value === '') throw new SunoError({ code: 'invalid_input', message: 'no cookie: set SUNO_COOKIE or pass --stdin' });
      await suno.login(value);
      const c = await suno.credits();
      out(`signed in: ${c.plan}, ${c.left} credits`);
      return;
    }

    case 'logout':
      await suno.logout();
      out('session cleared');
      return;

    case 'credits':
      out(await suno.credits());
      return;

    case 'models':
      out((await suno.models()).map((m) => ({ name: m.name, key: m.external_key, usable: m.can_use })));
      return;

    case 'list': {
      const limit = Number(rest[0] ?? 20);
      const page = await suno.list({ limit });
      out(page.clips.map((c) => ({ id: c.id, title: c.title, status: c.status, created: c.created_at })));
      return;
    }

    case 'search': {
      const query = rest.join(' ');
      const page = await suno.search(query);
      out(page.clips.map((c) => ({ id: c.id, title: c.title, status: c.status })));
      return;
    }

    case 'info': {
      const id = rest[0];
      if (id === undefined) throw new SunoError({ code: 'invalid_input', message: 'usage: info <id>' });
      out(await suno.info(id));
      return;
    }

    case 'lyrics':
      out(await suno.lyrics(rest.join(' ')));
      return;

    case 'generate': {
      const title = arg('title');
      const tags = arg('tags');
      const lyricsFile = arg('lyrics-file');
      if (title === undefined || tags === undefined || lyricsFile === undefined) {
        throw new SunoError({
          code: 'invalid_input',
          message: 'usage: generate --title T --tags T --lyrics-file F',
        });
      }
      const model = arg('model');
      const job = await suno.generate({
        title,
        tags,
        lyrics: readFileSync(lyricsFile, 'utf8'),
        ...(model !== undefined ? { model } : {}),
      });
      out({ submitted: job.ids });
      await finish(suno, job);
      return;
    }

    case 'describe': {
      const job = await suno.describe({ prompt: rest.filter((r) => !r.startsWith('--')).join(' ') });
      out({ submitted: job.ids });
      await finish(suno, job);
      return;
    }

    case 'download': {
      const ids = rest.filter((r) => !r.startsWith('--'));
      const clips = await suno.get(ids);
      const res = await suno.downloadAll(clips, { outputDir: arg('out') ?? './songs' });
      out(res);
      return;
    }

    case 'trash':
      await suno.trash(rest.filter((r) => !r.startsWith('--')));
      out('moved to trash');
      return;

    case 'restore':
      await suno.restore(rest.filter((r) => !r.startsWith('--')));
      out('restored');
      return;

    default:
      out(USAGE);
      process.exitCode = 1;
  }
}

async function finish(suno: Suno, job: Awaited<ReturnType<Suno['generate']>>): Promise<void> {
  if (!flag('wait') && arg('download') === undefined) return;
  for await (const update of job.watch()) {
    console.error(`  ${update.clips.map((c) => `${c.id.slice(0, 8)}=${c.status}`).join(' ')}`);
  }
  const dir = arg('download');
  if (dir !== undefined) {
    out(await suno.downloadAll(job.completed, { outputDir: dir }));
  } else {
    out(job.completed.map((c) => ({ id: c.id, title: c.title, audio: c.audio_url })));
  }
}

main().catch((err: unknown) => {
  if (err instanceof SunoError) {
    console.error(`${err.code}: ${err.message}`);
    // 2 = a human needs to act (dead session, moved endpoint). 1 = ordinary
    // failure. A scheduler can tell "retry later" from "wake someone up".
    process.exitCode = err.alert ? 2 : 1;
    return;
  }
  console.error(err);
  process.exitCode = 1;
});
