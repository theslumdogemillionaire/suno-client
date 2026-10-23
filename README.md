# suno-client

[![ci](https://github.com/theslumdogemillionaire/suno-client/actions/workflows/ci.yml/badge.svg)](https://github.com/theslumdogemillionaire/suno-client/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/suno-client?logo=npm&color=cb3837)](https://www.npmjs.com/package/suno-client)
[![module formats](https://img.shields.io/badge/ESM%20%2B%20CJS-dual-informational)](package.json)
[![tests](https://img.shields.io/badge/tests-411%20passing-brightgreen)](tests/unit)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=nodedotjs&logoColor=white)](package.json)
[![license](https://img.shields.io/badge/license-WTFPL-black)](LICENSE)

A typed Node client for Suno's private web API, built to survive Suno changing it.

It was written for [The Slumdoge Millionaire](https://www.theslumdogemillionaire.com/),
an AI VTuber who writes songs with his Twitch chat.

There is no official Suno API. This talks to the web app's endpoints with your
browser session, which puts it outside Suno's terms of service. Read
[docs/STATUS.md](docs/STATUS.md) before building anything on it.

```ts
import { Suno } from 'suno-client';

const suno = new Suno({ cookie: process.env.SUNO_COOKIE });

const job = await suno.generate({
  title: 'Night Drive',
  tags: 'indie rock, jangly and nostalgic, 110 BPM, warm male vocals',
  lyrics: '[Verse]\nHeadlights on an empty road\n[Chorus]\nKeep driving, keep driving',
});

for await (const update of job.watch()) {
  console.log(update.clips.map((c) => `${c.title}: ${c.status}`).join(', '));
}

await suno.downloadAll(job.completed, { outputDir: './songs' });
```

## Why this exists

Every unofficial Suno client eventually breaks, because Suno changes the API and
nobody finds out until production 422s. In August 2026 `title: null` stopped
being accepted and the most complete open-source client stayed broken for two
weeks. Its 134 tests did not notice, because they tested its own output format
and never touched the network.

So this client is built around one question: **how do we find out that Suno moved
before our users do?** Three answers, in descending order of how much they help.

### 1. A free request-schema probe

This replaces the obvious approach, which was to scrape suno.com's JS bundle and
diff the payload shape out of minified code. Asking the server directly is
strictly better: it is exact, it is authoritative, and it does not break when
Suno changes bundler.

Suno validates the request body **before** it validates the request token.
So a body that is schema-correct but names a nonsense model never reaches
generation, never costs a credit, and still reveals whether the schema accepts
our shape.

```
body ok, bogus model  -> 422 token_validation_failed     schema is FINE
body missing a field  -> 422 body.params.X "missing"     schema DRIFTED
body has a wrong type -> 422 body.params.X "string_type" schema DRIFTED
```

That is a free, exact check on the one thing that actually broke last time. It
runs in [`scripts/canary.ts`](scripts/canary.ts), by hand or from the manually
triggered `canary` workflow, and names the field.

It keeps working when the account is captcha-gated, which is the case that could
have made the whole idea worthless: schema errors still surface ahead of the gate,
so the canary cannot sit green while blind. Verified.

It is free in credits but **not free in reputation**: each probe is a rejected
create, and a burst of them looks like abuse. Developing this feature flipped the
test account's captcha gate on. Hence one variant per run, rotated daily. The
full story is in [docs/STATUS.md](docs/STATUS.md).

### 2. Response-shape drift detection

Zod schemas run in passthrough mode, so a field Suno adds never breaks a parse.
Separately, every response is fingerprinted and compared against a committed
baseline:

- a **new** field is `info`, because feature launches should not page anyone
- a field **we read** that disappears or changes type is `error`
- anything else is `warn`

```ts
const suno = new Suno({
  cookie,
  onDrift: (report) => {
    if (report.degraded) alertMe(formatDriftReport(report));
  },
});
```

Getting this quiet enough to be worth reading needed two non-obvious fixes,
both documented in [docs/STATUS.md](docs/STATUS.md).

### 3. Errors that say what to do

Every `SunoError` carries two booleans, and callers branch on those rather than
on class names:

- `retryable` - the same request may succeed later
- `alert` - a human is needed; waiting will not help

A long-running consumer keeps going through the retryable class and stops loudly
on the alert class. Treating a schema drift as transient means burning credits on
requests that can never succeed.

| code | retryable | alert | means |
| --- | --- | --- | --- |
| `rate_limited` | yes | no | back off |
| `network`, `timeout` | yes | no | transient |
| `api_error` (5xx) | yes | no | Suno is unwell |
| `invalid_input` | no | no | the caller's or the user's text was rejected |
| `insufficient_credits` | no | no | out of credits |
| `not_found` | no | no | bad id |
| `auth_expired` | no | no | handled internally: refresh and replay once |
| `plan_required` | no | no | this account's plan does not allow that (403) |
| `playback_denied` | no | no | `/api/mango/rights` refused this clip (401/403); never observed so far |
| `captcha_required` | no | yes | generate one song by hand at suno.com |
| `auth_dead` | no | yes | the cookie is finished, log in again |
| `schema_drift` | no | yes | Suno changed the request schema |
| `route_gone` | no | yes | an endpoint moved |

A cancel through your own `AbortSignal` comes back as `network` (`timeout` for
`AbortSignal.timeout()`) with `retryable: false`, and nothing is sent once the
signal has fired: a create cancelled during the model lookup is not submitted.
`timeoutMs` covers a whole attempt, session refresh and response body included.

Bulk downloads follow the same split. `downloadAll` and `downloadPlaylist` record
a refusal about one clip (`download_locked`, nothing rendered yet) in `failed`,
with its `code`, and carry on; a cancel or an alert-class error stops the run and
throws, since every remaining clip would fail the same way.

### 4. It works on any account tier

Verified live on both a subscription and a Free account. That distinction is not
cosmetic: a Free account's billing payload has **no `plan` object at all**, and
the model the web app defaults to (v5.5) reports `can_use: false` there, so a
client that assumes the paid shape fails on billing and then 403s on every
create. This one asks instead.

```ts
const account = await suno.account();
// { tier: 'free', planName: 'Free Plan', creditsLeft: 60,
//   defaultModel: 'chirp-auk-turbo', features: ['tag_upsample'], ... }

if (await suno.can('get_stems')) await suno.stems(clipId);
```

`can()` reads Suno's `accessible_features`, which under-reports: a `true` is
reliable, a `false` only means "not listed". Cover is the worked example - not
listed on Free, and it submits fine. Let `plan_required` be the real answer.

Creates with no explicit `model` resolve to one the account may actually use,
from a single billing lookup cached per client. Pass `model` to skip it, or
`new Suno({ resolveModel: false })` to pin the old hardcoded default. A
subscription-only feature answers `plan_required` rather than pretending your
session died.

## Install

```bash
npm install suno-client
```

Node 22.13+ (`login --from-browser` reads the cookie database with `node:sqlite`,
which older 22.x lines only expose behind `--experimental-sqlite`). Ships both ESM and CommonJS, so `import` and `require` both work, with
types resolving correctly from either. Verified with `publint` and
`are-the-types-wrong`, and by installing the tarball into a CJS project and an
ESM project in CI.

```js
import { Suno } from 'suno-client';        // ESM
const { Suno } = require('suno-client');   // CJS
```

To work on the client itself instead:

```bash
git clone https://github.com/theslumdogemillionaire/suno-client && cd suno-client
npm install
cp .env.example .env    # then paste your __client cookie
```

### Getting a session, and getting it back

If you are signed in to Suno in a local Chrome, Brave, Edge or Chromium, take
the session straight from it and skip the devtools dance entirely:

```bash
suno-client login --from-browser
```

It searches every profile and prints which one it used. macOS raises a Keychain
prompt, because reading the browser's cookie key is exactly the kind of thing an
operating system should ask about; approving it once is the whole interaction.
Narrow it with `--browser chrome` or `--profile Default`.

When a machine holds more than one Suno session, expiry does **not** decide.
The machine this was built on has two Chrome profiles signed into two different
Clerk accounts, with cookies expiring seven seconds apart — so "longest-lived"
would have been a coin flip between accounts. Instead: a session already stored
settles it (that is the reconnect case, unambiguous by construction), and
otherwise the command stops and asks which, listing each profile with its client
id. Expiry only ever breaks ties within one account.

The device id travels with the session. `--from-browser` lifts the profile's own
`ajs_anonymous_id` too and hands `login` a full `Cookie:` header, which is the
most faithful value. A bare `__client` keeps the device id already stored, or
stores one generated once for this installation, so it never changes from one
process to the next — the unstable fingerprint the header comments warn about.

The manual route still works, and is the only one on Windows: log into
suno.com, devtools, Application, Cookies, **`auth.suno.com`** (not `suno.com` —
Clerk serves it from the auth subdomain), copy `__client`, then
`suno-client login --stdin`. A full `Cookie:` header pasted whole works too.

The cookie is good for about a **year**, not the week this README claimed until
2026-09-10 — measured at 2027-09-09 on a profile signed in that day. Which
reframes what a dead session usually is: not an expired cookie, but one that was
rotated by signing in again elsewhere, or one that was never stored. Before
re-logging in, ask what state you are actually in:

```bash
suno-client session
```

It reports whether a session is stored, when its JWT expires, whether the next
call will refresh it, and whether Suno answers right now — without printing the
cookie or the token. Four different problems look identical from the outside,
and re-logging in fixes only one of them.

## Running things

Everything runs in Docker.

```bash
docker compose run --rm test              # unit suite, no network, no account
docker compose run --rm typecheck
docker compose run --rm canary            # free probes, needs .env
docker compose run --rm smoke             # live read-only check
docker compose run --rm record-baselines  # after a verified client change
```

Locally, if you prefer:

```bash
npm test
npm run build               # dual ESM + CJS into dist/, baselines compiled in
npm run canary
npm run canary -- --paid    # adds one real generation, 10 credits
npm run smoke               # live read-only check
```

There is also a small CLI for operational work, once built:

```bash
node dist/esm/cli.js credits
node dist/esm/cli.js list 10
node dist/esm/cli.js generate --title T --tags "pop, warm" --lyrics-file song.txt --wait --download ./songs
```

Exit codes: `0` done, `1` an ordinary failure (including a download that failed
for any clip), `2` a human needs to act — dead session, moved endpoint, changed
response. `login`, `logout` and `session` always act on the stored session, even
with `SUNO_COOKIE` set; `login` still reads its cookie from there.

## For a live consumer (bots, overlays, queues)

`generate()` returns a `GenerationJob` rather than clips, because the interesting
part of a Suno generation is the two minutes after you submit it.

```ts
const job = await suno.generate({ title, tags, lyrics });
await chat.say(`generating ${job.ids.length} takes`);

for await (const update of job.watch()) {
  for (const clip of update.changed) {
    await chat.say(`${clip.title}: ${clip.status}`);
  }
}

for (const { clip, reason } of job.failed) {
  await chat.say(`${clip.title} failed: ${reason}`);
}
```

Jobs survive a restart: `suno.job(ids)` rehydrates one from clip ids you stored,
and keeps waiting on every one of them, including a clip the feed does not show
yet.

### One call for everything an overlay needs

```ts
const t = await suno.track(clipId);
// title, style, lyrics, artworkUrl, durationS,
// words (word-level timings), lrc,
// barLines (seconds), bpm, key
```

`barLines` comes from Suno's own beat grid, not from a fixed BPM interval, so
visuals stay locked when the tempo drifts. `suno.waveform(clipId)` returns a
pre-computed waveform at 11 resolutions, which beats downloading and decoding
the MP3 to draw a scrubber.

These endpoints (`downbeats`, `key`, `waveform-aggregates`, `stems/pages`) do not
appear in any other unofficial client. They came out of watching suno.com's own
network traffic.

Three things that matter when prompts come from strangers:

- Content rejections arrive as `invalid_input`. Reply in chat; do not retry.
- Call `suno.captchaCheck()` on a schedule. A gated account cannot generate, and
  clearing it needs a human at suno.com.
- Generation costs 10 credits per call and returns 2 clips. Budget accordingly.

### Playing a track the way suno.com does

```ts
import { pipeline } from 'node:stream/promises';

const track = await suno.playTrack(clipId);
res.setHeader('content-type', track.contentType);
if (track.contentLength !== undefined) res.setHeader('content-length', track.contentLength);
await pipeline(track.stream, res); // or ffmpeg's stdin, or a file
```

`playTrack` reproduces the web player: it fetches the encrypted `media_urls`
file, asks `POST /api/mango/rights` for its keys in parallel, and decrypts as
the bytes arrive. It spends no download from the monthly allowance.

The rights call always goes out anonymous: sent with a session, Suno answers
without the token the decryption needs. Since 0.6.0 the id lookup needs no
session either, so `suno.playTrack(id)` works signed out, for any public clip.
Details, measured on a live account, in [docs/API.md §3.16](docs/API.md).

## Likes, follows and playlists

```ts
await suno.like(clipId);
for await (const clip of suno.iterate({ liked: true })) console.log(clip.title);

const profile = await suno.profile('example_user');   // no session needed
for await (const clip of suno.profileClips('example_user')) console.log(clip.id);
await suno.follow('example_user');
for await (const person of suno.following('example_user')) console.log(person.handle);

const playlist = await suno.createPlaylist('Night Drive');   // starts private
await suno.addToPlaylist(playlist.id, [clipId]);
await suno.removeFromPlaylist(playlist.id, [clipId]);
await suno.updatePlaylist(playlist.id, { name: 'Night Drive II', description: 'after midnight' });
for await (const p of suno.myPlaylists()) console.log(p.name);
await suno.trashPlaylist(playlist.id);
```

Suno removes from a playlist by position as well as by id, so
`removeFromPlaylist` reads the playlist first to find each clip. `updatePlaylist`
needs both fields: the server wants a description with every rename. Creating a
playlist is never retried, and neither is adding to one, because a replay would
do it twice. `restorePlaylist` exists and has not been seen working.

## Searching all of Suno

```ts
const page = await suno.searchPublic('piano ballad', { size: 100, rankBy: 'play_count' });
// { clips, totalHits, fromIndex, pageSize }
```

This is suno.com's search box: everyone's public songs. `suno.search()` is
something else, a filter over your own library. Public search serves a window:
`fromIndex` past about 200 returns nothing, whatever `totalHits` says.

## Looking like a browser

Measured, not assumed. The web app's own code sets four headers on a studio-api
call: `accept-language`, `authorization`, `browser-token`, `device-id`, plus
`content-type` on a POST. The rest are browser-added, so this client supplies
them by hand and matches the set exactly.

Two consequences worth knowing:

- It does **not** send `accept: application/json`. The web app does not, so
  sending it is a tell.
- `device-id` is a stable random UUID per installation, never a constant. An
  all-zeros placeholder is the most identifiable value you could possibly ship.

It does **not** match Chrome's TLS handshake or HTTP/2 SETTINGS. JA3/JA4
fingerprinting sees straight through it. The header layer is browser-shaped; the
transport layer is Node and looks like Node.

## Layout

```
src/
  suno.ts          the ergonomic surface
  client.ts        transport: auth, retry, error classification, drift hook
  auth.ts          Clerk cookie -> session -> JWT, staleness rule
  poll.ts          GenerationJob: watch(), wait(), completed, failed
  download.ts      MP3 + ID3 with synced lyrics
  errors.ts        the taxonomy above
  schemas.ts       zod, passthrough
  api/             one module per endpoint group
  drift/
    shape.ts       response fingerprinting
    detect.ts      baseline diffing
    probe.ts       the free request-schema probe
    baselines/     committed, recorded from live traffic
scripts/
  canary.ts        the on-demand health check
  record-baselines.ts
  smoke.ts
docs/
  API.md           full wire spec: every endpoint, every field
  STATUS.md        what works, what is broken, what it cost to learn
```

## License

[WTFPL](LICENSE). Putting terms and conditions on a reverse-engineered client
would be its own kind of joke, so: do what the fuck you want to.
