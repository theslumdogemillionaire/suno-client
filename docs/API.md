# Suno private web API: wire specification

Authoritative wire spec for a Suno API client. This document is the single source of
truth for the TypeScript port. It describes **HTTP requests and responses only**. CLI
ergonomics of the Rust reference client (output envelopes, ID3 tagging, LRC formatting,
filename slugs, confirmation prompts) are deliberately excluded; where a reference-client
behaviour is quoted it is labelled as such.

There is no official public Suno API. Everything here is the reverse-engineered web-app
API, authenticated with a Clerk browser session. Using it is outside Suno's terms of
service, and a ban lands on a paid account.

## Provenance and confidence legend

Every endpoint carries a confidence marker. Do not treat them as equal.

| Marker | Meaning |
| --- | --- |
| `LIVE 2026-08-17` | Exercised today against a real paid account. Overrides everything else. |
| `LIVE 2026-07-20` | Route and body verified live on that date (trash). |
| `LIVE 2026-07-18` | Response shape verified live on that date (captcha preflight). |
| `CAPTURED 2026-04-07` | Schema captured from a real Suno web-app request. Not re-verified since. |
| `INFERRED` | Implemented in the reference client from third-party evidence, never captured. |
| `BROKEN` | Live-tested today and it failed. The correct shape is unknown. |
| `LIVE 2026-10-13` | Exercised against a real Pro account (playback keys, 3.16). |
| `LIVE 2026-10-23` | Exercised against a real account (public reads, likes, follows, playlists, search: 3.17 to 3.25). |

Three inputs were reconciled to produce this document, in descending authority:

1. Live measurements taken 2026-08-17 against a paid account.
2. The Rust reference client source (`suno-cli` v0.9.0 HEAD, 2026-07-20, plus the
   `title` patch applied).
3. The reference repo's `API_INTELLIGENCE.md`, which is **partly stale**. Every
   divergence between it and the source is listed in section 6.

---

## 0. Serialization conventions (read this first)

Most porting failures come from four rules. Everything in section 6 is downstream of them.

**Rule 1: the create body has no optional keys.** `POST /api/generate/v2-web/` carries
22 top-level keys and every one of them is always on the wire. Unset values are explicit
JSON `null`, not omitted. `JSON.stringify` drops `undefined` keys, and the server's
pydantic validator answers `missing field`. Build the body with literal `null`s.

**Rule 2: `metadata.control_sliders` is the one exception inside that body.** When no
slider is set, the key is **absent** (not `null`), and each of the three slider members
is individually absent when unset. Two opposite conventions inside one payload.

**Rule 3: the other request bodies are omit-when-unset.** `FeedV3Request`,
`FeedFilters`, and `SetMetadataRequest` drop absent keys entirely. In particular, feed
page one omits `cursor`; it is never `null` and never `""`.

**Rule 4: on the response side, a missing key and an explicit `null` are the same
thing.** The reference deserializer treats every nullable field as optional without
needing a default. So on `Clip` only `id`, `title`, `status`, `model_name` and
`created_at` are genuinely required; `metadata` itself may be absent. This document
renders such fields as `T | null` throughout. (Two of the source extractions rendered
them as `field?: T` instead. That is the same serde behaviour written two ways, not a
disagreement about the wire.)

---

## 1. Auth flow

Suno's web app authenticates through Clerk. The client never sees a password. The
long-lived secret is the Clerk `__client` cookie (roughly 7 days), which is exchanged
for a short-lived JWT that the studio API accepts as a bearer token.

### 1.0 Constants

```ts
const CLERK_BASE        = "https://auth.suno.com";
const CLERK_API_VERSION = "2025-11-10";
const CLERK_JS_VERSION  = "5.117.0";
const STUDIO_BASE       = "https://studio-api-prod.suno.com";
```

Both Clerk calls carry the same two query parameters, in this order, spelled
**asymmetrically**:

```
?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0
       ^^ two underscores        ^ one underscore
```

### 1.1 Obtain the `__client` cookie

Out of band. Log into suno.com in a browser and read the `__client` cookie. Two notes
that matter if you automate extraction:

- A `__client` scoped to `auth.suno.com` wins over one from any other `*.suno.com`
  domain, regardless of discovery order. Machines with both often carry a stale one on
  the wider scope.
- The reference client accepts either a full `Cookie:` header string or a bare cookie
  value. Its normalizer: strip a leading `cookie:` prefix (case-insensitive, re-trim);
  if the string parses as a cookie header containing `__client`, use that value; else if
  the string contains `;` or `=` but no `__client`, hard error; else treat the whole
  input as the bare `__client` value.

The full browser `Cookie` header is **never sent to the studio API and never sent to
Clerk**. Its only use in the reference client is seeding a browser profile for the
hCaptcha solver.

### 1.2 Step 1: session id

```
GET https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0
```

No body. No other query parameters. Headers, all lowercase:

| Header | Value |
| --- | --- |
| `authorization` | the **raw** `__client` cookie value, with **no** `Bearer ` prefix |
| `cookie` | `__client=<value>`, synthesized from the value alone |
| `origin` | `https://suno.com` (no trailing slash) |
| `referer` | `https://suno.com/` (trailing slash) |

Response (only these paths are read):

```ts
interface ClerkClientResponse {
  response?: {
    last_active_session_id?: string | null;  // preferred
    sessions?: Array<{ id?: string }>;       // fallback: sessions[0].id
  };
}
```

Resolution order: `response.last_active_session_id`, else `response.sessions[0].id`.
Neither present means no active session; the user must log into suno.com again.

Session ids look like `session_REDACTED`.

### 1.3 Step 2: mint a JWT

```
POST https://auth.suno.com/v1/client/sessions/{session_id}/tokens?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0
```

- **Empty body** (`Content-Length: 0`).
- **But `content-type: application/x-www-form-urlencoded` is still set.**
- Same four headers as step 1 (`authorization` raw, `cookie`, `origin`, `referer`).
- `{session_id}` is interpolated raw, not URL-encoded.

Response:

```ts
interface ClerkTokensResponse {
  jwt?: string;   // TOP LEVEL, not nested under `response`
}
```

Note the envelope asymmetry: the session id is nested under `response`, the JWT is not.

### 1.4 JWT staleness rule

**Refresh any JWT with under 30 minutes of life left.** Do not trust `exp`.

```ts
function isJwtStale(jwt: string | null): boolean {
  if (!jwt) return true;
  const parts = jwt.split(".");
  if (parts.length !== 3) return true;
  let claims: any;
  try {
    // Base64URL, NO padding. Not standard base64.
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return true; }
  const exp = claims?.exp;
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp < 0) return true;
  const now = Math.floor(Date.now() / 1000);
  return now + 1800 >= exp;
}
```

Any failure along the way (missing JWT, wrong segment count, decode failure, JSON parse
failure, missing or non-integer `exp`) returns `true`, meaning "refresh".

Why 1800: Suno issues one-hour JWTs, but the generation endpoint rejects tokens older
than roughly 30 minutes with `Token validation failed.` even while the JWT's own `exp`
claim is still in the future (observed 2026-04-07). The threshold guarantees the API
always receives a freshly minted token.

### 1.5 Refresh branching

Two stored values drive refresh:

- `session_id` present: `POST .../sessions/{session_id}/tokens` directly (section 1.3).
- Only `clerk_client_cookie` present: run the full two-call exchange (1.2 then 1.3) and
  persist the recovered `session_id`.
- Neither: hard auth failure, no network call.

Persist both `session_id` and `jwt` after **every** refresh, including the short path.

### 1.6 Mid-request refresh (single retry)

Wrap every studio-api call:

```ts
async function withAuthRetry<T>(f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) {
    if (!isAuthExpired(e)) throw e;   // ONLY auth-expired triggers a retry
    await refreshJwt();               // its own failure propagates
    return await f();                 // exactly one more attempt
  }
}
```

No backoff. No second retry. Rate limits, 5xx and validation errors are **not** retried.
Read the JWT at request-build time (inside `f`), never capture it in a closure created
before the retry, or the retry replays the stale token.

The retried request is byte-identical to the first apart from the JWT and the
`browser-token` timestamp. In particular `transaction_uuid` and
`metadata.create_session_token` are **not** regenerated on retry, which is presumably
what makes `transaction_uuid` a server-side dedupe key. Do not regenerate them.

### 1.7 Persisted auth state

```ts
interface AuthState {
  jwt: string | null;
  cookie: string | null;               // full browser Cookie header; NOT sent anywhere
  session_id: string | null;           // Clerk session id
  device_id: string | null;            // from cookie `ajs_anonymous_id`, else a UUID v4
  clerk_client_cookie: string | null;  // the bare __client value, ~7 day life
}
```

The reference writes this to `${SUNO_CONFIG_DIR || platformConfigDir}/auth.json`
atomically with mode 0600 (temp file `auth.json.tmp`, fsync, rename). It contains a
long-lived session credential; treat it like a password file.

`device_id` extraction from `ajs_anonymous_id`: replace the literal sequence `%22` with
`"`, then strip surrounding `"` then `'`, then trim. **No general percent-decoding**
(`decodeURIComponent` over-decodes and diverges). Reject the result if it is empty or
contains `;`.

### 1.8 Liveness check

`GET /api/billing/info/` is the canonical "is this JWT good" probe.

---

## 2. Headers required on every studio-api call

Rebuilt per request. All header names lowercase.

| Header | Value | Notes |
| --- | --- | --- |
| `authorization` | `Bearer <jwt>` | Omitted entirely when no JWT is held. Note: **opposite convention from Clerk**, which takes the raw cookie with no `Bearer`. |
| `device-id` | the stored device id, else the literal `00000000-0000-0000-0000-000000000000` | Never omitted, never empty. The all-zero UUID is a real fallback value, not a placeholder. |
| `browser-token` | see below | Regenerated on **every** request. Never cached. |
| `origin` | `https://suno.com` | No trailing slash. |
| `referer` | `https://suno.com/` | Trailing slash. |
| `content-type` | `application/json` | Only on requests that carry a JSON body. |
| `user-agent` | `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36` | Client-level. |

Request timeout in the reference client: 30 s flat for all studio-api calls.

**No `Cookie` header is ever sent to the studio API.**

### `browser-token`

```ts
function browserToken(): string {
  const inner = `{"timestamp":${Date.now()}}`;      // no spaces, integer ms
  const b64   = Buffer.from(inner, "utf8").toString("base64"); // STANDARD, padded
  return `{"token":"${b64}"}`;                       // no spaces
}
```

Two hand-formatted JSON strings, not `JSON.stringify` output. `JSON.stringify` happens
to produce identical bytes for both layers here, but any pretty-printing, key reordering
or whitespace changes the value. Note the base64 alphabet: **standard with padding**,
unlike the JWT claim decoding in 1.4 which is base64url without padding. The two
alphabets in the same client are deliberate.

---

## 3. Endpoints

Base URL for everything in this section unless stated otherwise:
`https://studio-api-prod.suno.com`.

**Trailing slashes are load-bearing and inconsistent.** They are part of the route, not
cosmetic. Do not run paths through a URL normalizer.

| With trailing slash | Without trailing slash |
| --- | --- |
| `/api/billing/info/` | `/api/c/check` |
| `/api/generate/v2-web/` | `/api/feed/v3` |
| `/api/generate/concat/v2/` | `/api/gen/trash` |
| `/api/generate/lyrics/` (submit) | `/api/generate/lyrics/{id}` (poll) |
| `/api/feed/` (the `?ids=` poll) | `/api/edit/stems/{id}` |
| `/api/gen/{id}/set_metadata/` | |
| `/api/gen/{id}/set_visibility/` | |
| `/api/gen/{id}/aligned_lyrics/v2/` | `/api/mango/rights` |
| `/api/persona/get-persona-paginated/{id}/` (slash before the query) | `/api/clip/{id}` |
| `/api/gen/{id}/update_reaction_type/` | `/api/profiles/{handle}` (and `/following`, `/followers`) |
| `/api/playlist/create/` | `/api/profiles/follow` |
| `/api/playlist/update_clips/` | `/api/playlist/{id}`, `/api/playlist/me` |
| `/api/playlist/set_metadata/` | `/api/search` |
| `/api/playlist/trash/` | |

### Shared response types

```ts
interface Clip {
  id: string;                 // required
  title: string;              // required
  status: string;             // required; see section 4
  model_name: string;         // required
  created_at: string;         // required, ISO-8601, treat as opaque
  audio_url: string | null;
  video_url: string | null;
  image_url: string | null;
  play_count: number;         // absent => 0
  upvote_count: number;       // absent => 0
  metadata: ClipMetadata;     // absent => all-defaults object
}

interface ClipMetadata {
  tags: string | null;              // comma-joined STRING, not an array
  prompt: string | null;            // the lyrics
  duration: number | null;          // seconds
  avg_bpm: number | null;
  has_stem: boolean;                // absent => false
  is_remix: boolean;                // absent => false
  make_instrumental: boolean;       // absent => false
  type: string | null;              // wire key is literally "type"
  error_type: string | null;        // only present when status === "error"
  error_message: string | null;     // only present when status === "error"
}
```

The reference `Clip` model is a strict subset of what Suno returns. `API_INTELLIGENCE.md`
additionally documents `audio_url_2`, `image_large_url`, and metadata fields `min_bpm`,
`max_bpm`, `is_mumble`, `can_remix`, `priority`, `stream`, `uses_latest_model`. None are
modelled; unknown keys are ignored on decode. Keep them if you want, but nothing in this
spec depends on them, and there is no fallback from `audio_url` to `audio_url_2`.

---

### 3.1 `GET /api/billing/info/`: account, credits, model catalogue

`LIVE 2026-08-17`

**Request:** no body, no query.

**Response:**

```ts
interface BillingInfo {
  total_credits_left: number;        // REQUIRED
  plan: Plan;                        // REQUIRED
  credits: number;                   // absent => 0
  monthly_usage: number;             // absent => 0
  monthly_limit: number;             // absent => 0
  is_active: boolean;                // absent => false
  models: Model[];                   // absent => []
  period: string;                    // absent => ""
  renews_on: string | null;
  remaster_model_types: RemasterModelInfo[];  // absent => []
}
interface Plan {
  name: string;                      // REQUIRED
  plan_key: string;                  // absent => ""
  usage_plan_features: { name: string }[];    // absent => []
}
interface Model {
  name: string;                      // REQUIRED
  external_key: string;              // REQUIRED
  can_use: boolean;                  // absent => false
  is_default_model: boolean;         // absent => false
  description: string;               // absent => ""
  max_lengths: {
    title: number; prompt: number; tags: number;
    negative_tags: number; gpt_description_prompt: number;
  };
}
interface RemasterModelInfo {
  name: string; external_key: string; is_default_model: boolean;
  can_use: boolean;                  // Suno does NOT send this; absent => false
}
```

**Notes.** Only `total_credits_left` and `plan.name` are load-bearing; default everything
else so one renamed billing field does not break credits, model listing and auth
verification at once. `max_lengths` still advertises a `gpt_description_prompt` limit even
though the create body no longer has that field (see 6.9). `/api/billing/info/` is in the
route-level 404 set (section 5.3).

---

### 3.2 `POST /api/c/check`: captcha preflight

`LIVE 2026-08-17` (returned `{"required": false, "captcha_version": 1}`), shape
`LIVE 2026-07-18`

**Request:**

```ts
interface CaptchaCheckRequest { ctype: string }   // always "generation"
```

Exact body: `{"ctype":"generation"}`. No other fields, no query.

**Response:**

```ts
interface CaptchaCheckResponse {
  required: boolean;                 // REQUIRED. See fail-closed rule below.
  captcha_version: number | null;    // absent => null. Observed: 1.
}
```

**Notes.**

- The field is `required`, **not** `captcha_required`. An older client expected
  `captcha_required`, a field the API never sends.
- **Fail closed.** A response missing `required` must be a hard parse error, and any
  preflight failure (transport error, non-2xx, parse error) must be treated as
  `required = true`. Writing `resp.required ?? false` inverts the safety property: a
  shape change would silently skip the solver and burn every create.
- `captcha_version` never changes control flow in the reference client.
- Path has **no** trailing slash and is in the route-level 404 set.

**When `required` is true.** The solved hCaptcha response string goes into the top-level
`token` field of the create body (section 3.3) and nowhere else. It is not a header, not a
query param, not inside `metadata`. It is single-use and opaque; do not validate its shape
or cache it. There is **no post-hoc captcha detection anywhere**: the preflight is the
only gate, and a create rejected despite `required: false` simply surfaces as an error.

Suno proxies the whole hCaptcha stack under its own domains. If you implement a browser
solver, these values must be passed verbatim to `hcaptcha.render`:

```ts
{ sitekey:   "d65453de-3f1a-4aac-9366-a0f06e52b2ce",
  size:      "invisible",
  sentry:    false,
  endpoint:  "https://hcaptcha-endpoint-prod.suno.com",
  assethost: "https://hcaptcha-assets-prod.suno.com",
  imghost:   "https://hcaptcha-imgs-prod.suno.com",
  reportapi: "https://hcaptcha-reportapi-prod.suno.com" }
```

Token is `(await hcaptcha.execute(id, { async: true })).response`. A minimal client can
skip browser automation entirely: preflight, and if gated, accept an externally supplied
token (2Captcha, manual solve) as an input parameter. Human escape hatch when solving
keeps failing: generate one song in the suno.com UI, which clears the challenge
server-side.

---

### 3.3 `POST /api/generate/v2-web/`: create music

`CAPTURED 2026-04-07`, create path re-verified `LIVE 2026-08-17`

This is the only create endpoint. Custom generation, description generation, extend,
cover, remaster and persona all post the same body shape here. The legacy
`/api/generate/v2/` answers `Token validation failed` and must not be used: that string
is indistinguishable from an expired JWT, so a client on the old path loops through
pointless Clerk refreshes.

**Request body.** 22 top-level keys, all always present (Rule 1). Serialization order
below is the reference order; order is not believed to matter but costs nothing to keep.

```ts
interface GenerateRequest {
  token: string | null;                    // hCaptcha solution; null when not gated
  generation_type: string;                 // "TEXT" (only value ever sent)
  title: string;                           // MUST be a string. null 422s. See 6.1
  tags: string | null;                     // comma-joined style tags
  negative_tags: string;                   // "" when unset. NEVER null
  mv: string;                              // model key, e.g. "chirp-fenix"
  prompt: string;                          // "" when unset. NEVER null
  make_instrumental: boolean;              // false
  user_uploaded_images_b64: string | null; // null
  metadata: GenerateMetadata;
  override_fields: unknown[];              // [] . NEVER null, never omitted
  cover_clip_id: string | null;
  cover_start_s: number | null;
  cover_end_s: number | null;
  persona_id: string | null;
  artist_clip_id: string | null;
  artist_start_s: number | null;
  artist_end_s: number | null;
  continue_clip_id: string | null;
  continued_aligned_prompt: string | null;
  continue_at: number | null;              // seconds
  transaction_uuid: string;                // fresh UUID v4 per request, REQUIRED
}

interface GenerateMetadata {
  web_client_pathname: string;             // "/create"
  is_max_mode: boolean;                    // false
  is_mumble: boolean;                      // false
  create_mode: "custom" | "inspiration" | "cover" | "remaster";
  user_tier: string;                       // "" . Not validated server-side
  create_session_token: string;            // fresh UUID v4 per request, REQUIRED
  disable_volume_normalization: boolean;   // false
  control_sliders?: ControlSliders;        // KEY ABSENT when unset (Rule 2)
}

interface ControlSliders {                 // each member individually absent when unset
  weirdness_constraint?: number;           // 0.0-1.0
  style_weight?: number;                   // 0.0-1.0
  audio_weight?: number;                   // 0.0-1.0
}
```

Slider values map from a 0-100 UI scale as `clamp(x / 100, 0, 1)`.

There is **no** `task` field, **no** `gpt_description_prompt` field, and **no**
`token_provider` field. See 6.2, 6.9, 6.10.

**Response:**

```ts
interface GenerateResponse {
  clips: Clip[];              // absent => []
  status: string | null;      // absent => null
}
```

**HTTP 200 is not success.** Validate before returning:

1. `status` present and `status.toLowerCase() === "error"` (case-**insensitive**
   compare) is a failure.
2. `clips.length === 0` is a failure.

Suno quotes credits and answers 200 with `{"status":"error","clips":[]}` when a create
is rejected server-side. Treating 2xx as success reports a silent no-op after the user
has already been charged.

**Measured cost:** 10 credits per call, returning 2 clips, on `chirp-fenix` (v5.5).
The reference README's figure of roughly 70 is wrong.

#### Model keys (`mv`)

Create models:

```ts
const MV = {
  "v5.5":     "chirp-fenix",          // default
  "v5":       "chirp-crow",
  "v4.5+":    "chirp-bluejay",
  "v4.5-all": "chirp-auk-turbo",
  "v4.5":     "chirp-auk",
  "v4":       "chirp-v4",
  "v3.5":     "chirp-v3-5",
  "v3":       "chirp-v3-0",
  "v2":       "chirp-v2-xxl-alpha",
};
```

Remaster models are a **separate key namespace**, not a subset of the above:

```ts
const REMASTER_MV = {
  "v5.5":  "chirp-flounder",          // default
  "v5":    "chirp-carp",
  "v4.5+": "chirp-bass",
};
```

#### Variant: custom generation (you supply lyrics), `LIVE 2026-08-17`

Start from the defaults, then set:

| Field | Value |
| --- | --- |
| `metadata.create_mode` | `"custom"` |
| `prompt` | the lyrics (`""` when none) |
| `title` | user title, or `""` |
| `tags` | comma-joined styles, or `null` |
| `negative_tags` | exclusions, or `""` |
| `make_instrumental` | boolean |
| `persona_id` | persona id or `null` |
| `metadata.control_sliders` | present only if any slider was set |
| `token` | captcha token or `null` |

#### Variant: description / inspiration mode, `LIVE 2026-08-17` (fixed by the title patch)

| Field | Value |
| --- | --- |
| `metadata.create_mode` | `"inspiration"` |
| `prompt` | **the description text**, in the same `prompt` field lyrics use |
| `title` | `""` |
| `tags`, `make_instrumental`, `persona_id` | as for custom |
| `metadata.control_sliders` | `weirdness_constraint` / `style_weight` only; no `audio_weight` |

Inspiration mode is signalled **only** by `create_mode`. The old
`gpt_description_prompt` field is gone.

#### Variant: extend / continue, `BROKEN`

The reference client builds:

| Field | Value |
| --- | --- |
| `metadata.create_mode` | `"custom"` (not `"extend"`) |
| `prompt` | lyrics or `""` |
| `tags` | tags or `null` |
| `continue_clip_id` | the source clip id |
| `continue_at` | seconds (float) |
| `title` | `""` |

**This body is rejected.** Live 2026-08-17, even with a string `title`, the server
answers **HTTP 400 `Inconsistent task and generation params`**. The correct body is
unknown. See section 7.1. Do not ship extend against this shape and do not guess a
replacement.

#### Variant: cover, `LIVE 2026-08-17` (succeeded after the title patch), body `INFERRED`

| Field | Value |
| --- | --- |
| `metadata.create_mode` | `"cover"` |
| `cover_clip_id` | the source clip id |
| `tags` | tags or `null` |
| `metadata.control_sliders` | `audio_weight` only |
| `cover_start_s`, `cover_end_s` | left `null` |
| `mv` | a normal create model key, **not** a remaster key |

The reference calls this a best-guess port and names `cover_start_s`/`cover_end_s` as
the suspected missing required fields. It nonetheless succeeded live today with both
left null. There is no `task: "cover"` field in v2-web.

#### Variant: remaster, `INFERRED`, never exercised live

| Field | Value |
| --- | --- |
| `metadata.create_mode` | `"remaster"` |
| `mv` | a **remaster** key (`chirp-flounder` / `chirp-carp` / `chirp-bass`) |
| `cover_clip_id` | the source clip id (**remaster reuses `cover_clip_id`**; there is no `remaster_clip_id`) |
| everything else | defaults |

Available remaster models are advertised by `/api/billing/info/` as
`remaster_model_types`. Unlike cover, this variant was never exercised against the live
API. Treat it as unverified.

#### Variant: persona voice

Not a separate mode or endpoint. Set `persona_id` on an otherwise normal custom or
inspiration body. `create_mode` stays `"custom"` or `"inspiration"`. The legacy
`task: "vox"` field does not exist in v2-web.

---

### 3.4 `POST /api/generate/concat/v2/`: concatenate a clip

`CAPTURED` (shape matches `API_INTELLIGENCE.md`), not exercised live today

**Request:** `{ "clip_id": string }` and nothing else. No metadata, no token, no
`transaction_uuid`. Do not fold this into the create-body abstraction.

**Response:** a single `Clip` object, not an array and not wrapped.

Route-level 404 set.

---

### 3.5 `POST /api/generate/lyrics/`: submit lyrics job

`LIVE 2026-08-17`, free (no credits)

**Request:** `{ "prompt": string }`

**Response:** `{ "id": string }` (`id` required; a response without it is a hard parse
error).

Trailing slash. Route-level 404 set.

---

### 3.6 `GET /api/generate/lyrics/{id}`: poll lyrics job

`LIVE 2026-08-17`

**Request:** no body, no query. **No trailing slash after the id** (asymmetric with the
submit route above).

**Response:**

```ts
interface LyricsResult {
  text: string;            // REQUIRED on every poll, including intermediate ones
  title: string;           // REQUIRED
  status: string;          // REQUIRED
  error_message: string;   // absent => ""
  tags: string[];          // absent => []  (an ARRAY here, unlike Clip.metadata.tags)
}
```

**Poll loop** (distinct from the clip poll, see section 4.3):

```
delay = 2s
loop:
  sleep(delay)                       // SLEEP FIRST
  r = GET /api/generate/lyrics/{id}
  if r.error_message !== ""  -> hard failure, message is the reason
  if r.status === "complete" -> done                 (exact, case-sensitive)
  if elapsed > 60s           -> timeout
  delay = min(delay * 2, 8s)         // 2, 4, 8, 8, ...
```

The timeout is checked **after** the completion check, so a job that finishes on the poll
crossing 60 s still succeeds.

This id-addressed path is **not** in the route-level 404 set, so a 404 here means a bad
job id.

---

### 3.7 `POST /api/feed/v3`: list and search your library

`LIVE 2026-08-17` (cursor pagination confirmed: page 2 returned 20 clips with zero
overlap with page 1)

**Request** (Rule 3: omit unset keys):

```ts
interface FeedV3Request {
  cursor?: string;        // opaque next_cursor. OMIT on page 1. Never null, never ""
  limit?: number;         // reference sends 20 for list, 50 for search
  filters?: FeedFilters;
}
interface FeedFilters {
  searchText?: string;    // camelCase on the wire
  trashed?: string;       // a STRING. The reference sends "False" (capital F)
  fullSong?: string;      // camelCase on the wire
  stem?: { presence: string };
  liked?: string;         // "True": only clips this account liked. LIVE 2026-10-23
}
```

Exact first-page list body: `{"limit":20}`.
Exact search body: `{"limit":50,"filters":{"searchText":"<q>","trashed":"False"}}`.
Exact liked body: `{"limit":20,"filters":{"liked":"True","trashed":"False"}}`. Every clip
it returned had `is_liked: true`. The `stem`-style `{"liked": {"presence": "True"}}` is
accepted and **ignored**: it returns the whole library. Paging is the same cursor walk.

Note the casing split: the outer body is snake_case (`cursor`, `limit`, `filters`), the
keys **inside** `filters` are camelCase.

**Response:**

```ts
interface FeedResponse {
  clips: Clip[];               // absent => []
  next_cursor: string | null;
  has_more: boolean;           // absent => false
}
```

**Notes.** No trailing slash. Pagination is opaque-cursor only; page numbers are not
accepted and silently return page one forever. `/api/feed/v3` is in the route-level 404
set (a live 404 on this route is what motivated the split).

---

### 3.8 `GET /api/feed/?ids=<id1>,<id2>`: fetch clips by id

`LIVE 2026-08-17`

The polling primitive behind status checks, downloads and generation waits.

**Request:** no body. Path is `/api/feed/?ids=` plus the ids joined by a bare comma. Ids
are not percent-encoded by the reference.

**Batch in chunks of at most 2 ids, one request per chunk, concatenate the results.**
Sending 4 or more ids returns only the first 2, silently. During a wait loop that means
the dropped ids never reach a terminal state and the poll runs to timeout even though
the songs finished.

**Response:** a **bare JSON array** of `Clip`. Not an object, not `{clips: [...]}`. This
is the opposite shape from `/api/feed/v3`; do not share one parser between them.

Fewer clips than requested ids is legal and normal mid-generation. A missing id means
"not ready" during polling, and "does not exist or is not yours" outside polling.

**404 semantics:** classification uses the URL **path** only, so this reads as
`/api/feed/`, which is deliberately absent from the route-level set. A 404 here means a
bad id.

Practical note from live testing: this endpoint needs the **full clip UUID**. A truncated
or short id returns a misleading 404.

---

### 3.9 `POST /api/gen/trash`: trash and restore

`LIVE 2026-07-20`

**Request** (top level, **not** wrapped):

```ts
interface TrashRequest { clip_ids: string[]; trash: boolean }
```

`trash: true` moves to trash, `false` restores. All ids ride in one request (no
chunking).

**Response:** `{ "ids": string[], "is_trashed": boolean }`. Note the request key is
`clip_ids` and the response key is `ids`; they do not match.

**Notes.** No trailing slash. The previous route `/api/feed/trash` with `{"ids": [...]}`
now 404s. If the server answers 422 citing `body.spec.clip_ids`, **do not** wrap the body
in a `spec` object: those `loc` entries are server parameter names, not a required
wrapper, and a `spec`-wrapped body is rejected. `/api/gen/trash` is in the route-level
404 set precisely because its ids ride in the body, so a 404 can only mean the route
moved.

---

### 3.10 `POST /api/gen/{clip_id}/set_metadata/`: edit a clip

`INFERRED` (implemented, not exercised live today)

**Request** (Rule 3: unset keys are absent, never `null`, never `""`):

```ts
interface SetMetadataRequest {
  title?: string;
  lyrics?: string;
  caption?: string;
  remove_image_cover?: boolean;   // reference only ever sends true
  remove_video_cover?: boolean;   // reference never sends this at all
}
```

**Response:** ignored by the reference; only the status code is checked.

Trailing slash. Id-addressed, so a 404 means a bad clip id. Sending `{}` is possible and
not guarded against.

---

### 3.11 `POST /api/gen/{clip_id}/set_visibility/`: publish / unpublish

`INFERRED`

**Request:** `{ "is_public": boolean }`, always present.

**Response:** ignored; status only.

Trailing slash. Id-addressed 404. There is no batch endpoint; multiple clips means one
request per clip.

---

### 3.12 `GET /api/gen/{clip_id}/aligned_lyrics/v2/`: word-level timed lyrics

`LIVE 2026-08-17`

**Request:** no body, no query.

**Response:** an object; extract the `aligned_words` array.

```ts
interface AlignedLyricsResponse { aligned_words: AlignedWord[] /* + ignored fields */ }
interface AlignedWord {
  word: string;              // REQUIRED
  start_s: number;           // REQUIRED, seconds
  end_s: number;             // REQUIRED, seconds
  success: boolean;          // absent => FALSE
  p_align: number | null;    // absent => null
}
```

A missing `aligned_words` key is an error, not an empty result.

**Notes.** Trailing slash after `v2`. Id-addressed 404. `success` defaulting to `false`
is a fail-quiet default: a response that omits the field yields an all-false word list,
which downstream means "no timed lyrics" (instrumental or not yet aligned), not an error.
Alignment is legitimately unavailable for instrumentals and for freshly finished clips,
so callers that use it opportunistically should swallow failures rather than propagate
them.

---

### 3.13 `POST /api/edit/stems/{clip_id}`: stem separation

Submission `LIVE 2026-08-17` (works, job completes). **Response shape `BROKEN` /
unknown.**

**Request:** **no body at all.** No JSON, no `{}`, and therefore **no `content-type`
header**. In TypeScript: `fetch(url, { method: "POST", headers })` with no `body`.
Sending `{}` with `application/json` is a different request than the one that was
verified.

**Response:** **unknown.** The reference decodes it as a single `Clip` and that decode is
wrong. What is known from live testing: the job is accepted, it completes, and it
produces **two new clips** titled `"<title> - Vocals"` and `"<title> - Instrumental"`.
Whether the response body is an array of clips, a wrapper object, or a job envelope was
not captured. See section 7.2.

**Implementable workaround today:** treat the response body as opaque. Do not fail the
call on a decode error. Discover the two resulting clips afterwards through
`POST /api/feed/v3` (they appear in the library) and fetch or download them by id.

**Notes.** No trailing slash. An earlier write-up guessed `/api/generate/stems/`; that
path is wrong. Id-addressed 404. The reference does not poll after submitting.

---

### 3.14 `GET /api/persona/get-persona-paginated/{persona_id}/?page=0`: read a persona

`INFERRED`

**Request:** no body. `page=0` is hardcoded; there is no pagination parameter. Trailing
slash comes **before** the query string.

**Response:**

```ts
interface PersonaResponse { persona: PersonaInfo }
interface PersonaInfo {
  id: string;                        // REQUIRED
  name: string;                      // REQUIRED
  description: string | null;
  image_s3_id: string | null;
  user_display_name: string | null;
  user_handle: string | null;
  persona_clips: unknown[];          // absent => []
}
```

Unwrap and return `persona`. Id-addressed 404.

**Persona list, create and delete do not exist** in the reference client. See 7.6.

---

### 3.15 `GET <clip.audio_url>` / `GET <clip.video_url>`: CDN download

`LIVE 2026-08-17`

Absolute pre-signed CDN URLs taken from the clip object. This is a genuinely different
transport and must not reuse the studio-api client.

- **Send none of the studio-api headers.** No `authorization`, no `device-id`, no
  `browser-token`. The URLs are pre-signed.
- Separate timeouts in the reference: connect 20 s, per-read inactivity 60 s, overall
  600 s. A single shared 30 s client would kill long downloads.
- Choose `video_url` for video, else `audio_url`. A `null` URL is an error, not an empty
  download.
- File extension is hardcoded from that same choice (`mp4` for video, `mp3` for audio).
  It is never derived from the URL or from `Content-Type`.
- Verify the byte count against `Content-Length` when present and reject a short read;
  stream to a temp path and rename on success so a truncated transfer never looks
  finished.
- CDN failures are plain HTTP errors. A 401/403/404/429 from the CDN is **not** an auth
  or rate-limit signal for the studio API and must not trigger a JWT refresh.

Measured: roughly 185 kbps MP3.

---

### 3.16 `POST /api/mango/rights`: playback keys for `media_urls`

`LIVE 2026-10-13`

How suno.com's player turns the encrypted `media_urls` file into sound. Nothing about it
touches the download allowance: this is listening, not the Download button.
`download_usage` was identical before and after a run of rights calls and two full
decrypts.

**It is not a per-account access check.** Measured on a Pro account:

| Caller | Clip | Answer |
| --- | --- | --- |
| anonymous (no `authorization`) | the account's own **private** clip | 200 `{key, iv, glt}`; decrypts to the full file |
| anonymous | public clip | 200 `{key, iv, glt}`; decrypts |
| with the session | the same private clip | 200 `{key, iv}`, **no `glt`** |
| either | id that does not exist | 404 `{"detail": "Content not found"}` |

So the clip id is enough, the same as it was with the old public `audio_url`. No 401 or
403 has been observed.

The signed-in answer cannot be used with the scheme below: without `glt` there is no
wrap key, and how the signed-in player derives its own is not known. **Send this request
without `authorization`.** The other headers of section 2 can stay.

**Request:**

```ts
interface MangoRightsRequest {
  content_params: {
    content_id: string;              // the clip id
    content_type: "clip";
  };
}
```

**Response:**

```ts
interface MangoRights {
  key: string;   // base64, AES-256-GCM wrapped content key
  iv: string;    // base64, AES-256-GCM wrapped 16-byte CTR counter
  glt: string;   // utf-8 token; its SHA-256 is the key that unwraps the two above
}
```

**Decrypting**, matching the player:

1. `wrapKey = SHA-256(utf8(glt))`.
2. Unwrap `key` and `iv` separately with AES-256-GCM under `wrapKey`. Layout of each
   decoded value: `nonce = bytes[0:12]`, `tag = bytes[-16:]`, ciphertext in between.
   Additional authenticated data: the clip id as utf-8. A wrong clip id fails the tag
   check, so key material cannot be reused across clips.
3. The audio file is AES-CTR (128, 192 or 256 bits by the unwrapped key's length) with
   the unwrapped counter as the initial IV. CTR keeps the length, so the CDN's
   `Content-Length` is the decrypted size, and decryption can run chunk by chunk as the
   bytes arrive.
4. The plaintext is an MP4 container: `ftyp` at offset 4, major brand `isom` on both
   clips measured. Check the header before handing bytes to a player: a failed decrypt
   is otherwise indistinguishable from a file. Decrypted size equalled the CDN's
   `Content-Length` exactly (3 999 917 and 6 240 796 bytes).

The `media_urls` fetch itself is a plain CDN request, like 3.15: no studio-api headers.
`playTrack` runs it in parallel with `/rights`.

Client: `playTrack(client, clip)` returns the decrypted stream; `downloadClip` with
`source: 'playback'` writes it to disk.

---

### 3.17 `GET /api/clip/{clip_id}`: one clip, anyone's

`LIVE 2026-10-23`

The read behind suno.com's song page. Unlike `/api/feed/?ids=` (3.8), which only returns
the signed-in account's own clips, this answers for any clip.

**Request:** no body, no query.

**Response:** a single `Clip` (not an array), with `media_urls`, `handle`,
`display_name`, `is_liked` and the rest of the public fields. Signed in, the answer also
carries `is_download_unlocked`.

**Needs no session.** Measured:

| Caller | Clip | Answer |
| --- | --- | --- |
| anonymous | another creator's public clip | 200, full clip |
| anonymous | the account's own **private** clip | 200, full clip |
| with the session | either | 200, plus `is_download_unlocked` |
| anonymous | id that does not exist | 404 `{"detail": "Not found."}` |

So, like `/api/mango/rights` (3.16), the clip id is enough. Client: `getClip()` sends the
session when one is stored and goes anonymous otherwise; `Suno.info()` falls back to it
when feed-by-ids has nothing, which is what lets `playTrack(id)` work signed out.

No trailing slash. Id-addressed 404.

---

### 3.18 `POST /api/gen/{clip_id}/update_reaction_type/`: like and unlike

`LIVE 2026-10-23`

**Request:**

```ts
interface UpdateReactionRequest {
  reaction: "LIKE" | null;   // null removes the reaction; send it, do not omit it
}
```

**Response:**

```ts
interface ClipReaction {
  clip: string;              // the clip id
  reaction_type?: string;    // "L" for a like; the key is ABSENT when there is none
  play_count: number;
  skip_count: number;
  flagged: boolean;
  updated_at: string;
}
```

Verified both ways through the liked feed (3.7): the clip appears after a like and
disappears after an unlike. Other reaction values (a dislike, presumably) were not tried.
Trailing slash. Needs a session.

---

### 3.19 `GET /api/profiles/{handle}`: public profile

`LIVE 2026-10-23`

**Request:** no body. Query, all three **required**:

```
?page=<n>&playlists_sort_by=upvote_count&clips_sort_by=created_at
```

Leaving out `playlists_sort_by` answers 422. `page` starts at 1.

**Response:**

```ts
interface ProfilePage {
  user_id: string;
  display_name: string;
  handle: string;
  profile_description: string;
  avatar_image_url: string;
  clips: Clip[];               // this page of the creator's public clips
  stats: {
    upvote_count__sum: number;
    play_count__sum: number;
    followers_count: number;
    following_count: number;
  };
  is_flagged: boolean;
  is_verified: boolean;
  is_following: boolean;       // about the viewer; false when anonymous
  num_total_clips: number;
  current_page: number;
  playlists: Playlist[];
  favorite_songs: unknown[];
  personas: unknown[];
  // + viewer_is_blocking_profile, is_following_viewer, and more
}
```

**Paging.** Page 1 holds the pinned clips **plus** 20; later pages hold 20. Pinned clips
also appear again in the regular order, so a running count never matches
`num_total_clips`. To walk every clip, deduplicate by id and stop on an empty page or a
short one.

**Needs no session.** With one, `is_following` says whether this account follows the
profile. An unknown handle is 404 `{"detail": "Not found."}`.

---

### 3.20 `GET /api/profiles/{handle}/following` and `/followers`

`LIVE 2026-10-23`

**Request:** no body. Query: `?page=<n>`, from 1. **Needs a session**: anonymous, both
answer 401.

**Response:**

```ts
interface FollowPage {
  user_id: string;
  handle: string;
  profiles: SimpleProfile[];
  current_page: number;
  num_total_profiles: number;
}
interface SimpleProfile {
  user_id: number;              // -1 on every entry measured; NOT the account id
  entity_type: "simple_profile_schema";
  external_user_id: string;     // the account id
  display_name: string;
  handle: string;
  avatar_image_url: string;
  is_following: boolean;
  is_following_viewer: boolean;
  is_verified: boolean;
  stats: { followers_count: number; likes_count: number; clips_count: number; last_login: string };
}
```

20 profiles to a page. Stop on an empty page or a short one.

---

### 3.21 `POST /api/profiles/follow`: follow and unfollow

`LIVE 2026-10-23`

**Request:** the handle rides in the body, not the path.

```ts
interface FollowRequest { handle: string; unfollow: boolean }
```

`unfollow: false` follows, `true` stops following.

**Response:** empty. Verified through `is_following` on the profile (3.19). No trailing
slash. Needs a session.

---

### 3.22 `GET /api/playlist/{playlist_id}?page=<n>`: read a playlist

`LIVE 2026-10-13` (read anonymously), `LIVE 2026-10-23` (read with the session)

The GET suno.com makes when anyone opens a share link. Clips live under
`playlist_clips[].clip`, each next to the playlist's own position for it:

```ts
interface PlaylistPage {
  id: string;
  name: string;
  description: string;
  user_display_name: string;
  user_handle: string;
  total_duration: number;
  num_total_results: number;
  is_public: boolean;
  is_owned: boolean;
  playlist_clips: Array<{
    clip: Clip;
    relative_index: number;   // the playlist order; can be fractional
    created_at: string;
  }>;
}
```

Paging is `?page=N`; keep going until a page adds nothing new or `num_total_results` is
reached. `relative_index` is what a removal needs (3.24).

Anonymous and signed-in reads of a public playlist returned the same clips and indexes. Whether an anonymous
read sees a **private** playlist is not verified, and a new playlist starts private, so
the client reads its own with the session (`getPlaylist(..., { signedIn: true })`).

---

### 3.23 `GET /api/playlist/me`: the account's own playlists

`LIVE 2026-10-23`

**Request:** no body. Query: `?page=1&show_trashed=false&show_sharelist=false`. Needs a
session.

**Response:**

```ts
interface MyPlaylists {
  num_total_results: number;
  current_page: number;
  playlists: Array<{
    id: string;
    entity_type: "playlist_schema";
    name: string;
    description: string;
    image_url: string;
    is_public: boolean;
    is_owned: boolean;
    is_trashed: boolean;
    num_total_results: number;   // clips in that playlist
    song_count: number;
    // + play_count, upvote_count, user_handle, and more
  }>;
}
```

A page past the end answers `playlists: []`.

---

### 3.24 Playlist writes

`LIVE 2026-10-23`, except where marked

All four need a session and take a **flat** body. Their 422s name `body.spec.*`, but as
with `/api/gen/trash` (3.9) those are server parameter names, not an envelope. Every
route has a trailing slash.

**Create:** `POST /api/playlist/create/`

```ts
interface CreatePlaylistRequest { name: string }
```

Returns the new playlist (`entity_type: "playlist_schema"`, `id`, `name`,
`playlist_clips: []`, `is_owned: true`, `is_public: false`). **The server validates
nothing:** any body, `{}` included, creates a playlist called "Untitled". The client
refuses an empty name before sending, and never retries a create.

**Add clips:** `POST /api/playlist/update_clips/`

```ts
interface AddClipsRequest {
  playlist_id: string;
  update_type: "add";
  metadata: { clip_ids: string[] };
}
```

Answers 204. Never retried: a replay would add the clips twice.

**Remove clips:** same route.

```ts
interface RemoveClipsRequest {
  playlist_id: string;
  update_type: "remove";
  metadata: {
    clip_ids: string[];
    indexes: number[];   // REQUIRED: each clip's relative_index, from 3.22
  };
}
```

Answers 204. Without `indexes` it answers 400 `{"error_type": "remove_indexes_invalid",
"detail": "Choose which songs to remove from the playlist."}`. Measured with one clip;
the two arrays are sent pairwise for several.

**Rename and describe:** `POST /api/playlist/set_metadata/`

```ts
interface SetPlaylistMetadataRequest { playlist_id: string; name: string; description: string }
```

All three required. Returns 200 with the updated playlist.

**Trash:** `POST /api/playlist/trash/`

```ts
interface TrashPlaylistRequest { playlist_id: string; undo_trash: boolean }
```

`undo_trash: false` trashes, answers 204. `undo_trash: true` presumably restores:
`INFERRED`, never exercised.

---

### 3.25 `POST /api/search`: search everyone's public songs

`LIVE 2026-10-23`

What suno.com's search box sends. Not the library search of 3.7, which filters the
signed-in account's own clips through `searchText`. Needs a session.

**Request:**

```ts
interface SearchRequest {
  search_queries: Array<{
    name: "tag_song";
    search_type: "tag_song";
    term: string;
    from_index: number;
    size: number;
    rank_by: "most_relevant" | "play_count" | "trending";
    is_public: true;
  }>;
}
```

**Response:** keyed by the query's `name`.

```ts
interface SearchResponse {
  result: {
    tag_song: {
      total_hits: number;
      result: Clip[];
      from_index: number;
      page_size: number;
      tuned_count: number;
    };
  };
}
```

**Limits measured.** `size` up to 1000 works and returns about 780 to 790 songs, fewer than
asked: some are filtered out after the count. `from_index` beyond roughly 200 returns an
empty result, so the index serves a window and deep paging does not work, whatever
`total_hits` says. No trailing slash.

---

## 4. Clip lifecycle

### 4.1 Status values

| Value | Terminal? | Meaning |
| --- | --- | --- |
| `"complete"` | **yes** | Success. The only value that gates download. |
| `"error"` | **yes** | Failure (moderation, internal error). |
| `"streaming"` | no | In flight. The only non-terminal value that appears anywhere in the reference. |
| anything else | no | Treat as pending. |

**The set is open.** Terminality is exactly:

```ts
const isTerminal = (s: string) => s === "complete" || s === "error";
```

Case-**sensitive**, exact match, lowercase. Do not model this as an exhaustive TS union
that throws on unknown values: the first time Suno adds an in-flight state, a strict
enum crashes the poll loop, whereas a default-pending predicate keeps working.

Note the asymmetry with the create submission: the **top-level** `GenerateResponse.status`
is compared to `"error"` case-**insensitively**, while **clip** statuses are compared
case-sensitively.

### 4.2 Failure reasons

A clip in `status === "error"` carries no top-level reason. The reason is
`metadata.error_message`, falling back to `metadata.error_type`, falling back to a
generic string. Moderation rejections surface here, and re-submitting the identical
prompt fails identically.

### 4.3 Polling strategy for clips

```ts
async function pollClips(ids: string[], timeoutSecs: number, intervalSecs: number) {
  const start = Date.now();
  const timeoutMs = timeoutSecs * 1000;
  let delayMs = Math.max(intervalSecs, 1) * 1000;
  const capMs = Math.max(intervalSecs, 15) * 1000;   // note: max(interval,15), not a flat 15
  for (;;) {
    const clips = await getClips(ids);               // FETCH FIRST, no lead sleep
    if (allRequestedTerminal(ids, clips)) return clips;
    if (Date.now() - start >= timeoutMs) throw new Error(
      `generation timed out after ${timeoutSecs}s; ${pending(ids, clips).length} of ` +
      `${ids.length} clip(s) still pending: ${pending(ids, clips).join(", ")}`);
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, capMs);
  }
}

const allRequestedTerminal = (ids: string[], clips: Clip[]) =>
  ids.every(id => clips.some(c => c.id === id && isTerminal(c.status)));

const pending = (ids: string[], clips: Clip[]) =>
  ids.filter(id => !clips.some(c => c.id === id && isTerminal(c.status)));
```

Four properties that are easy to lose:

1. **Doneness is evaluated over the requested ids, not the returned clips.** An id absent
   from the feed is pending. `clips.every(isTerminal)` returns `true` for an empty array,
   which is exactly the regression this shape exists to prevent (it reported success with
   nothing generated).
2. **Fetch first, then sleep.** The loop always makes at least one request.
3. The timeout is checked after the fetch and before the sleep, so the loop can overrun
   the budget by up to one sleep plus one round trip.
4. The backoff cap is `max(interval, 15)`, so a configured interval above 15 s never
   backs off at all (interval 30 gives a flat 30 s).

Reference defaults: interval 5 s, timeout 600 s. With those, sleeps run 5, 10, 15, 15, 15…

Each 2-id chunk of the underlying feed call is independently wrapped in the auth retry
(section 1.6) so a 10-minute wait survives the JWT staleness window mid-generation.

### 4.4 End-to-end create flow

1. `POST /api/c/check` with `{"ctype":"generation"}`. Fail closed.
2. If gated, obtain a token and put it in `GenerateRequest.token`; else `null`.
3. `POST /api/generate/v2-web/` with the full 22-key body.
4. Validate: reject `status === "error"` (case-insensitive) and reject empty `clips`.
5. Poll the returned clip ids per 4.3, batching by 2.
6. Download `audio_url` for clips whose status is exactly `"complete"`. A clip that
   polled to `"error"` is a failed generation even if its siblings succeeded.

---

## 5. Error taxonomy

### 5.1 Status and body pattern to meaning

Evaluate in exactly this order. Order is load-bearing (see 5.2).

| # | Condition | Meaning | Retry? |
| --- | --- | --- | --- |
| 1 | HTTP 401 | Auth expired. Body is **not** read. | Refresh JWT, retry **once** |
| 2 | HTTP 403 **and** body matches the auth patterns (5.2) | Auth expired | Refresh JWT, retry **once** |
| 3 | HTTP 403 otherwise | Forbidden | No |
| 4 | HTTP 429 | Rate limited. Body is **not** read. No `Retry-After` parsing anywhere. | Not automatically. Wait 30-60 s and retry manually |
| 5 | HTTP 404 on a route-level path (5.3) | The endpoint moved or its schema drifted | Retrying the same request will not help; update the client |
| 6 | HTTP 404 on any other path | The caller's id does not exist | No, use a different id |
| 7 | Any other non-2xx **and** body matches the auth patterns | Auth expired | Refresh JWT, retry **once** |
| 8 | Any other non-2xx **and** body matches the schema-drift needles (5.4) | Suno's request schema changed | No, the body shape must be fixed |
| 9 | Any other non-2xx | Generic API error | Yes, with backoff |
| 10 | HTTP 200 on create with `status == "error"` (case-insensitive) or empty `clips` | Generation rejected server-side, credits may already be quoted | No |
| 11 | HTTP 400 `Inconsistent task and generation params` on create | Field combination the server rejects. Observed on extend. | No, the body is wrong |
| 12 | HTTP 422 with `loc: ["body","params","title"]`, `type: "string_type"` | `title` was `null`; it must be a string | No, fix the body |

Bodies are read only for cases 2/3 and 7/8/9. Cases 1, 4, 5, 6 never read the body.

### 5.2 Auth-expiry body sniff

```ts
function looksLikeAuthExpired(body: string): boolean {
  const l = body.toLowerCase();
  return l.includes("token validation failed")
      || l.includes("jwt expired")
      || l.includes("jwt is expired")
      || l.includes("invalid jwt")
      || l.includes("invalid token")
      || l.includes("not authenticated")
      || l.includes("unauthenticated");
}
```

All seven variants matter. Both `"jwt expired"` and `"jwt is expired"` are listed; both
`"not authenticated"` and `"unauthenticated"` are listed (the space means one does not
contain the other). Dropping any variant reintroduces a stuck-token bug.

`Token validation failed` is what Suno returns when the JWT crosses the server-side
staleness threshold (roughly 30 minutes) while its own `exp` claim is still valid. It
arrives as a 4xx body, **not** as a 401. A client that only checks `res.status === 401`
will fail every long poll.

**The auth sniff runs before the schema-drift sniff.** Consequence: a 422 whose body
happens to contain `invalid token` is classified as auth-expired and triggers a refresh
plus one retry, not as a validation error. There is no dedicated 422 branch anywhere;
all the 422-shaped lessons live in request construction, not status handling.

### 5.3 Route-level 404 set

A 404 means different things on different paths. Classification uses the **response**
URL's pathname (post-redirect, query string stripped), compared by **exact string
equality** against this 14-entry list:

```ts
const ROUTE_LEVEL_404 = [
  "/api/billing/info/",        // trailing slash
  "/api/c/check",              // no trailing slash
  "/api/generate/v2-web/",     // trailing slash
  "/api/generate/concat/v2/",  // trailing slash
  "/api/generate/lyrics/",     // trailing slash; the SUBMIT route only
  "/api/feed/v3",              // no trailing slash
  "/api/gen/trash",            // no trailing slash
  "/api/search",               // no trailing slash
  "/api/profiles/follow",      // no trailing slash
  "/api/playlist/me",          // no trailing slash
  "/api/playlist/create/",     // trailing slash
  "/api/playlist/update_clips/",
  "/api/playlist/set_metadata/",
  "/api/playlist/trash/",
];
```

In TypeScript: `new URL(response.url).pathname`.

Membership is exact, not prefix. `/api/generate/lyrics/` is in the set but
`/api/generate/lyrics/{id}` is not, and they differ only by the id suffix; a prefix match
would misclassify every lyrics-poll 404. `/api/feed/` (the `?ids=` poll) is deliberately
**absent** because its ids ride in the query string, while `/api/gen/trash` is
deliberately **present** because its ids ride in the body, so a 404 there can only mean
the route moved. It has moved before: `/api/feed/trash` became `/api/gen/trash`. The
playlist writes, follow and search are present for the same reason.

The path only says which 404s are worth asking about. The body decides: an unknown id in
a body is answered by the application in JSON (`{"detail": "Not found."}`) and stays
`not_found`; only a non-JSON 404, the web server's own page, reads as the route moving.

### 5.4 Schema-drift detection

The reference matches two literal substrings against the **raw** (not lowercased) body:

```ts
const SCHEMA_DRIFT_NEEDLES = [
  "'loc': ['body', 'params'",     // Python repr form
  '"loc": ["body", "params"',     // JSON form
];
```

Both are unterminated (no closing bracket) and both require the space after the colon
**and** after the comma. Compact JSON such as `{"loc":["body","params"]}` does **not**
match and falls through to the generic API error.

If you prefer `JSON.parse` plus inspection of `detail[].loc`, that is a **deliberate
deviation** that detects strictly more than the reference. Label it as such; it is not
equivalent behaviour.

### 5.5 Error classes and retryability

| Class | Trigger | Retryable |
| --- | --- | --- |
| `auth_missing` | no credentials stored | No; re-authenticate |
| `auth_expired` | 401, matching 403, matching non-2xx body | Refresh and retry once, automatically |
| `rate_limited` | 429 | Manually, after 30-60 s |
| `not_found` | 404 on an id-addressed path | No |
| `api_error` | 404 on a route-level path, or any other unclassified non-2xx | Yes, with backoff |
| `forbidden` | 403 that is not auth-shaped | No |
| `schema_drift` | 5.4 needles | No; the request body must be corrected |
| `generation_failed` | 200-with-error, empty clips, poll timeout, clip in `"error"` | Only if not a moderation rejection |
| `download_error` | missing CDN URL, short read | Depends; check the clip finished first |
| `http_error` / `io_error` / `json_error` | transport, filesystem, decode | Yes |

Moderation rejections (a `generation_failed` whose message contains the case-insensitive
stem `moderat`) are **not** retryable: the identical prompt fails identically.

### 5.6 Clerk error cases

Clerk failures bypass the studio-api classification entirely.

| Case | Meaning |
| --- | --- |
| non-2xx on `GET /v1/client` | exchange failed; body excerpt is the detail |
| no session id in the response | no active Clerk session; the user must log into suno.com again |
| non-2xx on `POST .../tokens` | refresh failed |
| response without a top-level `jwt` | the session has probably expired; re-authenticate |

The reference truncates Clerk error bodies to 500 characters (newlines replaced with
spaces, `...` appended) but embeds studio-api error bodies untruncated. If you reproduce
the truncation, note the reference's guard compares **byte** length while the slice takes
**characters**, so multi-byte bodies can exceed 500 characters.

### 5.7 Reference CLI exit codes (not part of the wire contract)

Included only because agents key off them: `0` success, `1` transient (retry), `2`
config or auth (fix setup, do not retry), `3` bad input including not-found and
moderation rejections, `4` rate limited, `130` interrupt. Code `5` was removed and must
not reappear.

---

## 6. Sharp edges

### 6.1 `title` must be a string, and the reference still gets it wrong on one path

**Wire rule (`LIVE 2026-08-17`):** `title` must be a JSON string. Sending `null` returns
HTTP 422 with

```json
{"type": "string_type", "loc": ["body", "params", "title"], "msg": "Input should be a valid string"}
```

Suno tightened this around 2026-08-01. It broke `describe`, `cover` and `extend` in the
reference client, all of which left `title` unset, while `generate --title` kept working.

**Reference state:** the constructor was patched to default `title` to `""`. But the
generate code path still assigns the CLI's optional title straight onto the field, which
overwrites the empty-string default with `null` whenever no title was supplied. That path
is therefore still capable of emitting `"title": null`. (The 422 rule is live-verified;
that this specific path still triggers it is read off the source, not separately
measured.)

**Port rule:** always coerce, `title: userTitle ?? ""`. Never let `undefined` or `null`
reach the wire.

### 6.2 Do not send `token_provider`

There is no `token_provider` field in the v2-web schema. Suno types it as an integer and
422s on a string; the hCaptcha flow works without it. Only `token` rides on the body.
Verified again live today: the reference omits it entirely and generation succeeds. Older
reverse-engineering write-ups and gcui-art-derived ports send it.

### 6.3 Null versus empty string versus absent, field by field

This is the highest-value table in the document. There is no uniform rule to fall back on.

| Field | Correct unset value | Notes |
| --- | --- | --- |
| `title` | `""` | `null` 422s (6.1) |
| `prompt` | `""` | plain string, can never be `null` |
| `negative_tags` | `""` | plain string, can never be `null` |
| `metadata.user_tier` | `""` | not validated server-side |
| `override_fields` | `[]` | never `null`, never absent |
| `tags` | `null` | note: **not** `""` |
| `token` | `null` | |
| `user_uploaded_images_b64` | `null` | |
| `cover_clip_id`, `cover_start_s`, `cover_end_s` | `null` | |
| `persona_id` | `null` | |
| `artist_clip_id`, `artist_start_s`, `artist_end_s` | `null` | |
| `continue_clip_id`, `continued_aligned_prompt`, `continue_at` | `null` | |
| `metadata.control_sliders` | **key absent** | the only omit-when-unset key in the create body |
| `control_sliders.*` (each of the three) | **key absent** | individually |
| `FeedV3Request.cursor` | **key absent** | never `null`, never `""` |
| `FeedV3Request.limit`, `.filters` | **key absent** | |
| `FeedFilters.*` | **key absent** | |
| `SetMetadataRequest.*` | **key absent** | |

The roughly eleven `null` placeholders in the create body are not optional. They are what
the web app sends in every mode, and omitting one returns pydantic `missing field`.

### 6.4 Fields that look decorative but are mandatory

- `transaction_uuid`: fresh UUID v4 per request, top level.
- `metadata.create_session_token`: fresh UUID v4 per request.
- `metadata.web_client_pathname`: `"/create"`.
- `metadata.is_max_mode`, `is_mumble`, `disable_volume_normalization`: all `false`, all
  required.
- `generation_type`: `"TEXT"`.

`metadata.user_tier` is required to be present but its value is not validated (empty
string and arbitrary text both succeed).

Do **not** regenerate the two UUIDs on the auth retry (1.6).

### 6.5 Non-obvious headers

- `authorization` uses **opposite conventions on the two hosts**: raw `__client` cookie
  value with no `Bearer` on `auth.suno.com`, `Bearer <jwt>` on
  `studio-api-prod.suno.com`. Prefixing `Bearer` on Clerk breaks it.
- `cookie` on Clerk is **synthesized** as `__client=<value>`. Do not forward the stored
  full browser cookie header; it can exceed Clerk's header limits.
- `origin` has **no** trailing slash, `referer` **has** one. They are easy to normalize
  into each other by accident.
- `browser-token` is recomputed per request with a fresh millisecond timestamp. Caching
  it changes the anti-bot fingerprint.
- `device-id` falls back to the all-zero UUID. An empty string or an omitted header is a
  different request.
- The token-mint POST sends `content-type: application/x-www-form-urlencoded` with an
  **empty** body. `fetch(url, {method:'POST'})` omits the header entirely;
  `JSON.stringify({})` sends the wrong type and two bytes. Neither reproduces the
  captured request.
- Two base64 alphabets in one auth module: **base64url without padding** for JWT claims,
  **standard base64 with padding** for `browser-token`. Deliberate, and swapping them
  breaks one or the other silently.
- `POST /api/edit/stems/{id}` sends **no body and no `content-type`**.
- The reference is not internally consistent about its HTTP client: `suno auth` uses a
  bare client (default user agent, no timeout) for Clerk calls, while `SunoClient` uses
  the Chrome user agent and a 30 s timeout for both studio-api calls and its own Clerk
  refreshes. A TypeScript port with one shared fetch wrapper matches neither exactly. If
  Clerk ever gates on user agent, only the `SunoClient`-shaped path survives.

### 6.6 Trailing slashes are part of the route

See the table at the top of section 3. Running paths through a URL builder that
normalizes slashes will 404 about half the surface, and will also silently flip 404
classification (5.3) between "endpoint moved" and "bad id". Redirects are worse than
404s here: a 307 can drop the POST body and the `Authorization` header.

### 6.7 Feed-by-ids must batch in pairs

Four or more ids in one `ids=` query returns only the first two. A single create returns
two clips, so any multi-generation status check loses clips without the chunking, and any
poll over four ids runs to timeout even after the songs finish.

### 6.8 Two feed endpoints, two shapes

`POST /api/feed/v3` returns an object `{clips, next_cursor, has_more}`.
`GET /api/feed/?ids=` returns a **bare array** of clips. One shared parser breaks on one
of them.

### 6.9 `gpt_description_prompt` no longer exists

Description mode is signalled only by `metadata.create_mode = "inspiration"`, and the
description text goes in the same `prompt` field that carries lyrics in custom mode. Every
older Suno wrapper implies a `gpt_description_prompt` field, and `/api/billing/info/`
still advertises a `max_lengths.gpt_description_prompt` limit, which reinforces the
mistake. Porting that shape yields a request that is rejected or silently treated as
custom mode.

### 6.10 There is no `task` field

The legacy discriminators `task: "cover"` and `task: "vox"` are gone. Cover is
`create_mode: "cover"` plus `cover_clip_id`; persona is just `persona_id` on an otherwise
normal body. Old reference implementations key the whole request off `task`; sending it
adds an unknown field to a strict schema.

### 6.11 Remaster reuses `cover_clip_id`

There is no `remaster_clip_id`. Remaster is `create_mode: "remaster"`, a remaster-namespace
`mv`, and `cover_clip_id` pointing at the original.

### 6.12 Captcha preflight must fail closed

`required` has no default; a payload missing it must throw, and a thrown or errored
preflight means `required = true`. `resp.required ?? false` inverts the safety property,
skips the solver on a malformed response, and burns the create on a captcha-gated account.

### 6.13 HTTP 200 is not success on create

Covered in 3.3 and 5.1 case 10. Repeated because it is the failure mode that costs
credits.

### 6.14 Polling doneness is over requested ids

Covered in 4.3 property 1. The naive `clips.every(isTerminal)` over an empty array
returns `true`; this exact bug shipped once and reported success with nothing generated.

### 6.15 The stale-document divergences

`API_INTELLIGENCE.md` in the reference repo is partly stale. Concretely:

| Claim in the markdown | Reality |
| --- | --- |
| The Clerk session id is found in the JWT `sid` claim | The source only ever reads `exp` from the JWT and gets the session id from `GET /v1/client`. The doc's version also cannot bootstrap: you need a session id to get a JWT. |
| The create body has ~11 keys and a 3-key `metadata` | 22 keys and an 8-key `metadata`. Copying the doc's example omits `transaction_uuid`, `override_fields`, `user_uploaded_images_b64`, the `cover_*`/`artist_*`/`persona_id` placeholders, and `is_max_mode`/`is_mumble`/`user_tier`/`disable_volume_normalization`. It will 422. |
| `GET /api/playlist/me`, `GET /api/trending/` | Neither is in the reference source. `/api/playlist/me` does exist, though: see 3.23 (`LIVE 2026-10-23`). `/api/trending/` was not tried. |
| `POST /api/cover/`, `POST /api/remaster/` as separate endpoints | Both go through `/api/generate/v2-web/`. |
| `POST /api/generate/stems/` | Wrong path; the real one is `POST /api/edit/stems/{id}`. |
| feed/v3 `filters` documented loosely | Omits the camelCase renames `searchText`/`fullSong` and the string-valued `trashed: "False"`. |
| "JWT auto-refreshed by Clerk SDK in browser" | No mention of the 30-minute server-side staleness window, which is the single most expensive lesson here. |
| `/api/c/check` verified on both `studio-api-prod.suno.com` and `studio-api.prod.suno.com` | Only the dash form appears in the source and only the dash form was tested live. See 7.5. |
| Nothing about `/api/gen/trash`, `set_metadata`, `set_visibility`, `aligned_lyrics` | All four are implemented. |

Also stale inside the source itself: a comment in the download path claims it writes both
a title and an artist ID3 frame; only the title frame is ever written.

### 6.16 The `trashed` filter is a capitalised string

`"False"`, not `false`, not `"false"`. Nothing in the response signals that a filter was
ignored; you just get unfiltered or empty results.

### 6.17 Reference-client bugs, summarized

| Area | Bug | How we know |
| --- | --- | --- |
| `title` on the generate path | can still emit `"title": null` when no title is supplied | source read plus the live 422 rule (6.1) |
| `extend` body | rejected with HTTP 400 `Inconsistent task and generation params` | live test 2026-08-17 |
| `stems` response decoding | decodes as a single `Clip`; wrong | live test 2026-08-17: submit and job succeed, display fails |
| doc comment on browser discovery order | says Chrome, Firefox, Safari, Arc, Brave, Edge; the code tries Chrome, Arc, Brave, Firefox, Edge and never Safari | source read |
| `publish` over several ids | aborts on the first failure, leaving earlier ids flipped | source read |

---

## 7. Unresolved

Stated as open questions. None of these has a recommended shape; guessing here is the
failure mode this document exists to prevent.

### 7.1 What is the correct `extend` request body?

**What we know.** Posting the following to `/api/generate/v2-web/` returns HTTP 400 with
the message `Inconsistent task and generation params`:

- `metadata.create_mode = "custom"`
- `continue_clip_id = "<clip id>"`
- `continue_at = <seconds>`
- `title = ""` (a string; the earlier 422 is fixed)
- `prompt` = lyrics or `""`, `tags` = tags or `null`
- every other placeholder at its default (`null` / `""` / `[]`)

**What we do not know.** The server's phrasing says two of the fields it received are
inconsistent with each other, which means the fix is a field combination, not a single
missing key. Candidate directions exist (a different `create_mode`, a resurrected task
discriminator, a required `continued_aligned_prompt`, a required `mv` matching the source
clip's model) but none has any evidence behind it and this document does not endorse any
of them.

**Resolution requires a fresh capture** of a real extend request from the Suno web app.
Until then, do not ship extend.

### 7.2 What does `POST /api/edit/stems/{id}` return?

**What we know.** The request (no body) is accepted, the job runs to completion, and two
new clips appear titled `"<title> - Vocals"` and `"<title> - Instrumental"`. The
reference decodes the response as a single `Clip` and that decode fails.

**What we do not know.** Whether the body is an array of clips, an object wrapping them,
a job envelope with an id to poll, or something else. It was not captured.

**Workaround that is implementable today:** treat the response as opaque, do not fail on
decode, and discover the two clips through `POST /api/feed/v3`.

### 7.3 What is the full clip status vocabulary?

Only `"complete"`, `"error"` and `"streaming"` appear anywhere in the reference. Whether
Suno also emits `"submitted"`, `"queued"`, `"pending"` or others is unknown; no such
literal appears in the source. This is why the terminality predicate must default to
pending rather than enumerate.

### 7.4 Are `cover_start_s` / `cover_end_s` required for cover?

The reference names them as the suspected missing required fields for the cover flow, yet
cover succeeded live today with both `null`. Unknown whether they become required for a
partial-range cover, or whether the web app always sends real values.

### 7.5 Does `studio-api.prod.suno.com` (dot, not dash) exist?

`API_INTELLIGENCE.md` claims the captcha preflight was verified on both spellings. Only
`studio-api-prod.suno.com` appears in the source and only that host was exercised live.
Whether the dot-form is a real alias, a typo in the doc, or a decommissioned host is
unknown.

### 7.6 Persona creation, listing and deletion

Only `GET /api/persona/get-persona-paginated/{id}/?page=0` is implemented. The markdown
sketches a six-step voice-upload pipeline ending in `POST /api/persona/create/` with a
roughly 47 KB body, and explicitly states the request bodies were never captured. Absent,
not wrong: there is nothing to port until someone captures them.

### 7.7 Is remaster's body correct?

The remaster variant is a best-guess port that was never exercised against the live API,
including today. Cover, which shares the same provenance, worked once `title` was fixed,
which is weak positive evidence for remaster but not proof. The remaster model key
namespace (`chirp-flounder` / `chirp-carp` / `chirp-bass`) is also unverified.

### 7.8 Does `captcha_version` ever matter?

Observed value `1`. The reference never branches on it. Whether a future version implies
a different solver, a different sitekey, or a different token field is unknown.

### 7.9 Extraction disagreements that turned out not to be disagreements

Recorded so nobody re-litigates them:

- **`Clip` field optionality.** One extraction rendered `audio_url?: string`, another
  `audio_url: string | null`. Same underlying behaviour (missing key and explicit null
  both decode to null). This document uses the `| null` rendering throughout.
- **`title` default.** Extractions that describe the constructor default as `null` are
  pre-patch text; the source in hand already defaults it to `""`. Version skew, not a
  factual conflict. The remaining live issue is the generate code path (6.1).
- **Poll ordering.** The clip poll fetches first and the lyrics poll sleeps first. Both
  descriptions are correct; they are two different loops and must not be merged.