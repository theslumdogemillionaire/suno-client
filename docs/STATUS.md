# What works, what does not, and what it cost to find out

Last verified live against a paid account on **2026-08-17**.

Suno has no official API. Everything here talks to the private web API with a
browser session, which is outside Suno's terms of service. A ban lands on a paid
account that presumably holds the commercial rights to your tracks. Decide that
is acceptable before building on this.

## Verified working

| Capability | Method | Notes |
| --- | --- | --- |
| Session from cookie | `suno.login(cookie)` | Clerk `__client` cookie, ~7 days |
| JWT auto-refresh | automatic | Refreshes with under 30 min left, single-flighted |
| Credits and plan | `suno.credits()` | |
| Model list | `suno.models()` | 9 models; v5.5 is `chirp-fenix` |
| Captcha preflight | `suno.captchaCheck()` | Run before spending anything |
| Custom generation | `suno.generate()` | 10 credits per call, 2 clips |
| Description mode | `suno.describe()` | Lyrics written by Suno |
| Cover | `suno.cover()` | Submitted and accepted |
| Lyrics only | `suno.lyrics()` | **Free** |
| Word-level timings | `suno.alignedLyrics()`, `suno.lrc()` | |
| Library listing | `suno.list()`, `suno.iterate()` | Real cursor pagination, no overlap |
| Search | `suno.search()` | |
| Fetch by id | `suno.get()`, `suno.info()` | Batched in pairs, see below |
| Status polling | `job.watch()`, `job.wait()` | queued to streaming to complete |
| Download + ID3 | `suno.download()` | Synced lyrics embedded as SYLT |
| Trash and restore | `suno.trash()`, `suno.restore()` | |
| Stems | `suno.stems()` | Job runs; response shape is not a clip |

A generation measured end to end on 2026-08-17: submitted, `queued` at 4s,
`streaming` at 22s, both clips `complete` at 145s, two MP3s on disk at ~185 kbps
with synced lyrics in the tags.

## Known broken

**`extend`** returns HTTP 400 `Inconsistent task and generation params`, both in
this client and in the Rust reference client it was ported from. The body is
missing something the web app sends. Leading suspect: `continued_aligned_prompt`
must carry the source clip's aligned lyrics rather than being null. Untested,
because confirming it costs credits per attempt. `buildExtendBody` exposes
`continuedAlignedPrompt` for whoever tries.

**`stems`** submits fine and Suno renders both stem clips, but the response is
not a clip object. `requestStems` therefore returns the raw payload plus any
clips it could parse. The stems appear in the feed within a minute as
`<title> - Vocals` and `<title> - Instrumental` and download normally.

## The captcha gate, and how we tripped it

`POST /api/c/check` returns `{required: false}` for accounts above Suno's trust
threshold, and `true` for the rest. While `true`, generation is refused.

**We flipped this account from `false` to `true` on 2026-08-17** while developing
the schema probe: roughly a dozen deliberately malformed create requests in a few
minutes, including one that hit a 429. Suno noticed. This is not a credits
problem and no amount of waiting is guaranteed to fix it.

To clear it: generate one song by hand at suno.com. That satisfies the challenge
and the gate drops back to `false`.

To avoid it: the probe defaults to **one** variant per run, spaced 15s, rotated
daily by `variantForDay()`. Do not run `--all-variants` on a schedule, and never
put the probe in a health check or a loop.

The probe still works while gated, which is the case that could have made it
useless. Verified 2026-08-17 on this now-gated account: a `title: null` body
still returns `body.params.title` rather than the gate error, so schema
validation genuinely runs first in both states and the canary cannot go
permanently green while blind.

## Sharp edges, each of which cost something

**`title` must be a string.** Around 2026-08-01, `title: null` started returning
422 `body.params.title: Input should be a valid string`. Every create path that
did not set an explicit title broke at once: describe, cover, extend. The Rust
reference client is still broken at HEAD for this reason. We always send a
string, and `tests/unit/wire-contract.test.ts` fails if that ever regresses.

**Never send `token_provider`.** v2-web types it as an integer and 422s on a
string. Adding it "for completeness" breaks generation.

**Inspiration mode has no `gpt_description_prompt`.** v2-web dropped it. The mode
is signalled by `metadata.create_mode: "inspiration"` and the description rides
in the same `prompt` field that custom mode uses for lyrics. Clients still
sending `gpt_description_prompt` are talking to the retired `/api/generate/v2/`.

**`Token validation failed` means two different things.** Suno returns the same
`error_type` for a JWT past its server-side staleness window and for a create
whose captcha token it will not accept. The string cannot separate them, so the
client does it by outcome: one JWT refresh, and if the next attempt fails
identically, it reports `captcha_required` instead of sending you to
re-authenticate a session that was never the problem.

**JWTs go stale before they expire.** Suno issues one-hour tokens and starts
rejecting them at around 30 minutes. The client treats "under 30 minutes left" as
expired.

**Fetch clips by id in pairs.** Asking for 4+ ids spanning different generation
batches silently returns only the first two. A poller that trusts a single call
waits forever on ids that finished long ago.

**An empty feed is not "done".** Polling must check that every REQUESTED id
reached a terminal state, not that every RETURNED clip did. The reference client
reported successful generations having produced nothing because of this.

**`error` is terminal.** Waiting for `complete` specifically hangs until timeout
on any moderation rejection.

**HTTP 200 can mean failure.** `{"status": "error", "clips": []}` comes back with
a 200 after credits are quoted. Treating 200 as success reports a generation that
does not exist.

**Suno's content filter rejects prompts.** `Prompt likely malformed` arrives as
an `error_message` on an otherwise fine response. With prompts from strangers,
which for a chat bot is immediately, this is routine. The client classifies it as
`invalid_input`: terminal, the user's problem, worth a reply rather than a retry.

## Response drift, and two false alarms worth knowing about

The detector compares live responses against committed baselines. Getting it
quiet enough to be worth reading took two fixes:

1. **Count containers, not responses.** `clips[].display_tags` exists on some
   clips. Counting presence per response made it look mandatory, because every
   sampled page held at least one clip that had it. A later page of five newer
   clips without it then read as "Suno removed the field". Presence is now
   counted per clip.

2. **An empty array proves nothing.** When `tags: []` comes back, no `tags[]`
   container exists, so every path beneath it is absent. Without a container
   count that reads as a mass deletion.

Baselines need at least 5 samples per container before a field counts as
required. Re-record after any verified client change:

```
npx tsx scripts/record-baselines.ts
```

## What the tests can and cannot catch

The unit suite pins **our** side of the contract. It would not have caught the
August `title` change, because Suno changed and we did not. What it does catch is
us breaking ourselves, which is at least as common and free to detect.

Only the canary sees Suno move. Run it daily.
