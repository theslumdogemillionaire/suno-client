# Changelog

## Unreleased

The social and library half of the web app: likes, follows, public profiles, the
account's own playlists, and search across everyone's songs. Every route was
exercised live on 2026-10-23, writes included; a like and a follow were also checked
from the other side, through the liked feed and through `is_following`. Wire
details are in `docs/API.md` §3.17 to §3.25; what they cost to learn is in
`docs/STATUS.md`.

### Added

- **Likes.** `suno.like(id)` and `suno.unlike(id)`, over
  `POST /api/gen/{id}/update_reaction_type/` (`setReaction()`). They return the
  clip's reaction state; `reaction_type` is `"L"` after a like and absent after an
  unlike.
- **Liked clips.** `liked: true` on `list()` / `iterate()` (and `listClips()` /
  `iterateClips()`) sends `filters: {"liked": "True", "trashed": "False"}` and pages
  by cursor like the rest of the feed. The object form `{"presence": "True"}` that
  `stem` takes is accepted by Suno and ignored, which returns the whole library.
- **Public profiles, no session needed.** `suno.profile(handle)` reads one page
  (`getProfile()`), and `suno.profileClips(handle)` walks every public clip once:
  pinned clips repeat further down, so it deduplicates by id and stops on an empty
  or short page rather than trusting `num_total_clips`. Signed in, the session is
  sent so `is_following` is about this account.
- **Follows.** `suno.follow(handle)`, `suno.unfollow(handle)`, and the lists
  `suno.following(handle)` and `suno.followers(handle)` (`listFollowing()`,
  `listFollowers()` for one page). The lists need a session: anonymous, Suno
  answers 401.
- **One clip by id, anyone's.** `getClip()` reads `GET /api/clip/{id}`, which
  needs no session and answers with `media_urls`. Measured: anonymously it also
  returned the account's own private clip.
- **The account's playlists.** `suno.myPlaylists()` (`listMyPlaylists()`,
  `iterateMyPlaylists()`), `suno.createPlaylist(name)`,
  `suno.addToPlaylist(playlist, clipIds)`, `suno.removeFromPlaylist(playlist,
  clipIds)`, `suno.updatePlaylist(playlist, { name, description })`,
  `suno.trashPlaylist(playlist)` and `suno.restorePlaylist(playlist)`. Create
  validates the name here, because the server accepts any body and makes an
  "Untitled" playlist; create, add and remove are never retried. Removing needs
  each clip's position, so `removeFromPlaylist` reads the playlist with the session
  first. `restorePlaylist` sends `undo_trash: true` and is unverified.
- **Public search.** `suno.searchPublic(term, { size, fromIndex, rankBy })` is
  suno.com's search box over everyone's public songs (`POST /api/search`), and
  returns `{ clips, totalHits, fromIndex, pageSize }`. Not `search()`, which
  filters the account's own library. `size` goes to 1000; `fromIndex` past about
  200 returns nothing.
- **CLI.** `liked [n]`, and `profile <handle>`, which needs no login.
- **Drift.** Consumed paths are registered for the new reads (`clip.get`,
  `profile.*`, `playlist.mine`, `search.public`). No baselines ship for them yet,
  as for `playlist.get`, so they report nothing until some are recorded.

### Changed (read before upgrading)

- **`suno.info(id)` falls back to the public clip route.** It still reads
  `/api/feed/?ids=` first when a session is stored, so the account's own clips,
  rendering ones included, read exactly as before. When that finds nothing (an
  empty answer or a 404), or no session is stored at all, it now asks
  `GET /api/clip/{id}` instead of failing: a clip from another creator used to be
  `not_found` signed in and `auth_missing` signed out. An id neither route knows is
  still `not_found`, now from the second route. `suno.track()`, the CLI `info`, and
  `suno.playTrack(id)` all go through it, so **`playTrack(id)` works signed out**.
  `suno.get()` and `suno.job()` are unchanged: feed-by-ids stays the polling
  primitive.
- **`Playlist` gains `entries`**, the same clips in the same order, each with the
  `relativeIndex` Suno sent (fractional ones included, `undefined` when none was
  sent; the old fallback position is never handed out as an index). `clips` is
  unchanged.
- **`getPlaylist()` takes `signedIn`**, to read with the session. Off by default,
  so a shared playlist still reads anonymously; whether an anonymous read can see a
  private playlist is unverified.
- **Seven more route-level paths.** An HTML 404 on `/api/search`,
  `/api/profiles/follow`, `/api/playlist/me` or one of the four playlist writes is
  `route_gone`, with `alert`. A JSON 404 there, an unknown playlist or handle, stays
  `not_found`.

## 0.5.0 (2026-10-13)

A full review of the client, and the fixes it called for. Several touch money:
a cancelled create could still be sent and billed, and a stem separation could
be started four times. Every scenario below was reproduced before the fix and
replayed after it.

### Changed (read before upgrading)

- **Node 22.13 or later.** `login --from-browser` reads the cookie database
  through `node:sqlite`, which older 22.x lines only expose behind
  `--experimental-sqlite`. On those it failed with "No such built-in module" on
  every profile; `engines` now says so, and the error names the version.
- **Bulk downloads stop on what needs a human.** `downloadAll`,
  `downloadPlaylist` and `downloadClips` still record a refusal about one clip
  in `failed`, now with its `code`, but a cancel or an alert-class error (dead
  session, moved route, changed response) throws instead of being repeated for
  every remaining clip as a message string.
- **CLI exit codes.** `download` and `generate --download` exit 1 when any clip
  failed (they printed the failures and exited 0), and 2 on an alert-class error.
- **Ids are refused or encoded.** An empty id, `.` or `..` is `invalid_input`;
  every other clip and persona id is percent-encoded into its URL path.
- **A captcha-gated create costs one JWT refresh and one replay** before it
  reports `captcha_required`, which is the documented design that never ran
  (see Fixed). The daily schema probe therefore sends two rejected creates per
  run instead of one.

### Fixed

- **A cancelled create is no longer sent.** `request()` never checked
  `signal.aborted`, and an `abort` listener added to a signal that already fired
  never runs, so a create cancelled before it went out - or during the model
  lookup, whose failure `modelFor` swallowed - was submitted and billed. Aborts
  are never retryable now, whatever their reason, and every abortable wait
  (`job.wait()`, lyrics, download polling) rejects with a `SunoError` instead of
  a bare `DOMException` whose numeric `code` read as 20.
- **`timeoutMs` covers the whole attempt.** The timer was cleared once headers
  arrived, so a stalled body - and every Clerk call, which had no timeout at
  all - waited on undici's 300 s defaults or forever. A connection reset mid-body
  is now a retryable transport error rather than `response_invalid`.
- **`captcha_required` fires on the body Suno actually sends.** The measured
  gate answers `422 {"error_type": "token_validation_failed", ...}`; the client
  only matched the spaced `Token validation failed`, so a gated account got a
  plain `api_error`, no alert, and a bot never paused.
- **`suno.job(ids)` waits on every id it was given.** It kept only the clips the
  feed returned, so after a restart a clip still rendering was dropped, and an
  empty answer made `wait()` resolve at once with nothing.
- **Clip ids can no longer reach other endpoints.** Interpolated unencoded,
  `suno.waveform('../billing/info/#')` was an authenticated read of the
  account's billing, returned whole through the passthrough schema.
- **A malformed create response is a `SunoError`.** `validateSubmission` threw a
  raw `ZodError` after a create Suno had accepted and charged; it is now
  `response_invalid` with `alert`, and its body keeps the clip ids.
- **Stem separation is never retried.** It inherited three retries, so a slow
  answer or a 502 after Suno accepted the job started up to four separations.
- **A refresh can no longer undo a logout or a login.** One still in flight
  wrote the old session back to memory and to disk once Clerk answered.
- **One Clerk exchange for a burst of 401s.** A late 401 cleared the token a
  concurrent request had just minted (ten requests, four exchanges), and any
  refresh failure, Clerk's own 429 included, fell through to a full exchange.
- **The account cache follows the session.** `login()` and `logout()` now drop
  it (the old account's default model was sent with the new session, a 403 on
  every create), and one caller's cancel no longer fails the shared lookup for
  the others.
- **`extraFields.metadata` is merged, not swapped in.** Adding one metadata
  field dropped `create_mode`, so a describe was billed as a custom create.
- **File names fit the filesystem.** The slug was capped in UTF-16 units, not
  bytes: an 80-character CJK title failed every download with `ENAMETOOLONG`.
  Each download also writes its own scratch file, so two downloads of one clip
  no longer delete each other's.
- **The device id is persisted.** A bare-cookie login stored none, so every
  process sent a fresh random one; it now keeps the stored id or saves its own.
- **No more 403 sentinel handed out as a URL.** `track().audioUrl` and
  `generate --wait` showed `audio_url`, which is `/api/forbidden` on every clip.
- **Playlists are read whole.** Paging stopped after page 1 when Suno omitted
  the total and silently at 20 pages otherwise; a clip with an explicit `null`
  field was dropped.
- **LRC timestamps.** 59.999 s rendered as `[00:60.00]`; it is `[01:00.00]`.
- **Drift detection sees a renamed array.** Renaming `clips` produced three
  `info` lines while the library parsed as empty; a field that holds consumed
  paths now counts as required and its absence is an `error`. Baseline folding
  no longer depends on sample order, and `record-baselines` refuses to write an
  endpoint below the 5-sample minimum (feed.v3 shipped with 4).
- **CLI.** `login`, `logout` and `session` act on the stored session even with
  `SUNO_COOKIE` set: `login` stored nothing, and `logout` said "session cleared"
  and left the file. A malformed `SUNO_COOKIE` fails only what needs a session,
  with a message that names it, instead of every command including `help`.
  `login --from-browser` no longer claims a different account "matches the
  session already stored", and says when it replaces one. `--source` is
  honoured after `generate --download`.
- **The example queue keeps the request that triggered a pause** and runs it
  first on `resume()`, unless the create had already gone out.
- **Docker.** A `.dockerignore` keeps the host's darwin `node_modules`, a stale
  `dist/` and `.env` out of the build context.
- **Docs.** The README's CLI path (`dist/esm/cli.js`), the cookie lifetime
  (a year, not a week) and its host (`auth.suno.com`) in `.env.example`.
- **`npm publish` no longer warns about the `bin` entry.** The release job
  logged `"bin[suno-client]" script name dist/esm/cli.js was invalid and
  removed`. Despite the wording, nothing was removed: npm 11 only strips the
  leading `./` from `"./dist/esm/cli.js"`, a prefix there since 0.1.0, and
  keeps the entry. `bin` now holds the bare `dist/esm/cli.js`, so nothing is
  left to correct. The published 0.4.0 tarball, the registry metadata of every
  release, and `npx suno-client --help` after a registry install were checked
  on 2026-10-13: the command was always there.

## 0.4.0 (2026-10-13)

Playback without the download allowance: `playTrack()` streams a clip the way
suno.com's player does, and public playlists can be read and saved without a
session. The playback path was measured on a live Pro account before release —
see `docs/API.md` §3.16, which records what `/api/mango/rights` actually checks
(less than expected) and why the client never sends it a session.

### Added

- **`suno.playTrack(idOrClip)`**, playback the way suno.com's player does it:
  the encrypted `media_urls` file and `POST /api/mango/rights` in parallel,
  decrypted as it streams. Returns `{ stream, contentType, contentLength, ext }`.
  Verified live on 2026-10-13 against a private and a public clip: full files,
  byte counts equal to the CDN's `Content-Length`, and no download spent from
  the allowance. The rights call is anonymous on purpose: with a session Suno
  answers without the `glt` the unwrap needs. The decrypted header is checked
  before the stream is returned, and destroying the stream cancels the CDN
  download.
- `playback_denied`, a new error code for a 401/403 from `/rights`, kept apart
  from `plan_required`. Never observed so far.
- `downloadClip(..., { source: 'playback' })` writes the same stream to disk,
  and `download <id...> --source playback` does the same from the CLI.
- **Public playlists, no session needed.** `suno.playlist(urlOrId)` and the CLI
  `playlist <url|id>` read a share link the way suno.com does for anyone who
  opens it: `GET /api/playlist/{id}?page=N`, clips under
  `playlist_clips[].clip`, ordered by `relative_index`.
  `suno.downloadPlaylist()` and `download --playlist <url|id> --out DIR` write
  every track, through `playback` by default so the allowance is not touched;
  pass `source: 'download'` for the metered path.

### Fixed

- **`login --from-browser` no longer gives up on the first browser macOS
  refuses.** Listing Brave's profile folder failed with `EPERM` and aborted the
  whole search, although the session was sitting in Chrome. Measured on
  2026-10-13. The refusal is now recorded like any other per-browser failure,
  and reported only if no browser yields a session.
- **Concurrent session saves no longer delete each other's scratch file.** The
  sweep that clears temps left by a crashed save could remove one belonging to
  a save still in flight, which then failed with `ENOENT` on chmod — about one
  run in six of the concurrency test. In-flight saves are tracked, and temps
  younger than 60 s are left alone for saves running in another process.

- **A 404 on a route-level path no longer pages a human for a typo.** The path
  alone decided, so `/api/gen/trash` — which takes clip ids in its BODY, and
  answers 404 for one that does not exist — reported an ordinary unknown id as
  `route_gone`, "this endpoint moved, the client needs updating", with `alert`
  set. Measured on 2026-09-10: one fabricated clip id produced exactly that and
  cost an investigation into an endpoint that had never moved. The body decides
  now, and only a JSON body clears the alert: Suno's application layer always
  answers in JSON, so an HTML error page, a bare "Not Found" or anything else
  did not come from the application. The rule is "only JSON is quiet" rather
  than "only HTML is loud", so an unrecognised shape still errs toward waking
  someone.

## 0.3.0 (2026-09-10)

Suno moved audio delivery and metered downloads on the same day, and 0.2.0 had
no way to tell you either had happened. It reported "no audio URL" for clips
that had one, then "unlock this first" for clips already unlocked. Everything
here is measured against a live Pro account - see `docs/STATUS.md`.

### Added

- **Downloads go through `/api/download/clip/{id}`**, which is where Suno now
  serves audio from. `downloadClip()` uses it automatically once `audio_url`
  turns out to be the sentinel, so an unlocked clip simply downloads.
  `resolveDownloadUrl()` and `downloadTicket()` are exported for callers who
  want the URL rather than the file.
- **`authorizeDownload()`**, which spends one of the account's metered
  downloads, and which **nothing in this library calls**. Reading is free on any
  clip and the library reads freely; unlocking is capped at 20 per period on
  Pro, so it only ever happens because somebody decided it should - never
  because a retry loop reached it.
- **`login --from-browser`** lifts the session out of a local Chrome, Brave,
  Edge or Chromium, ending the devtools copy. It searches every profile and says
  which it used. When profiles hold DIFFERENT Clerk accounts it refuses to guess
  and asks, because expiry is not a way to choose between accounts - on the
  machine this was built on, two accounts' cookies expired seven seconds apart.
  It lifts the profile's `ajs_anonymous_id` too, so the device id stays stable
  instead of being regenerated per process.
- **`suno-client session`** reports what state a stored session is in - stored
  or not, JWT expiry, whether the next call refreshes, whether Suno answers -
  without printing the cookie or the token.
- **`download_locked`**, a `SunoErrorCode` for a clip whose download has not
  been unlocked. Neither retryable nor alert: a library of locked clips is the
  normal state now, and 48 of 50 alerting would be noise.
- `media_urls`, `is_download_unlocked` and `download_unlocked_at` are typed on
  `ClipSchema`; `isFetchableUrl()` and `AUDIO_FORBIDDEN_URL` are exported.
- **`sliders.augCreativity`**, v6's creativity dial, sent as
  `control_sliders.aug_creativity` when set and absent when not.

### Fixed

- **`audio_url` is no longer trusted.** It holds a 403 sentinel on every clip in
  a library, retroactively, including clips that downloaded fine weeks earlier.
  It is a non-empty string, so every `Boolean(clip.audio_url)` guard written
  before this still passed on everything and deferred the failure to an
  unexplained 403 mid-download.
- **`media_urls` is never used as a download source.** It answers 200 with
  `audio/mp4` and looks exactly like the replacement; its payload is encrypted
  (7.997 bits per byte, no `ftyp`, no `moov`, ffmpeg refuses it). Falling back
  to it would trade a clear error for a corrupt file.
- **CLI flags no longer eat their own values.** `download <id> --out DIR` kept
  `DIR` in the positional list and asked Suno for it as a clip, which answers
  404 - surfacing as "HTTP 404 on /api/feed/", an endpoint that was working
  fine. `trash`, `restore` and `describe` shared the bug. Separately,
  `list --limit 6` made `Number('--limit')` NaN, which serialises as
  `limit: null`, which Suno 422s, which was reported as `schema_drift` with
  `alert` set - the loudest error in the taxonomy, raised by a typo.
- Drift baselines re-recorded. They were stale enough to bury real signal under
  38 findings.

### Measured

- The `__client` cookie lasts about a **year** (expiry 2027-09-09 on a profile
  signed in that day), not the week 0.2.0 documented. A dead session is
  therefore almost never an expired cookie: it was rotated by signing in
  elsewhere, or never stored. It also lives on `auth.suno.com`, not `suno.com`.
- A plain `GET` on a **locked** clip returns `not_authorized` and deducts
  nothing, verified against `download_usage` before and after. Detect-and-skip
  over a library is free.
- `format` accepts `mp3` (ready immediately on an unlocked clip), and `wav`,
  `m4a`, `mp4` (which answer `processing` and need polling). `flac`, `ogg` and
  `opus` are refused.
- **`prompt` is the only field `generate` requires.** A traffic capture of the
  web app suggested `control_sliders.aug_creativity` had become mandatory; it
  has not - a body with the sliders and without it validates identically. A
  capture records what a client sent, never what a server demands, and reading
  it as a contract would have added a field to every create on no evidence.
  `token_provider` is confirmed an integer and still omitted; `title` must still
  be a string. Probed with a deliberately invalid `mv` in every body, so nothing
  generated and no credits were spent.
- `DEFAULT_MODEL` (`chirp-fenix`, v5.5) is **not usable** on the Pro account
  measured, which offers only v6 keys and defaults to `chirp-hawk`. Left alone
  on purpose: picking a constant from one account is the mistake that put the
  wrong one there. `pickDefaultModel()` reads billing on every create, so this
  only bites when that lookup fails.

## 0.2.0 (2026-08-18)

Every tier assumption in 0.1.0 came from the one account it had ever been run
against. Run against a Free account, three of them were wrong, and the failures
compounded: billing threw, so model resolution had nothing to read, so every
create used a model the account could not use, and the resulting 403 told the
owner their session was dead. All of it is measured, not inferred - see the
tier matrix in `docs/STATUS.md`.

### Added

- **`suno.account()`** - tier, plan, credits, unlocked features, usable models
  and the model a create will actually use, from one billing lookup cached per
  client. `suno.can(feature)` for a single feature, `suno-client account` on the
  CLI, `describeAccount()` / `pickDefaultModel()` / `pickRemasterModel()` for
  anyone reading a billing payload directly.
- **`plan_required`**, a `SunoErrorCode` for an HTTP 403. Not retryable, and
  deliberately not an alert: no amount of waiting or re-authenticating fixes a
  plan limit.
- `credits()` now returns `tier` alongside `left`, `plan` and `monthlyLimit`.

### Fixed

- **Billing no longer requires `plan`.** A Free account's payload has no `plan`
  object at all, which made `billing()`, `credits()` and `models()` throw
  `response_invalid` on every call. Only `total_credits_left` is required now.
- **Creates resolve a usable model.** `DEFAULT_MODEL` is v5.5, which reports
  `can_use: false` on Free, so every default `generate()`, `describe()`,
  `cover()` and `extend()` came back 403 `You don't have access to this model`.
  A create with no explicit `model` now picks one the account may use, falling
  back to `DEFAULT_MODEL` when billing is unreadable rather than adding a new
  way to fail. Opt out with `new Suno({ resolveModel: false })`.
- **An HTTP 403 is no longer reported as `auth_dead`.** A dead session is a 401,
  which the client already refreshes and replays; a 403 arrives with a JWT that
  was just minted. The old classification sent Free accounts to re-export a
  perfectly good cookie and paged a human over a plan limit.
- `plan.name` removed from the drift detector's consumed paths for
  `billing.info`, where it was flagging every Free-tier response as an
  `error`-severity break of a field that is simply not universal.
- The Docker image now carries `tsconfig.esm.json` and `tsconfig.cjs.json`, so
  `npm run build` works inside it instead of only on the host.

### Measured

- **A captcha gate does block creates.** `docs/STATUS.md` had this as untested.
  The flag flipped mid-session on the Free account and the identical body that
  had produced two finished clips minutes earlier began answering 422
  `token_validation_failed` - custom, describe and extend alike. Credits did not
  move, so a gated create is refused before it is charged. The error message no
  longer advises generating a song by hand to clear it; nothing established that
  it works.
- Cover is not plan-gated on Free, only its default model was. Stems genuinely
  is: 403 with an empty body, whatever model you name.

## 0.1.0 (2026-08-17)

First release.

### The point of it

- **Free request-schema probe.** Suno validates the request body before the
  request token, so a schema-correct body naming a nonexistent model is rejected
  without creating a generation. Turns "is our create body still valid?" into a
  daily check costing zero credits. Keeps working while an account is
  captcha-gated.
- **Response-shape drift detection.** Zod runs in passthrough so added fields
  never break a parse; every response is separately fingerprinted against a
  baseline compiled into the package. Removal or retype of a field we read is an
  `error`, a new field is `info`.
- **Errors carry `retryable` and `alert`**, so a long-running consumer keeps
  going through transients and stops loudly when a human is needed.

### Endpoints no other unofficial client exposes

Captured by reading suno.com's own traffic: `downbeats` (real beat grid),
`key`, `waveform-aggregates` (11 mip levels), `clip/{id}/stems/pages`.
`suno.track()` rolls the useful ones into one call with title, style, lyrics,
cover art, word timings, bar lines, BPM and key.

### Fixed relative to the Rust reference client it was ported from

- `extend` needed a top-level `task: "extend"`. Without it the server answers
  400 `Inconsistent task and generation params`. The field appears in no
  reverse-engineering write-up, and `continued_aligned_prompt` (the usual
  suspect) is null in the web app's own successful request.
- `title` must be a string. `null` began returning 422 around 2026-08-01 and
  silently broke describe, cover and extend.
- Inspiration mode carries its description in `prompt`, not the retired
  `gpt_description_prompt`.
- Clips are fetched in pairs, because asking for 4+ ids across generation
  batches silently returns only the first two.
- Polling requires every *requested* id to reach a terminal state; an empty feed
  is not "done", and `error` is terminal.

### Known broken upstream

`stems` submits and renders, but its response is not a clip object. See
`docs/STATUS.md`.
