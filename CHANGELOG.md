# Changelog

## 0.1.0 (unreleased)

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
