/**
 * Lifting the Suno session cookie out of a local browser profile.
 *
 * The alternative this replaces is six manual steps — open suno.com, open
 * devtools, Application, Cookies, find `__client` on `auth.suno.com`, copy the
 * value without catching the surrounding quotes — performed on a laptop, at the
 * moment the session dies, which is reliably the moment nobody wants to be
 * doing it. The cookie is already on the machine. This reads it.
 *
 * Scope, deliberately narrow: the caller's own browser profile, on the caller's
 * own machine, for one named cookie on one named host. Nothing here can reach a
 * cookie for another site, and nothing here touches the network.
 *
 * What it costs on macOS is one Keychain prompt, and that prompt is a feature:
 * it is the operating system asking the human whether this program may read
 * that particular secret, which is exactly the question that should be asked. A
 * `--from-browser` that ran silently would be worse, not better.
 */
import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

import { SunoError } from './errors.js';

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

/** The cookie that IS the session. Everything else Clerk sets is derived from it. */
export const SESSION_COOKIE_NAME = '__client';
/** Clerk serves the session cookie from the auth subdomain, never from suno.com. */
export const SESSION_COOKIE_HOST = 'auth.suno.com';
/**
 * Segment's anonymous id, which is what the client sends as `device-id`.
 *
 * Lifted alongside the session because the alternative is worse than it looks.
 * `normalizeCookieInput` only finds a device id in a full `Cookie:` header, so
 * handing it a bare `__client` stores `deviceId: undefined` — and the client
 * then falls back to a UUID generated fresh in every process. The header
 * comments call that out as the single most obvious fingerprint there is, and
 * an import that quietly caused it would be undoing the work on the way in.
 * Taking the browser's own value is also more faithful than preserving ours.
 */
export const DEVICE_COOKIE_NAME = 'ajs_anonymous_id';

export type BrowserName = 'chrome' | 'brave' | 'edge' | 'chromium';

interface BrowserSpec {
  label: string;
  /** Profile roots, most likely first. */
  macDirs: string[];
  linuxDirs: string[];
  /** Keychain service and account, macOS only. */
  keychainService: string;
  keychainAccount: string;
}

const BROWSERS: Record<BrowserName, BrowserSpec> = {
  chrome: {
    label: 'Google Chrome',
    macDirs: ['Library/Application Support/Google/Chrome'],
    linuxDirs: ['.config/google-chrome'],
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
  },
  brave: {
    label: 'Brave',
    macDirs: ['Library/Application Support/BraveSoftware/Brave-Browser'],
    linuxDirs: ['.config/BraveSoftware/Brave-Browser'],
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave',
  },
  edge: {
    label: 'Microsoft Edge',
    macDirs: ['Library/Application Support/Microsoft Edge'],
    linuxDirs: ['.config/microsoft-edge'],
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
  },
  chromium: {
    label: 'Chromium',
    macDirs: ['Library/Application Support/Chromium'],
    linuxDirs: ['.config/chromium'],
    keychainService: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
  },
};

export const BROWSER_NAMES = Object.keys(BROWSERS) as BrowserName[];

export interface FoundCookie {
  value: string;
  browser: BrowserName;
  /** Profile directory name, e.g. `Default` or `Profile 6`. */
  profile: string;
  /** Cookie expiry, so a caller can warn before it lapses. */
  expiresAt: Date | undefined;
  /**
   * Clerk client this cookie belongs to, from its own payload.
   *
   * The only thing that distinguishes two sessions found on one machine, and
   * therefore the only safe basis for choosing between them. Undefined when the
   * payload does not carry one.
   */
  clientId: string | undefined;
  /**
   * `Cookie:` header form, carrying the device id when the profile had one.
   *
   * Hand THIS to `login`, not `value`: it is the shape `normalizeCookieInput`
   * can read a device id out of.
   */
  cookieHeader: string;
}

/**
 * The Clerk client a `__client` cookie belongs to.
 *
 * `__client` is itself a JWT, and its payload carries
 * `suno.com/claims/client_id`. Reading it costs nothing and turns "two cookies"
 * into "two cookies, and here is whether they are the same account".
 */
export function clientIdOf(cookie: string): string | undefined {
  const payload = cookie.split('.')[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null) return undefined;
    const id = (claims as Record<string, unknown>)['suno.com/claims/client_id'];
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    return undefined;
  }
}

function profileRoot(browser: BrowserName): string | undefined {
  const spec = BROWSERS[browser];
  const dirs = process.platform === 'darwin' ? spec.macDirs : spec.linuxDirs;
  for (const dir of dirs) {
    const full = join(homedir(), dir);
    if (existsSync(full)) return full;
  }
  return undefined;
}

/**
 * Profiles that actually hold a cookie DB, `Default` first.
 *
 * Order matters more than it looks: a browser with eight profiles usually has
 * the session in exactly one of them, and the person running this does not
 * necessarily know which. Searching all of them and reporting which one
 * answered is the difference between "it works" and "it works once you pass the
 * right --profile".
 */
function profileDirs(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'Guest Profile' || entry.name === 'System Profile') continue;
    if (existsSync(join(root, entry.name, 'Cookies'))) found.push(entry.name);
  }
  return found.sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : a.localeCompare(b)));
}

/**
 * The AES key the browser encrypts cookies with.
 *
 * macOS keeps the passphrase in the login Keychain, and asking for it is what
 * raises the prompt. Linux Chromium either uses the same scheme with the
 * literal passphrase `peanuts` (v10) or defers to libsecret/kwallet (v11) —
 * only the first is handled here, and a v11 profile is reported as such rather
 * than handed back as a garbage decrypt.
 */
async function encryptionKey(browser: BrowserName): Promise<Buffer> {
  const spec = BROWSERS[browser];
  if (process.platform === 'darwin') {
    let password: string;
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-w',
        '-s',
        spec.keychainService,
        '-a',
        spec.keychainAccount,
      ]);
      password = stdout.trim();
    } catch {
      throw new SunoError({
        code: 'auth_missing',
        message:
          `could not read "${spec.keychainService}" from the Keychain. ` +
          'Approve the prompt macOS raises, or run `security find-generic-password -w -s ' +
          `"${spec.keychainService}" -a "${spec.keychainAccount}"` +
          '` once by hand to see what it says.',
      });
    }
    if (password === '') {
      throw new SunoError({
        code: 'auth_missing',
        message: `the Keychain returned an empty "${spec.keychainService}" password; is ${spec.label} installed?`,
      });
    }
    // 1003 iterations is Chromium's constant on macOS, not a tunable.
    return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  }
  if (process.platform === 'linux') {
    return pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  }
  throw new SunoError({
    code: 'invalid_input',
    message:
      `reading browser cookies is implemented for macOS and Linux, not ${process.platform}. ` +
      'Paste the cookie instead: suno-client login --stdin',
  });
}

/**
 * Clerk's `__client` is a JWT: three base64url segments with dots between.
 *
 * This is the first half of the discriminator (see `isJwt`), and it has to key
 * on the value's structure rather than on a "does this
 * look like text" heuristic, for a reason that is measurable. Chrome 127+ puts
 * a 32-byte SHA-256 of the domain in front of the value, and those bytes are
 * effectively random. A "no control characters" test accepts such a prefix
 * 2.18% of the time - measured over 200k hashes - and when it does, the decode
 * returns hash-plus-cookie: login sends it, Suno answers 401, and the error
 * blames the session. That is the exact misdiagnosis this module exists to
 * prevent, except it would happen one time in fifty and never reproduce on
 * demand.
 */
const JWT_SHAPED = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;

/**
 * A JWT whose header actually decodes, not merely something JWT-shaped.
 *
 * The shape alone is not enough, and the test that proves it is the realistic
 * one: 32 printable bytes glued in front of a real token still match the
 * pattern, because `[A-Za-z0-9_-]{8,}` happily swallows the prefix AND the
 * first segment before reaching the dot. The prefix would then travel with the
 * cookie and the session would look dead.
 *
 * Decoding settles it. A JWT's first segment is base64url of a JSON header, so
 * it begins with `{` once decoded; a hash with a token behind it does not, at
 * any offset. Cheap, and it cannot be fooled by a lucky prefix.
 */
function isJwt(value: string): boolean {
  if (!JWT_SHAPED.test(value)) return false;
  const header = value.slice(0, value.indexOf('.'));
  try {
    return Buffer.from(header, 'base64url').toString('utf8').trimStart().startsWith('{');
  } catch {
    return false;
  }
}

/**
 * Strict printable ASCII, and strict on purpose.
 *
 * The fallback for the day Clerk stops issuing a JWT-shaped cookie. Bytes at or
 * above 0x80 have to fail: `toString('utf8')` renders them as U+FFFD, which is
 * not a control character, so a permissive test waves random binary straight
 * through. Held to 0x20-0x7e, a 32-byte random prefix passes 0 times in 200k.
 */
function isPrintableAscii(value: string): boolean {
  return value !== '' && /^[\x20-\x7e]+$/.test(value);
}

/**
 * Choose between "the value" and "the value behind a 32-byte domain hash".
 *
 * Known shape first, on both candidates, before falling back to printability on
 * both. That order is what makes the choice deterministic: a lucky hash can
 * look like text, but it cannot look like the first two segments of a JWT, so
 * the real cookie wins whichever side of the prefix it is on.
 */
function pickPlaintext(plain: Buffer): string | undefined {
  const direct = plain.toString('utf8');
  const stripped = plain.length > 32 ? plain.subarray(32).toString('utf8') : '';

  if (isJwt(direct)) return direct;
  if (isJwt(stripped)) return stripped;

  // Neither is JWT-shaped: either Clerk changed the format, or this is not the
  // cookie we think it is. Accept a candidate only when it is unambiguously
  // text and the other is not, so a coin flip never decides what gets sent.
  const directOk = isPrintableAscii(direct);
  const strippedOk = isPrintableAscii(stripped);
  if (directOk && !strippedOk) return direct;
  if (strippedOk && !directOk) return stripped;
  return undefined;
}

/**
 * Undo Chromium's cookie encryption.
 *
 * Two details are load-bearing and both stay invisible until they bite. Padding
 * is stripped by hand because Node's automatic unpadding throws on the profiles
 * where the last block is not PKCS#7 — a throw that reads as "wrong key" and
 * sends you looking in the wrong place entirely. And since Chrome 127 the
 * plaintext carries a 32-byte SHA-256 of the domain in front of the value, so a
 * decrypt that "succeeded" still begins with 32 bytes of binary; the test that
 * matters is whether the result is printable, not whether the cipher threw.
 */
export function decryptValue(blob: Buffer, key: Buffer): string | undefined {
  if (blob.length <= 3) return undefined;
  const version = blob.subarray(0, 3).toString('latin1');
  if (version !== 'v10' && version !== 'v11') {
    // Not encrypted at all; some profiles keep the value in the clear. Held to
    // the same shape test, so three unlucky leading bytes cannot promote a blob
    // we failed to recognise into a "cookie".
    const plain = blob.toString('utf8');
    return isJwt(plain) || isPrintableAscii(plain) ? plain : undefined;
  }
  const iv = Buffer.alloc(16, ' ');
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  } catch {
    return undefined;
  }
  const pad = plain[plain.length - 1];
  if (pad !== undefined && pad >= 1 && pad <= 16) plain = plain.subarray(0, plain.length - pad);

  return pickPlaintext(plain);
}

interface CookieRow {
  value: Buffer;
  expiresUtc: number;
}

/**
 * Read the one cookie out of a profile's SQLite file.
 *
 * The file is copied first, and not out of politeness: a running browser holds
 * it open, and reading it in place returns SQLITE_BUSY at exactly the moment
 * someone is most likely to try this — browser open, having just signed in.
 */
function readCookieRows(cookiesPath: string, name: string): CookieRow[] {
  const scratch = mkdtempSync(join(tmpdir(), 'suno-cookie-'));
  const copy = join(scratch, 'Cookies');
  try {
    copyFileSync(cookiesPath, copy);
    // Chromium may still have uncommitted pages in a WAL sidecar.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(`${cookiesPath}${suffix}`)) copyFileSync(`${cookiesPath}${suffix}`, `${copy}${suffix}`);
    }
    // node:sqlite rather than a dependency or a spawned `sqlite3`: the first
    // would be a runtime dep carried by every install for one query, the second
    // is not present on every machine this runs on. Required lazily so that
    // importing this module never costs anything on a Node without it.
    const { DatabaseSync } = requireFromHere('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      // `cast(... as real)` is not decoration. Chromium stores expiry as
      // microseconds since 1601, which for any date after 1885 exceeds
      // Number.MAX_SAFE_INTEGER — node:sqlite then throws
      // `RangeError: Value is too large to be represented as a JavaScript
      // number` on the whole row, encrypted value included, for every profile.
      // Reading it as a double costs a microsecond of precision on a value only
      // ever used to build a Date, and costs nothing else.
      // Matched on the name across every suno host rather than on one exact
      // host_key: `__client` sits on `auth.suno.com` while the device id sits
      // on `.suno.com`, leading dot included, and hard-coding either spelling
      // is a silent miss the day Clerk moves a subdomain.
      const rows = db
        .prepare(
          'select encrypted_value, cast(expires_utc as real) as expires_utc ' +
            "from cookies where name = ? and (host_key = 'suno.com' or host_key like '%.suno.com')",
        )
        .all(name) as unknown as Array<{ encrypted_value: Uint8Array; expires_utc: number | bigint }>;
      return rows.map((row) => ({
        value: Buffer.from(row.encrypted_value),
        expiresUtc: Number(row.expires_utc),
      }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Chromium counts microseconds from 1601-01-01. Zero means a session cookie. */
export function chromeTime(value: number): Date | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value / 1000 - 11644473600000);
}

export interface FindCookieOptions {
  /** Restrict the search. Default: every supported browser, in listed order. */
  browsers?: readonly BrowserName[];
  /** Restrict to one profile directory name, e.g. `Default`. */
  profile?: string;
}

/**
 * The Suno session cookie, from wherever on this machine it is.
 *
 * Returns every match rather than the first, because a machine with the account
 * open in two profiles has two valid cookies and picking one silently is how a
 * bot ends up posting as the wrong account. The caller decides; the CLI takes
 * the one that expires last.
 */
export async function findSessionCookies(options: FindCookieOptions = {}): Promise<FoundCookie[]> {
  const wanted = options.browsers ?? BROWSER_NAMES;
  const found: FoundCookie[] = [];
  const errors: string[] = [];

  for (const browser of wanted) {
    const root = profileRoot(browser);
    if (root === undefined) continue;
    const profiles = profileDirs(root).filter((p) => options.profile === undefined || p === options.profile);
    if (profiles.length === 0) continue;

    let key: Buffer;
    try {
      key = await encryptionKey(browser);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      continue;
    }

    for (const profile of profiles) {
      let rows: CookieRow[];
      try {
        rows = readCookieRows(join(root, profile, 'Cookies'), SESSION_COOKIE_NAME);
      } catch (err) {
        // Recorded, never swallowed. A bare `continue` here is what turned a
        // RangeError on every single profile into "found 0 sessions" with no
        // error and nothing to look at — the same failure shape as the
        // audio_url sentinel: a guard that hides the cause it was meant to
        // report.
        errors.push(`${browser}/${profile}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // Best-effort: a missing device id costs a less stable fingerprint, never
      // the login, so it must not be able to fail the import.
      let deviceId: string | undefined;
      try {
        for (const row of readCookieRows(join(root, profile, 'Cookies'), DEVICE_COOKIE_NAME)) {
          const decoded = decryptValue(row.value, key);
          if (decoded !== undefined && decoded !== '') {
            deviceId = decoded;
            break;
          }
        }
      } catch {
        deviceId = undefined;
      }

      for (const row of rows) {
        const value = decryptValue(row.value, key);
        if (value === undefined || value === '') {
          errors.push(`${browser}/${profile}: found a ${SESSION_COOKIE_NAME} cookie but could not decode it`);
          continue;
        }
        const cookieHeader =
          deviceId === undefined
            ? `${SESSION_COOKIE_NAME}=${value}`
            : `${SESSION_COOKIE_NAME}=${value}; ${DEVICE_COOKIE_NAME}=${deviceId}`;
        found.push({
          value,
          cookieHeader,
          browser,
          profile,
          expiresAt: chromeTime(row.expiresUtc),
          clientId: clientIdOf(value),
        });
      }
    }
  }

  // Only surface a key failure when nothing at all was found. A Keychain that
  // refuses for Brave must not bury a cookie that Chrome handed over.
  if (found.length === 0 && errors.length > 0) {
    throw new SunoError({ code: 'auth_missing', message: errors.join('; ') });
  }
  return found;
}

/** The single best candidate: the one that stays valid longest. */
export function preferLongestLived(cookies: readonly FoundCookie[]): FoundCookie | undefined {
  return [...cookies].sort((a, b) => (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0))[0];
}

export type CookieChoice =
  | { kind: 'one'; cookie: FoundCookie }
  | { kind: 'none' }
  /** Several different Clerk clients. Refusing beats guessing. */
  | { kind: 'ambiguous'; candidates: readonly FoundCookie[] };

/**
 * Pick a cookie, or decline to.
 *
 * Expiry is NOT a safe tiebreak between accounts, and this machine is the proof:
 * two Chrome profiles, two different Clerk clients, cookies expiring seven
 * seconds apart. "Longest-lived" happened to land on the right one. Eight
 * seconds the other way and `--from-browser` would have signed a stream bot in
 * as the wrong account, silently, with everything still appearing to work.
 *
 * So expiry only ever breaks ties WITHIN one client. Across clients:
 *
 *   - if a session is already stored, the matching client wins outright — that
 *     is the reconnect case, and it is unambiguous by construction;
 *   - otherwise the caller is asked which one, and told how to say so.
 */
export function chooseCookie(
  cookies: readonly FoundCookie[],
  options: { knownClientId?: string | undefined } = {},
): CookieChoice {
  if (cookies.length === 0) return { kind: 'none' };

  const known = options.knownClientId;
  if (known !== undefined) {
    const mine = cookies.filter((c) => c.clientId === known);
    const best = preferLongestLived(mine);
    if (best !== undefined) return { kind: 'one', cookie: best };
  }

  const clients = new Set(cookies.map((c) => c.clientId ?? 'unknown'));
  if (clients.size > 1) return { kind: 'ambiguous', candidates: cookies };

  const only = preferLongestLived(cookies);
  return only === undefined ? { kind: 'none' } : { kind: 'one', cookie: only };
}
