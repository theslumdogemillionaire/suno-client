import { mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileAuthStore } from '../../src/store.js';

/**
 * Concurrent saves, with one of them held between its writeFile and its chmod:
 * the window where another save's sweep used to delete its scratch file. Left
 * to timing this failed about one run in six; the gate makes it every run.
 *
 * Its own file because vi.mock is hoisted over the whole module. Everything
 * but the gated chmod is the real filesystem.
 */

const gate = vi.hoisted(() => ({
  hold: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      const hold = gate.hold;
      gate.hold = undefined;
      if (hold !== undefined) await hold(String(args[0]));
      return actual.chmod(...args);
    },
  };
});

/** Parks the next chmod until released; `reached` gives the scratch path. */
function holdNextChmod(): { reached: Promise<string>; release: () => void } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let arrive!: (path: string) => void;
  const reached = new Promise<string>((resolve) => (arrive = resolve));
  gate.hold = async (path) => {
    arrive(path);
    await released;
  };
  return { reached, release };
}

describe('a save racing another save on the same path', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'suno-store-race-'));
  });
  afterEach(async () => {
    gate.hold = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('is not broken by the other save sweeping its scratch file', async () => {
    const store = new FileAuthStore(join(dir, 'auth.json'));
    const held = holdNextChmod();
    const slow = store.save({ clerkClientCookie: 'slow' });
    await held.reached;
    // The slow save's scratch file is on disk and not yet renamed; this save
    // runs its sweep right now.
    await store.save({ clerkClientCookie: 'fast' });
    held.release();
    await expect(slow).resolves.toBeUndefined();
    await expect(store.load()).resolves.toMatchObject({ clerkClientCookie: 'slow' });
    expect(await readdir(dir)).toEqual(['auth.json']);
  });

  it('is spared even once stalled past the age threshold, from another store', async () => {
    // Only the in-flight set protects it here: the age check alone would call
    // it a crashed leftover. A second store on the same path is what the CLI
    // and the client amount to inside one process, and nothing normalises a
    // path taken from SUNO_AUTH_FILE or the command line.
    const path = join(dir, 'auth.json');
    const held = holdNextChmod();
    const slow = new FileAuthStore(`${dir}/./auth.json`).save({ clerkClientCookie: 'slow' });
    const tmp = await held.reached;
    const longAgo = new Date(Date.now() - 10 * 60_000);
    await utimes(tmp, longAgo, longAgo);
    await new FileAuthStore(path).save({ clerkClientCookie: 'fast' });
    held.release();
    await expect(slow).resolves.toBeUndefined();
    expect(await readdir(dir)).toEqual(['auth.json']);
  });
});
