#!/usr/bin/env node
/**
 * A thin CLI over the library. Deliberately small: the library is the product,
 * this exists so you can log in, check a session and run a canary without
 * writing a script.
 */
import { readFileSync } from 'node:fs';

import { Suno } from './suno.js';
import {
  BROWSER_NAMES,
  chooseCookie,
  clientIdOf,
  findSessionCookies,
  type BrowserName,
} from './browser-cookie.js';
import { decodeJwtClaims } from './auth.js';
import { FileAuthStore, defaultAuthPath } from './store.js';
import { SunoError } from './errors.js';
import { formatDriftReport } from './drift/detect.js';
import { registryFromBaselines } from './drift/registry.js';

const USAGE = `suno-client <command>

  login [--stdin]      store a session from SUNO_COOKIE, a file, or stdin
  login --from-browser lift the session straight out of a local browser
                       [--browser chrome|brave|edge|chromium] [--profile Default]
  session              is the stored session alive, and until when
  logout               forget the stored session
  account              tier, plan, credits, unlocked features, usable models
  credits              plan and remaining credits
  models               models this account can use
  list [n]             most recent clips
  search <query>       search your library
  info <id>            one clip
  playlist <url|id>    public playlist (no login)
  lyrics <prompt>      generate lyrics (free)
  generate             --title T --tags T --lyrics-file F [--model M] [--wait] [--download DIR]
  describe <prompt>    inspiration mode [--wait] [--download DIR]
  download <id...>     --out DIR [--source download|playback]
  download --playlist <url|id> --out DIR
                       public playlist via playback (no quota)
  trash <id...>        move clips to trash
  restore <id...>      undo a trash

Auth: SUNO_COOKIE, or a session stored by \`login\` (0600, under XDG config).
`;

const VALUED_FLAGS = [
  'out',
  'browser',
  'profile',
  'model',
  'title',
  'tags',
  'lyrics-file',
  'download',
  'source',
  'playlist',
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Positional arguments, with flags AND the values they consume removed.
 *
 * Filtering on a leading `--` alone drops the flag and leaves its value sitting
 * in the list, so `download <id> --out /tmp/songs` asked Suno for two clips:
 * the real one and `/tmp/songs`. Suno answers 404 to the pair, which surfaced
 * as "HTTP 404 on /api/feed/" — an endpoint that was perfectly fine, named as
 * the culprit, at a moment when Suno really had just moved things. Second time
 * this shape of bug has cost an investigation; the first was `list --limit 6`
 * turning into `limit: null`.
 */
function positionals(rest: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i] as string;
    if (!item.startsWith('--')) {
      out.push(item);
      continue;
    }
    if (VALUED_FLAGS.includes(item.slice(2))) i += 1;
  }
  return out;
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

/**
 * The session cookie, taken from a browser on this machine.
 *
 * Deliberately chatty about WHERE it found the thing. A machine with the
 * account open in two Chrome profiles has two valid cookies, and a command that
 * silently picked one would eventually sign a bot in as the wrong account
 * without a word — so the choice is printed, on stderr so that piping stdout
 * still works.
 */
async function cookieFromBrowser(): Promise<string> {
  const requested = arg('browser');
  if (requested !== undefined && !BROWSER_NAMES.includes(requested as BrowserName)) {
    throw new SunoError({
      code: 'invalid_input',
      message: `unknown browser ${JSON.stringify(requested)}; try one of ${BROWSER_NAMES.join(', ')}`,
    });
  }
  const profile = arg('profile');
  console.error('[login] reading the browser cookie store; macOS will ask for Keychain permission.');

  const found = await findSessionCookies({
    ...(requested ? { browsers: [requested as BrowserName] } : {}),
    ...(profile !== undefined ? { profile } : {}),
  });
  if (found.length === 0) {
    throw new SunoError({
      code: 'auth_missing',
      message:
        'no Suno session found in any local browser profile. Sign in at https://suno.com in ' +
        'Chrome, Brave, Edge or Chromium and run this again — or paste the cookie: ' +
        'suno-client login --stdin',
    });
  }
  // An already-stored session settles the choice: re-taking a cookie for the
  // client we are already using cannot pick the wrong account.
  const stored = await new FileAuthStore(defaultAuthPath()).load().catch(() => undefined);
  const knownClientId = stored ? clientIdOf(stored.clerkClientCookie) : undefined;
  const choice = chooseCookie(found, { knownClientId });

  if (choice.kind === 'none') {
    throw new SunoError({ code: 'auth_missing', message: 'no usable cookie' });
  }
  if (choice.kind === 'ambiguous') {
    const list = choice.candidates
      .map((c) => `  --browser ${c.browser} --profile ${JSON.stringify(c.profile)}  (client ${c.clientId ?? 'unknown'})`)
      .join('\n');
    throw new SunoError({
      code: 'invalid_input',
      message:
        `found ${choice.candidates.length} Suno sessions belonging to DIFFERENT accounts, and ` +
        `expiry is not a safe way to choose between them. Say which one:\n${list}`,
    });
  }

  const chosen = choice.cookie;
  if (found.length > 1) {
    const why = knownClientId !== undefined ? 'matches the session already stored' : 'same account, expires last';
    console.error(`[login] ${found.length} sessions found; using ${chosen.browser}/${chosen.profile} (${why}).`);
  }
  const until = chosen.expiresAt ? ` (valid until ${chosen.expiresAt.toISOString().slice(0, 10)})` : '';
  console.error(`[login] using ${chosen.browser}/${chosen.profile}${until}.`);
  return chosen.cookieHeader;
}

/**
 * What state the stored session is in, without spending a generation to find
 * out.
 *
 * This exists because "suno déconne" has at least four distinct causes that
 * look identical from the outside — no session stored, a cookie that was
 * rotated elsewhere, a JWT that is merely stale, and Suno having changed
 * something underneath — and the first move was always to re-login, which fixes
 * exactly one of them and wastes time on the other three.
 *
 * Never prints the cookie or the token. Lengths, prefixes and timestamps say
 * everything a diagnosis needs and nothing a leaked terminal buffer could use.
 */
async function describeSession(suno: Suno): Promise<unknown> {
  const path = defaultAuthPath();
  const stored = await new FileAuthStore(path).load();
  if (stored === undefined) {
    return {
      file: path,
      stored: false,
      advice: 'no session stored. Run: suno-client login --from-browser',
    };
  }

  const claims = stored.jwt ? decodeJwtClaims(stored.jwt) : undefined;
  const expSeconds = typeof claims?.exp === 'number' ? claims.exp : undefined;
  const expiresAt = expSeconds === undefined ? undefined : new Date(expSeconds * 1000);
  const secondsLeft = expSeconds === undefined ? undefined : Math.round(expSeconds - Date.now() / 1000);

  // The token can be inside its exp and still be refused. Suno's generate
  // endpoint starts rejecting one about half an hour in, which is why the
  // client refreshes on a margin rather than on expiry — reporting "valid"
  // purely on exp would contradict what the caller is about to experience.
  const staleness = secondsLeft === undefined ? undefined : secondsLeft < 1800;

  let live: unknown;
  try {
    const c = await suno.credits();
    live = { reachable: true, plan: c.plan, tier: c.tier, credits: c.left };
  } catch (err) {
    live =
      err instanceof SunoError
        ? { reachable: false, code: err.code, alert: err.alert, message: err.message }
        : { reachable: false, message: err instanceof Error ? err.message : String(err) };
  }

  return {
    file: path,
    stored: true,
    cookieLength: stored.clerkClientCookie.length,
    sessionId: stored.sessionId ?? null,
    deviceId: stored.deviceId ?? null,
    jwt:
      stored.jwt === undefined
        ? null
        : {
            expiresAt: expiresAt?.toISOString() ?? null,
            secondsLeft: secondsLeft ?? null,
            refreshedOnNextCall: staleness ?? null,
          },
    live,
    advice:
      typeof live === 'object' && live !== null && (live as { reachable?: boolean }).reachable
        ? 'session is healthy; nothing to do.'
        : 'session did not answer. Re-take it with: suno-client login --from-browser',
  };
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
      let value: string;
      if (flag('from-browser')) {
        value = await cookieFromBrowser();
      } else if (flag('stdin')) {
        value = await readStdin();
      } else {
        value = cookie ?? '';
      }
      if (value === '') {
        throw new SunoError({
          code: 'invalid_input',
          message: 'no cookie: set SUNO_COOKIE, pass --stdin, or use --from-browser',
        });
      }
      await suno.login(value);
      const c = await suno.credits();
      out(`signed in: ${c.plan} (${c.tier}), ${c.left} credits`);
      return;
    }

    case 'session': {
      out(await describeSession(suno));
      return;
    }

    case 'logout':
      await suno.logout();
      out('session cleared');
      return;

    case 'account': {
      const a = await suno.account();
      out({
        tier: a.tier,
        plan: a.planName,
        planKey: a.planKey,
        creditsLeft: a.creditsLeft,
        monthlyLimit: a.monthlyLimit,
        defaultModel: a.defaultModel,
        features: a.features,
        usableModels: a.usableModels.map((m) => m.external_key),
      });
      return;
    }

    case 'credits':
      out(await suno.credits());
      return;

    case 'models':
      out((await suno.models()).map((m) => ({ name: m.name, key: m.external_key, usable: m.can_use })));
      return;

    case 'list': {
      // Number('--limit') is NaN, JSON.stringify turns that into null, and Suno
      // answers 422 — which the client reports as schema_drift with alert set,
      // i.e. the loudest error in the taxonomy, raised by a typo. `list` takes a
      // bare count, so anything unparseable is a mistake, not a smaller page.
      const limit = Number(rest[0] ?? 20);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error(`list takes a count, got ${JSON.stringify(rest[0])}`);
      }
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
      const job = await suno.describe({ prompt: positionals(rest).join(' ') });
      out({ submitted: job.ids });
      await finish(suno, job);
      return;
    }

    case 'playlist': {
      const id = positionals(rest)[0];
      if (id === undefined) throw new SunoError({ code: 'invalid_input', message: 'usage: playlist <url|id>' });
      const pl = await suno.playlist(id);
      out({
        id: pl.id,
        name: pl.name,
        user: pl.userHandle ?? pl.userDisplayName,
        tracks: pl.clips.length,
        clips: pl.clips.map((c) => ({ id: c.id, title: c.title, status: c.status })),
      });
      return;
    }

    case 'download': {
      const playlist = arg('playlist');
      const sourceArg = arg('source');
      if (sourceArg !== undefined && sourceArg !== 'download' && sourceArg !== 'playback') {
        throw new SunoError({
          code: 'invalid_input',
          message: 'source must be download or playback',
        });
      }
      const outputDir = arg('out') ?? './songs';
      if (playlist !== undefined) {
        const res = await suno.downloadPlaylist(playlist, {
          outputDir,
          source: sourceArg ?? 'playback',
        });
        out(res);
        return;
      }
      const ids = positionals(rest);
      if (ids.length === 0) throw new SunoError({ code: 'invalid_input', message: 'download needs at least one clip id' });
      const clips = await suno.get(ids);
      const res = await suno.downloadAll(clips, {
        outputDir,
        ...(sourceArg !== undefined ? { source: sourceArg } : {}),
      });
      out(res);
      return;
    }

    case 'trash':
      await suno.trash(positionals(rest));
      out('moved to trash');
      return;

    case 'restore':
      await suno.restore(positionals(rest));
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
