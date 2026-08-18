# Changelog

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
