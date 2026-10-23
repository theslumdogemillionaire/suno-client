# What works, what does not, and what it cost to find out

Last verified live on a paid account **2026-08-17**, and on a Free account
**2026-08-18**.

Suno has no official API. Everything here talks to the private web API with a
browser session, which is outside Suno's terms of service. A ban lands on a paid
account that presumably holds the commercial rights to your tracks. Decide that
is acceptable before building on this.

## Account tiers

Everything below was measured on a Free account on 2026-08-18, against the same
client that had only ever been run on a subscription. Three assumptions broke.

| Assumption | Free reality |
| --- | --- |
| Billing carries a `plan` object | **Absent.** `plans` is the purchasable catalogue, not your plan. `subscription_type: false`, `is_active: false`. |
| `DEFAULT_MODEL` (v5.5, `chirp-fenix`) is usable | `can_use: false`. Only `chirp-auk-turbo` (v4.5-all) is usable, flagged `is_default_model` **and** `is_default_free_model`. |
| A 403 means the session is dead | It means the plan says no. A dead session is a 401. |

What that cost before the fix: requiring `plan` made `billing()`, `credits()`
and `models()` all throw `response_invalid` on every Free account, and a create
on the default model came back `403 {"error_type":"permission_denied","detail":
"You don't have access to this model. Upgrade your plan to use it."}` reported
as `auth_dead` - which sends the owner off to re-export a cookie that was fine.

The client now reads the tier rather than assuming it (`suno.account()`,
`api/account.ts`), resolves the create model from `models[].can_use`, and
classifies 403 as `plan_required`.

| Capability | Free | Paid |
| --- | --- | --- |
| Billing, credits, models | yes | yes |
| Feed, search, pagination, clip info | yes | yes |
| Aligned lyrics, downbeats, key, waveform | yes | yes |
| Lyrics generation (free, no credits) | yes | yes |
| Custom generation (`generate`) | yes, on `chirp-auk-turbo` | yes, on the account default |
| `describe`, `extend`, `concat` | **blocked by the captcha gate**, not by the plan: both answered 422 `token_validation_failed` while `/api/c/check` said `required: true`. Untested on Free | yes |
| Download + ID3 | yes | yes |
| Remaster | submit accepted (`free_remasters_remaining: 0` did not block it). No usable entry in `remaster_model_types`, so it keeps `chirp-flounder` - which works | yes |
| Persona, commercial rights | no (`accessible_features` lists only `tag_upsample`) | per plan |
| Cover | yes, once the model is resolved | yes |
| Stems | **403**, empty body: genuinely plan-gated | yes |
| Captcha gate | `required: false`, version 2 | flickers, see below |

A Free generation measured end to end on 2026-08-18, with no `model` passed:
submitted, `queued` at 3s, `streaming` at 10s, both clips `complete` at 173s,
two MP3s on disk. Credits: 10 of the 60 available, replenishing 100 per 300s per
`credit_rate_limit`.

Known limitation: the bundled drift baselines were recorded on a subscription,
so a Free account sees `warn`-severity findings on `billing.info` for the
tier-shaped difference (`plan.*` absent, `plans` present). They are accurate, not
noise, and they are no longer `error`-severity: `plan.name` was removed from the
consumed paths for that endpoint precisely because it is not universal.

## Verified working

| Capability | Method | Notes |
| --- | --- | --- |
| Session from cookie | `suno.login(cookie)` | Clerk `__client` cookie, ~7 days |
| JWT auto-refresh | automatic | Refreshes with under 30 min left, single-flighted |
| Credits and plan | `suno.credits()` | Returns `tier` too; works with no plan object |
| Account tier and features | `suno.account()`, `suno.can(feature)` | One cached billing lookup |
| Model list | `suno.models()` | 9 on a subscription, 6 on Free with 1 usable |
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
| Any clip by id | `suno.info()` | Signed out too, since 0.6.0 |
| Liked clips | `suno.list({ liked: true })`, `suno.iterate({ liked: true })` | Same cursor paging |
| Like and unlike | `suno.like()`, `suno.unlike()` | |
| Public profile | `suno.profile()`, `suno.profileClips()` | No session needed |
| Follow, unfollow, follow lists | `suno.follow()`, `suno.unfollow()`, `suno.following()`, `suno.followers()` | The lists need a session |
| Own playlists | `suno.myPlaylists()`, `suno.createPlaylist()`, `suno.addToPlaylist()`, `suno.removeFromPlaylist()`, `suno.updatePlaylist()`, `suno.trashPlaylist()` | `restorePlaylist()` is unverified |
| Public search | `suno.searchPublic()` | About 200 results deep at most |

A generation measured end to end on 2026-08-17: submitted, `queued` at 4s,
`streaming` at 22s, both clips `complete` at 145s, two MP3s on disk at ~185 kbps
with synced lyrics in the tags.

## Fixed by watching the real web app

**`extend` works.** It returned HTTP 400 `Inconsistent task and generation
params` here and still does in the Rust reference client. The cause was not
`continued_aligned_prompt`, which the web app sends as `null` on a successful
extend. It was a top-level **`task: "extend"`** field that no reverse-engineering
write-up mentions: without it the body names `continue_clip_id` while the task
says plain generation, and the server refuses to reconcile the two. Captured by
driving suno.com in an instrumented browser and reading its own POST, then
verified live: two clips, both complete.

The same capture also showed `metadata.is_remix: true`, `metadata.lyrics_updated`,
and that the web app DOES send `token_provider: null`. The reference client's
claim that the field must be omitted is half right: it 422s on a string, and is
fine as null.

## Known broken

**`stems`** submits fine and Suno renders both stem clips, but the response is
not a clip object. `requestStems` therefore returns the raw payload plus any
clips it could parse. The stems appear in the feed within a minute as
`<title> - Vocals` and `<title> - Instrumental` and download normally.

## What the generate body actually requires (probed 2026-09-10)

A traffic capture of the web app suggested several new create fields, one of
them apparently required. Probing the endpoint directly says otherwise, and the
difference is worth stating plainly: **a capture records what a client sent, not
what the server demands.** Every finding below is a 422 read back from
`POST /api/generate/v2-web/`, and none of them cost a credit — a body that fails
validation never generates. Keeping one deliberately invalid field (`mv` as an
integer) in each probe guarantees that.

`{}` returns exactly one complaint:

```
[{'type': 'missing', 'loc': ['body', 'params', 'prompt'], 'msg': 'Field required'}]
```

**`prompt` is the only required field.** Everything else the web app sends is
optional as far as the server is concerned.

- **`metadata.control_sliders.aug_creativity` is NOT required.** It appears on
  every web-app create and on every v6 clip in a feed, which reads exactly like
  a new mandatory field. A slider object with it and one without produce
  identical validation. It is supported as `augCreativity` and sent only when
  set.
- **`token_provider` is an integer**, confirmed: a string returns
  `int_parsing`, an integer passes. The client still omits it entirely, which
  remains correct — the capture showing `integer|null` is consistent with that.
- **`title` must still be a string.** `null` returns
  `string_type` on `body.params.title`, unchanged since 2026-08-01.
- `task: "agentic_thinking"`, `gpt_description_prompt`, `duration`,
  `lyrics_project_id`, `metadata.create_surface`, `metadata.lyrics_model` and
  `metadata.create_mode: "simple"` were all in the capture and none are
  required. `gpt_description_prompt` and `duration` the client already sends
  where they belong; the rest are unused and stay that way until something
  actually needs them. `extraFields` exists for exactly this case, and a
  `metadata` object in it is merged into the generated one key by key (until
  0.5.0 it replaced it, dropping `create_mode` and the session token).

Separately, and worth knowing before trusting `DEFAULT_MODEL`: the Pro account
measured lists `chirp-hawk`, `chirp-hawk-wild` and `chirp-goose` as usable, with
`chirp-hawk` as its default. `chirp-fenix` — the constant — is not among them,
so on that account the fallback would 403. It is not bumped, because choosing a
constant from one account is what put the wrong one there originally.
`pickDefaultModel()` reads the real answer from billing on every create.

## Downloads became metered, and `audio_url` became a trap (2026-09-10)

Suno moved audio delivery off `audio_url` and put it behind a per-clip unlock
that costs one of a small monthly allowance. Three things changed at once, and
each one alone would be survivable; together they break every client that
assumed a finished clip is a downloadable clip.

**`audio_url` now holds a sentinel.** Every clip returns
`https://studio-api.prod.suno.com/api/forbidden`, which answers 403. This is
retroactive: clips generated in August, already downloaded successfully at the
time, carry it too. Measured across a 50-clip feed page — 50 of 50, all
`complete`, no exceptions.

The sentinel is a non-empty string, and that is the whole problem. Every
`Boolean(clip.audio_url)` and `url !== ''` guard written before this date still
passes, on every clip, so the failure moves from a clean "not ready yet" to a
403 at fetch time with nothing explaining it. Use `isFetchableUrl` rather than
truthiness.

**`media_urls` is not the replacement.** It looks exactly like one: public,
unauthenticated, HTTP 200, `content-type: audio/mp4`, plausible file size, one
entry per clip (`m4a-opus` / `progressive` / `1.0.0` on all 50). The payload is
encrypted. It measures 7.997 bits per byte from first block to last and
contains no `ftyp`, no `moov`, no container magic anywhere; ffmpeg rejects it
with "moov atom not found". Fetched on its own it is useless.

It is how suno.com's player gets its sound, though: the player fetches it and
asks `POST /api/mango/rights` for the keys (API.md §3.16). `playTrack()` does
the same and returns the decrypted stream. Measured on 2026-10-13: it spends no
download (`download_usage` unchanged), and `/rights` is not an access check —
asked anonymously, it handed over the keys for one of the account's private
clips. Asked with the session, it answers without the `glt` the unwrap needs,
so the client never sends one there. It stays out of `downloadClip`'s
default path for the reason above: a rights failure must never be able to
look like a finished file.

Worth knowing that the CloudFront objects carry a `Last-Modified` minutes old
and an `x-amz-expiration` about a month out — the library is being re-encoded
continuously, so an object that worked once is not evidence about the next one.

**Playable audio comes from `GET /api/download/clip/{id}?format=mp3`**, which
returns `{ok, status, download_url}` with a presigned S3 URL, or
`{ok: false, reason: "not_authorized"}` if the clip has not been unlocked.
`format` accepts `mp3` (returned ready), and `wav`, `m4a`, `mp4` (answer
`{status: "processing"}` and need polling). `flac`, `ogg` and `opus` are
rejected as `invalid_format`. The mp3 is genuine: 44.8 s, 48 kHz stereo, cover
art embedded as an APIC frame.

**The unlock is what costs.** `POST /api/download/authorize`
`{item_id, item_type: "clip"}` spends one download; `billing/info` reports the
allowance under `download_usage`, and on a Pro plan it read
`current_period_downloads_limit: 20` with `additional_download_remaining: 7`.
Twenty per period is the number that matters for anything that downloads on a
schedule — a bot that materialises every generated track exhausts it in a
sitting. Unlocking is permanent per clip (`is_download_unlocked`,
`download_unlocked_at`) and re-fetching an unlocked clip is free.

Two measurements worth not repeating: a plain `GET` on a **locked** clip returns
`not_authorized` and deducts nothing — verified against `download_usage` before
and after — so a client can detect-and-skip without spending anything. And
`downloadClip` deliberately does not fall back from `audio_url` to
`media_urls`, because that fallback trades a clear error for a corrupt file.

`downloadClip` now uses this endpoint automatically when `audio_url` is the
sentinel, so a clip whose download is already unlocked just downloads —
verified on two of them, and the download counter did not move. What it will
never do on its own is call `authorize`: `authorizeDownload()` is exported and
nothing in the library calls it, because spending a metered download has to be
somebody's decision rather than something a retry loop can reach.

## Likes, follows, playlists and public search (measured 2026-10-23)

Everything in this section was exercised live on 2026-10-23, the writes included. A
like was checked through the liked feed and a follow through the profile's
`is_following`; the playlist writes, by what they answered. Wire details are
in [API.md](API.md) §3.17 to §3.25. Four things in it are worth knowing before building
on it.

**`GET /api/clip/{id}` is not an access check either.** Asked anonymously, it returned
the account's own private clip in full, `media_urls` included, the same finding as
`/api/mango/rights`. It is what makes `suno.info(id)` and `suno.playTrack(id)` work signed
out. Signed in, the client still reads the account's own clips from `/api/feed/?ids=` and
only falls back to this route when that has nothing.

**Creating a playlist validates nothing.** `POST /api/playlist/create/` accepts any body,
`{}` included, and creates a playlist called "Untitled". `createPlaylist()` refuses an
empty name before sending. Create, add and remove are never retried: a replay after a
slow success would create a second playlist, add the clips twice, or remove by a
position that has since moved.

**Removing from a playlist goes by position.** Without `indexes` the route answers 400
`remove_indexes_invalid`, and the index is the playlist's own `relative_index`, which
can be fractional. `suno.removeFromPlaylist(playlist, clipIds)` reads the playlist with
the session first to find them. The lower-level `removePlaylistClips()` takes the
`entries` of a `Playlist` and refuses one without an index rather than guess.

**Public search is a window, not an index you can walk.** `size` goes up to 1000 and
returns about 780 to 790 songs; `from_index` beyond roughly 200 returns nothing, so
`totalHits` (thousands) is not reachable by paging. It is also not `suno.search()`,
which filters the account's own library.

Two smaller traps: the liked filter is `{"liked": "True"}`, a capitalised string like
`trashed`, and the `{"liked": {"presence": "True"}}` form the `stem` filter suggests is
accepted and ignored, returning the whole library. And the follow lists answer 401
anonymously while the profile they belong to reads fine without a session.

Not verified: that `undo_trash: true` restores a trashed playlist (`restorePlaylist()`
sends it), and whether an anonymous read can see a private playlist. The client reads
the account's own playlists with the session wherever it needs their contents.

## The captcha gate does block creates (measured 2026-08-18)

`POST /api/c/check` returns `{required: false}` for accounts above Suno's trust
threshold and `true` for the rest.

This flag went `false -> true -> false` on 2026-08-17 within about forty minutes,
with no manual intervention. An earlier version of this document claimed the
probe had durably tripped it and that clearing it needed a song generated by
hand. That was wrong on both counts, and it was inference from timing rather
than measurement: the account holder confirmed no captcha was ever shown in the
web UI, and generation worked normally once the flag went back to `false`.

What is actually known:

- The flag flickers on its own. `captcha_version` also changed 1 to 2 during the
  same session, which suggests a server-side rollout rather than anything the
  client did.
- `required: true` **does** block creates. Measured on the Free account on
  2026-08-18, which is the case the earlier note left open: the flag flipped to
  true mid-session and the identical custom-generate body that had produced two
  finished clips forty minutes earlier began answering `HTTP 422
  {"error_type": "token_validation_failed", "detail": "We couldn't verify your
  request. Please refresh the page and try again."}`. `describe` and `extend`
  answered the same. Credits did not move: 30 before, 30 after, so a gated
  create is refused before it is charged.
- What tripped it is not established. The session had run four creates
  (generate, cover, remaster, plus a smoke generate) inside about thirty
  minutes on a Free account, which is the obvious suspect and remains a guess.
  Worth knowing if you point a bot at a Free account.
- How to clear it is still not established either. The one observation on the
  paid account was that it cleared itself within about forty minutes with no
  manual intervention.
- `preflightCaptcha` still defaults to **off**, now for a narrower reason: a
  gated create costs nothing and reports `captcha_required` with an actionable
  message, so the preflight saves a round trip rather than credits - and a flag
  that flickers would stall a bot on a false positive. Turn it on if you would
  rather fail fast.
- Getting there costs one JWT refresh and one replay: the gated body carries
  only the structured `token_validation_failed`, and the client tells it apart
  from a stale JWT by outcome. Until 0.5.0 it matched only the spaced
  `Token validation failed`, so the measured body above slipped past and
  surfaced as a plain `api_error`. A side effect: a schema probe now sends two
  rejected creates per run, not one.

To be careful anyway: the probe defaults to **one** variant per run, spaced 15s, rotated
daily by `variantForDay()`. Do not run `--all-variants` on a schedule, and never
put the probe in a health check or a loop.

The probe still works while gated, which is the case that could have made it
useless. Verified 2026-08-17 on this now-gated account: a `title: null` body
still returns `body.params.title` rather than the gate error, so schema
validation genuinely runs first in both states and the canary cannot go
permanently green while blind.

## Endpoints no other client exposes

Captured from the web app on 2026-08-17. None of them appear in the
reverse-engineering notes the existing clients copy from each other, and for a
live overlay they are the interesting half of the API.

| Endpoint | What it gives you |
| --- | --- |
| `GET /api/gen/{id}/downbeats` | Beat grid: `[seconds, beatInBar]`. Bar lines are where beatInBar is 1. Sync visuals to these, not to a fixed BPM: Suno's tempo drifts. |
| `GET /api/gen/{id}/key` | Detected musical key. `state: "running"` while analysing. |
| `GET /api/gen/{id}/waveform-aggregates` | Pre-computed waveform at 11 mip-map levels. Draw a scrubber without downloading and decoding the MP3. |
| `GET /api/clip/{id}/stems/pages` | How many pages of separated stems exist. |
| `POST /api/mango/rights` | Playback keys for `media_urls`. Anonymous on purpose: with a session the answer lacks `glt`. `playTrack()` uses it. |

`suno.track(clipId)` rolls the useful ones into one call: title, style, lyrics,
cover art URL, duration, word-level timings, LRC, bar lines, BPM and key.

## Looking like a browser

Measured rather than assumed, by reading the web app's own outgoing headers.

Its code sets exactly four on a studio-api call: `accept-language`,
`authorization`, `browser-token`, `device-id`, plus `content-type` on a POST.
Everything else (`origin`, `referer`, `user-agent`, the `sec-*` family) is added
by the browser, so a Node client has to supply them by hand.

Two things this client does that a naive port does not:

- **No `accept: application/json`.** The web app does not send it. Sending it is
  a tell, not good manners.
- **`device-id` is a stable random UUID per installation.** The obvious fallback,
  an all-zeros UUID, is the single most identifiable value available: every
  deployment sharing one visibly synthetic id.

What this does **not** do, and cannot from Node: match Chrome's TLS handshake or
HTTP/2 SETTINGS frames. JA3/JA4 fingerprinting sees straight through it. The
header layer is browser-shaped; the transport layer is Node and looks like Node.
If you need more than that, the request has to leave from a real browser or from
something like curl-impersonate.

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

3. **A field that holds what we read is never optional.** A renamed `clips`
   left every consumed path below it absent, which point 2 skips, and `clips`
   itself sat under the sample minimum. The detector reported three `info`
   lines while the schema defaulted the array to `[]` and the library looked
   empty. Such a field now counts as required whenever every sample had it,
   and its absence is an `error`.

Baselines need at least 5 samples per container before a field counts as
required, and the recorder refuses to write one below that rather than ship a
baseline that cannot see removals. Re-record after any verified client change,
then compile the result into the module the client actually loads:

```
npx tsx scripts/record-baselines.ts
npm run gen:baselines
```

## What the tests can and cannot catch

The unit suite pins **our** side of the contract. It would not have caught the
August `title` change, because Suno changed and we did not. What it does catch is
us breaking ourselves, which is at least as common and free to detect.

Only the canary sees Suno move. Run it daily.

## Releasing

Publishing happens from CI only, via npm Trusted Publishing. There is no token
in a secret, in a `~/.npmrc`, or in a shell history, and nothing to rotate.

```
git tag v0.2.0 && git push origin v0.2.0
```

Two things that cost a cycle each when this was set up:

- **Node 24 in the release workflow, not 22.** Trusted publishing needs npm
  >= 11.5.1 and Node 22 still ships npm 10.9.8.
- **No committed `.npmrc`.** An earlier version shipped one pointing at an
  env-var token, and project config outranks both the user `~/.npmrc` that
  `setup-node` writes and an interactive `npm login`. It produced an
  authentication failure with nothing visibly misconfigured, twice.

The first publish of a brand-new package name is the exception: a trusted
publisher can only be configured on a package that exists, so v0.1.0 has to be
claimed once by hand with an interactive `npm login` (which handles 2FA), from a
directory with no project `.npmrc`. Every release after that goes through CI.
