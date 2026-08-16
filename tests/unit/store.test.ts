import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AuthState } from '../../src/auth.js';
import { SunoError } from '../../src/errors.js';
import { FileAuthStore, MemoryAuthStore, defaultAuthPath, type AuthStore } from '../../src/store.js';

/**
 * These tests hit a real temp directory rather than a mocked fs on purpose:
 * the properties that matter here (0600, atomic replace, ENOENT tolerance) are
 * properties of the filesystem, and a mock would happily agree with a version
 * of save() that leaves the credential world-readable.
 */

const SESSION: AuthState = {
  clerkClientCookie: 'eyJ__client__value',
  jwt: 'header.payload.signature',
  sessionId: 'sess_2abc',
  deviceId: 'dev_9xyz',
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'suno-store-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function authPath(): string {
  return join(dir, 'auth.json');
}

async function permissions(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** Resolves with the rejection reason, or fails the test if there wasn't one. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the promise to reject, but it resolved');
    },
    (err: unknown) => err,
  );
}

describe.each<[string, () => AuthStore]>([
  ['FileAuthStore', (): AuthStore => new FileAuthStore(authPath())],
  ['MemoryAuthStore', (): AuthStore => new MemoryAuthStore()],
])('%s (shared AuthStore contract)', (_name, create) => {
  it('has no session before anything has been saved', async () => {
    await expect(create().load()).resolves.toBeUndefined();
  });

  it('gives back the session that was saved', async () => {
    const store = create();
    await store.save(SESSION);
    await expect(store.load()).resolves.toEqual(SESSION);
  });

  it('keeps only the most recent session when saved twice', async () => {
    const store = create();
    await store.save(SESSION);
    await store.save({ ...SESSION, clerkClientCookie: 'rotated', jwt: 'fresh.jwt.token' });
    const loaded = await store.load();
    expect(loaded?.clerkClientCookie).toBe('rotated');
    expect(loaded?.jwt).toBe('fresh.jwt.token');
  });

  it('has no session after clear', async () => {
    const store = create();
    await store.save(SESSION);
    await store.clear();
    await expect(store.load()).resolves.toBeUndefined();
  });
});

describe('FileAuthStore', () => {
  it('lets a second process read the session the first one wrote', async () => {
    await new FileAuthStore(authPath()).save(SESSION);
    await expect(new FileAuthStore(authPath()).load()).resolves.toEqual(SESSION);
  });

  it('reports no session when the file has never been written', async () => {
    await expect(new FileAuthStore(join(dir, 'never-written.json')).load()).resolves.toBeUndefined();
  });

  it('reports no session when the whole config directory is missing', async () => {
    // First run on a fresh machine: ENOENT lands on the directory, not the
    // file. Callers branch on undefined to trigger a login, so this must not
    // surface as an error.
    await expect(new FileAuthStore(join(dir, 'a', 'b', 'auth.json')).load()).resolves.toBeUndefined();
  });

  it('reports no session when the file has no clerkClientCookie', async () => {
    await writeFile(authPath(), JSON.stringify({ jwt: 'stale.jwt.token', sessionId: 'sess_2abc' }));
    await expect(new FileAuthStore(authPath()).load()).resolves.toBeUndefined();
  });

  it('reports no session when clerkClientCookie is an empty string', async () => {
    // A JWT without the cookie behind it is useless: it expires within the
    // hour and there is nothing left to mint a new one from.
    await writeFile(authPath(), JSON.stringify({ clerkClientCookie: '', jwt: 'still.here.though' }));
    await expect(new FileAuthStore(authPath()).load()).resolves.toBeUndefined();
  });

  it('reports no session when the file holds a JSON array instead of an object', async () => {
    await writeFile(authPath(), '[]');
    await expect(new FileAuthStore(authPath()).load()).resolves.toBeUndefined();
  });

  it('drops non-string fields but keeps the cookie they were sitting next to', async () => {
    await writeFile(
      authPath(),
      JSON.stringify({ clerkClientCookie: 'good-cookie', jwt: 42, sessionId: null, deviceId: {} }),
    );
    const loaded = await new FileAuthStore(authPath()).load();
    expect(loaded?.clerkClientCookie).toBe('good-cookie');
    expect(loaded?.jwt).toBeUndefined();
    expect(loaded?.sessionId).toBeUndefined();
    expect(loaded?.deviceId).toBeUndefined();
  });

  it('raises a SunoError naming the file when the JSON is corrupt', async () => {
    await writeFile(authPath(), '{"clerkClientCookie": "trunca');
    const err = await rejection(new FileAuthStore(authPath()).load());
    expect(err).toBeInstanceOf(SunoError);
    expect((err as SunoError).code).toBe('invalid_input');
    // The operator has to go delete this file by hand, so the path has to be in
    // the message, and a worker must not sit in a retry loop over it.
    expect((err as SunoError).message).toContain(authPath());
    expect((err as SunoError).retryable).toBe(false);
    expect((err as SunoError).cause).toBeInstanceOf(SyntaxError);
  });

  it('raises a SunoError rather than a TypeError when the file holds JSON null', async () => {
    // `null` parses fine, so this one escapes the JSON.parse guard and blows up
    // on the property read instead. Same file, same fix, so it must surface the
    // same way to the caller.
    await writeFile(authPath(), 'null');
    const err = await rejection(new FileAuthStore(authPath()).load());
    expect(err).toBeInstanceOf(SunoError);
    expect((err as SunoError).code).toBe('invalid_input');
  });

  it('writes the credential file readable only by its owner', async () => {
    await new FileAuthStore(authPath()).save(SESSION);
    expect(await permissions(authPath())).toBe(0o600);
  });

  it('tightens the permissions of an auth file that was left world-readable', async () => {
    // The explicit chmod inside save() is what makes this hold: writeFile's
    // mode is filtered through the umask and skipped entirely for a file that
    // already exists, so a 0644 file from an older version would otherwise stay
    // 0644 forever.
    await writeFile(authPath(), '{}');
    await chmod(authPath(), 0o644);
    await new FileAuthStore(authPath()).save(SESSION);
    expect(await permissions(authPath())).toBe(0o600);
  });

  it('creates the containing directory reachable only by its owner', async () => {
    const nested = join(dir, 'cfg', 'suno-client', 'auth.json');
    await new FileAuthStore(nested).save(SESSION);
    expect(await permissions(join(dir, 'cfg', 'suno-client'))).toBe(0o700);
  });

  it('leaves no temporary file behind after a successful save', async () => {
    await new FileAuthStore(authPath()).save(SESSION);
    // A stray auth.json.tmp is a second, forgotten copy of a paid credential.
    expect(await readdir(dir)).toEqual(['auth.json']);
  });

  it('still loads the previous session when a crashed save left a stale temp file', async () => {
    const store = new FileAuthStore(authPath());
    await store.save(SESSION);
    await writeFile(`${authPath()}.tmp`, '{"clerkClientCookie": "half-writ');
    await expect(store.load()).resolves.toEqual(SESSION);
  });

  it('overwrites a stale temp file instead of failing the next save', async () => {
    const store = new FileAuthStore(authPath());
    await writeFile(`${authPath()}.tmp`, 'garbage from a killed process');
    await store.save(SESSION);
    await expect(store.load()).resolves.toEqual(SESSION);
    expect(await readdir(dir)).toEqual(['auth.json']);
  });

  it('never leaves a partially written file in place of a good session', async () => {
    const store = new FileAuthStore(authPath());
    await store.save(SESSION);
    await store.save({ ...SESSION, clerkClientCookie: 'rotated' });
    const raw = await readFile(authPath(), 'utf8');
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
    expect(raw).not.toContain(SESSION.clerkClientCookie);
  });

  it('deletes the file from disk on clear', async () => {
    await new FileAuthStore(authPath()).save(SESSION);
    await new FileAuthStore(authPath()).clear();
    expect(await readdir(dir)).toEqual([]);
  });

  it('treats clearing an already-absent session as success', async () => {
    // Logout has to be idempotent: a caller that clears twice, or clears before
    // ever logging in, must not see an ENOENT.
    const store = new FileAuthStore(authPath());
    await store.save(SESSION);
    await store.clear();
    await expect(store.clear()).resolves.toBeUndefined();
  });

  it('treats clearing when the config directory is missing as success', async () => {
    await expect(new FileAuthStore(join(dir, 'gone', 'auth.json')).clear()).resolves.toBeUndefined();
  });
});

describe('MemoryAuthStore', () => {
  it('starts from the session handed to its constructor', async () => {
    await expect(new MemoryAuthStore(SESSION).load()).resolves.toEqual(SESSION);
  });

  it('hands back the very object it was given, which FileAuthStore cannot do', async () => {
    // Worth knowing when this store stands in for the file one in a test: a
    // caller that mutates the state it loaded silently mutates the store here,
    // while against FileAuthStore the same mutation is lost at the JSON
    // boundary. Tests pass, production drops the field.
    const store = new MemoryAuthStore();
    await store.save(SESSION);
    expect(await store.load()).toBe(SESSION);
  });

  it('does not share a session with another instance, unlike FileAuthStore', async () => {
    // The mirror of the cross-process test above: swapping this store in means
    // giving up persistence, so a second SunoClient starts logged out.
    const first = new MemoryAuthStore();
    await first.save(SESSION);
    await expect(new MemoryAuthStore().load()).resolves.toBeUndefined();
  });
});

describe('defaultAuthPath', () => {
  let savedAuthFile: string | undefined;
  let savedXdg: string | undefined;

  function restore(key: string, value: string | undefined): void {
    // Assigning undefined would set the literal string "undefined", which is a
    // perfectly valid path as far as this function is concerned.
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(() => {
    savedAuthFile = process.env['SUNO_AUTH_FILE'];
    savedXdg = process.env['XDG_CONFIG_HOME'];
    delete process.env['SUNO_AUTH_FILE'];
    delete process.env['XDG_CONFIG_HOME'];
  });

  afterEach(() => {
    restore('SUNO_AUTH_FILE', savedAuthFile);
    restore('XDG_CONFIG_HOME', savedXdg);
  });

  it('uses SUNO_AUTH_FILE verbatim when it is set', () => {
    process.env['SUNO_AUTH_FILE'] = join(dir, 'somewhere', 'else.json');
    expect(defaultAuthPath()).toBe(join(dir, 'somewhere', 'else.json'));
  });

  it('lets SUNO_AUTH_FILE win over XDG_CONFIG_HOME', () => {
    process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg');
    process.env['SUNO_AUTH_FILE'] = join(dir, 'explicit.json');
    expect(defaultAuthPath()).toBe(join(dir, 'explicit.json'));
  });

  it('ignores an empty SUNO_AUTH_FILE instead of writing to the current directory', () => {
    // An unset variable in a shell script or a docker -e with no value both
    // arrive as ''; honouring it would put the credential at './'.
    process.env['SUNO_AUTH_FILE'] = '';
    process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg');
    expect(defaultAuthPath()).toBe(join(dir, 'xdg', 'suno-client', 'auth.json'));
  });

  it('puts the file under XDG_CONFIG_HOME when no explicit path is given', () => {
    process.env['XDG_CONFIG_HOME'] = join(dir, 'xdg');
    expect(defaultAuthPath()).toBe(join(dir, 'xdg', 'suno-client', 'auth.json'));
  });

  it('ignores an empty XDG_CONFIG_HOME and falls back to the home directory', () => {
    process.env['XDG_CONFIG_HOME'] = '';
    expect(defaultAuthPath()).toBe(join(homedir(), '.config', 'suno-client', 'auth.json'));
  });

  it('falls back to ~/.config when neither variable is set', () => {
    expect(defaultAuthPath()).toBe(join(homedir(), '.config', 'suno-client', 'auth.json'));
  });
});
