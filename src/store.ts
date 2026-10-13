import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import type { AuthState } from './auth.js';
import { SunoError } from './errors.js';

/**
 * Where the session lives between processes.
 *
 * This holds a ~7 day credential for a paid account, so the file is written
 * 0600 and written atomically: a half-flushed auth.json after a crash would
 * look like a corrupt session and send the caller chasing a phantom auth bug.
 */
export interface AuthStore {
  load(): Promise<AuthState | undefined>;
  save(state: AuthState): Promise<void>;
  clear(): Promise<void>;
}

export function defaultAuthPath(): string {
  const fromEnv = process.env['SUNO_AUTH_FILE'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const xdg = process.env['XDG_CONFIG_HOME'];
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'suno-client', 'auth.json');
}

/**
 * Scratch files a save in this process is still writing. The sweep must never
 * touch these: the client refreshes its JWT from several call sites, so one
 * save's sweep routinely runs while another save sits between writeFile and
 * rename. Module-wide, because the CLI and the client each build their own
 * store on the same path. Keyed by resolved path: a SUNO_AUTH_FILE spelled
 * `./auth.json` must still match the name the sweep rebuilds from readdir.
 */
const inFlightTemps = new Set<string>();

/**
 * How old a scratch file must be before the sweep treats it as a crashed
 * save's leftover. The age check is what protects other processes' saves,
 * which the in-flight set cannot see; a real save spends milliseconds there.
 */
const STALE_TEMP_MS = 60_000;

export class FileAuthStore implements AuthStore {
  constructor(private readonly path: string = defaultAuthPath()) {}

  async load(): Promise<AuthState | undefined> {
    try {
      const raw = await readFile(this.path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AuthState>;
      if (typeof parsed.clerkClientCookie !== 'string' || parsed.clerkClientCookie === '') {
        return undefined;
      }
      return {
        clerkClientCookie: parsed.clerkClientCookie,
        jwt: typeof parsed.jwt === 'string' ? parsed.jwt : undefined,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
        deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : undefined,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new SunoError({
        code: 'invalid_input',
        message: `could not read auth file at ${this.path}`,
        cause: err,
      });
    }
  }

  async save(state: AuthState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Unique scratch name per save. A fixed `.tmp` collides when two saves race
    // (the client refreshes its JWT from several call sites): both write the
    // same file, the first rename consumes it, and the second fails ENOENT.
    const tmp = `${this.path}.${randomUUID()}.tmp`;
    inFlightTemps.add(resolve(tmp));
    try {
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    } finally {
      inFlightTemps.delete(resolve(tmp));
    }
    // Unique names mean a crashed save leaves its scratch file behind forever,
    // and each one holds a session cookie. Sweep them on the next successful
    // save rather than accumulating credentials in the config directory.
    await this.sweepStaleTemps();
  }

  private async sweepStaleTemps(): Promise<void> {
    const dir = dirname(this.path);
    const prefix = `${basename(this.path)}.`;
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
        .map((name) => join(dir, name))
        .filter((tmp) => !inFlightTemps.has(resolve(tmp)))
        .map(async (tmp) => {
          // A young temp may be another process's save between writeFile and
          // rename; deleting it would fail that save with ENOENT.
          const info = await stat(tmp).catch(() => undefined);
          if (info === undefined || Date.now() - info.mtimeMs < STALE_TEMP_MS) return;
          await unlink(tmp).catch(() => undefined);
        }),
    );
  }

  async clear(): Promise<void> {
    await unlink(this.path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

/** For tests and for callers who would rather hold the session in memory. */
export class MemoryAuthStore implements AuthStore {
  constructor(private state: AuthState | undefined = undefined) {}
  load(): Promise<AuthState | undefined> {
    return Promise.resolve(this.state);
  }
  save(state: AuthState): Promise<void> {
    this.state = state;
    return Promise.resolve();
  }
  clear(): Promise<void> {
    this.state = undefined;
    return Promise.resolve();
  }
}
