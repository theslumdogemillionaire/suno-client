# suno-client

[![ci](https://github.com/theslumdogemillionaire/suno-client/actions/workflows/ci.yml/badge.svg)](https://github.com/theslumdogemillionaire/suno-client/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-262%20passing-brightgreen)](tests/unit)
[![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)](package.json)
[![schema canary](https://img.shields.io/badge/schema%20canary-0%20credits-blueviolet)](src/drift/probe.ts)
[![license](https://img.shields.io/badge/license-WTFPL-black)](LICENSE)

A typed Node client for Suno's private web API, built to survive Suno changing it.

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

That is a free, exact, daily check on the one thing that actually broke last
time. It runs in [`scripts/canary.ts`](scripts/canary.ts) and names the field.

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
| `captcha_required` | no | yes | generate one song by hand at suno.com |
| `auth_dead` | no | yes | the cookie is finished, log in again |
| `schema_drift` | no | yes | Suno changed the request schema |
| `route_gone` | no | yes | an endpoint moved |

## Install

```bash
npm install
cp .env.example .env    # then paste your __client cookie
```

Get the cookie: log into suno.com, devtools, Application, Cookies, `suno.com`,
copy `__client`. It lasts about 7 days. A full `Cookie:` header pasted whole
works too.

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
npm run build               # also copies the drift baselines into dist/
npm run canary
npm run canary -- --paid    # adds one real generation, 10 credits
npm run smoke               # live read-only check
```

There is also a small CLI for operational work, once built:

```bash
node dist/cli.js credits
node dist/cli.js list 10
node dist/cli.js generate --title T --tags "pop, warm" --lyrics-file song.txt --wait --download ./songs
```

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

Jobs survive a restart: `suno.job(ids)` rehydrates one from clip ids you stored.

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
  canary.ts        the scheduled health check
  record-baselines.ts
  smoke.ts
docs/
  API.md           full wire spec: every endpoint, every field
  STATUS.md        what works, what is broken, what it cost to learn
```

## License

[WTFPL](LICENSE). Putting terms and conditions on a reverse-engineered client
would be its own kind of joke, so: do what the fuck you want to.
