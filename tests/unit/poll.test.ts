import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { getClips } from '../../src/api/feed.js';
import { SunoClient } from '../../src/client.js';
import { SunoError } from '../../src/errors.js';
import { allTerminal, GenerationJob, pendingIds, type JobUpdate } from '../../src/poll.js';
import type { Clip } from '../../src/schemas.js';
import { MemoryAuthStore } from '../../src/store.js';

interface ClipOverrides {
  audio_url?: string | null;
  image_url?: string | null;
  metadata?: Clip['metadata'];
}

function makeClip(id: string, status: string, over: ClipOverrides = {}): Clip {
  return {
    id,
    title: `song ${id}`,
    status,
    model_name: 'chirp-fenix',
    created_at: '2026-08-17T00:00:00Z',
    audio_url: over.audio_url ?? null,
    image_url: over.image_url ?? null,
    ...(over.metadata ? { metadata: over.metadata } : {}),
  };
}

/**
 * A JWT the client will accept without calling Clerk. `isJwtExpired` treats
 * anything with under 30 minutes of life left as expired, so an hour of headroom
 * is what keeps these tests off the network entirely.
 */
function unexpiredJwt(): string {
  const claims = { exp: Math.floor(Date.now() / 1000) + 3600 };
  return `e30.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`;
}

interface FeedStub {
  fetch: typeof fetch;
  requests: URL[];
}

/** Serves `responses` in order, then repeats the last one for any further poll. */
function feedStub(responses: readonly unknown[]): FeedStub {
  const requests: URL[] = [];
  let index = 0;

  const impl: typeof fetch = (input) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(new URL(href));
    const body = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  return { fetch: impl, requests };
}

function makeClient(fetchImpl: typeof fetch): SunoClient {
  return new SunoClient({
    fetch: fetchImpl,
    store: new MemoryAuthStore({ clerkClientCookie: 'test-cookie', jwt: unexpiredJwt() }),
    baseUrl: 'https://suno.test',
    retry: { maxRetries: 0 },
  });
}

const offlineClient = (): SunoClient =>
  makeClient(() => {
    throw new Error('this test must not touch the network');
  });

const FAST: { intervalMs: number; timeoutMs: number } = { intervalMs: 1, timeoutMs: 2000 };

describe('allTerminal', () => {
  it('reports an empty feed as unfinished rather than as success', () => {
    // The reference client asked `clips.every(isTerminal)` over the RETURNED
    // clips, so a feed that returned nothing read as "all done" and it announced
    // a successful generation that had produced no audio at all.
    expect(allTerminal(['a'], [])).toBe(false);
  });

  it('reports an id missing from the feed as unfinished even when the rest are done', () => {
    expect(allTerminal(['a', 'b'], [makeClip('a', 'complete')])).toBe(false);
  });

  it('treats error as a finished state', () => {
    // Waiting for `complete` specifically never returns for a moderation
    // rejection: the clip stays in `error` until the timeout fires.
    expect(allTerminal(['a'], [makeClip('a', 'error')])).toBe(true);
  });

  it('treats a batch that half succeeded and half failed as finished', () => {
    expect(
      allTerminal(['a', 'b'], [makeClip('a', 'complete'), makeClip('b', 'error')]),
    ).toBe(true);
  });

  it('keeps waiting on a status it has never seen before', () => {
    expect(allTerminal(['a'], [makeClip('a', 'queued')])).toBe(false);
    expect(allTerminal(['a'], [makeClip('a', 'some_future_suno_state')])).toBe(false);
  });

  it('does not let clips it never asked for stand in for the ones it did', () => {
    expect(allTerminal(['a'], [makeClip('somebody-elses-clip', 'complete')])).toBe(false);
  });

  it('ignores extra clips the feed volunteers alongside the requested ones', () => {
    expect(
      allTerminal(['a'], [makeClip('a', 'complete'), makeClip('neighbour', 'streaming')]),
    ).toBe(true);
  });

  it('is finished when nothing was requested', () => {
    expect(allTerminal([], [])).toBe(true);
  });
});

describe('pendingIds', () => {
  it('lists ids the feed never returned', () => {
    expect(pendingIds(['a', 'b', 'c'], [makeClip('a', 'complete')])).toEqual(['b', 'c']);
  });

  it('lists ids still in flight and drops the ones that failed', () => {
    expect(
      pendingIds(['a', 'b'], [makeClip('a', 'error'), makeClip('b', 'streaming')]),
    ).toEqual(['b']);
  });

  it('returns nothing once every requested id is terminal', () => {
    expect(pendingIds(['a', 'b'], [makeClip('a', 'complete'), makeClip('b', 'error')])).toEqual([]);
  });
});

describe('GenerationJob.watch', () => {
  it('yields one update per status change and stops polling once every clip is terminal', async () => {
    const stub = feedStub([
      [makeClip('a', 'streaming')],
      // Same status, new artwork: a consumer should not be told anything here.
      [makeClip('a', 'streaming', { image_url: 'https://cdn.test/a.jpg' })],
      [makeClip('a', 'complete', { audio_url: 'https://cdn.test/a.mp3' })],
    ]);
    const job = new GenerationJob(makeClient(stub.fetch), [makeClip('a', 'submitted')]);

    const seen: JobUpdate[] = [];
    for await (const update of job.watch(FAST)) seen.push(update);

    expect(seen.map((u) => u.clips[0]?.status)).toEqual(['streaming', 'complete']);
    expect(seen.map((u) => u.changed.map((c) => c.id))).toEqual([['a'], ['a']]);
    expect(seen.map((u) => u.done)).toEqual([false, true]);
    expect(stub.requests).toHaveLength(3);
  });

  it('stops on a clip that failed instead of waiting for it to turn complete', async () => {
    const stub = feedStub([
      [makeClip('a', 'error', { metadata: { error_message: 'Prompt likely malformed' } })],
    ]);
    const job = new GenerationJob(makeClient(stub.fetch), [makeClip('a', 'submitted')]);

    const seen: JobUpdate[] = [];
    for await (const update of job.watch(FAST)) seen.push(update);

    expect(seen.at(-1)?.done).toBe(true);
    expect(stub.requests).toHaveLength(1);
  });

  it('polls again for an id the feed left out rather than declaring the batch done', async () => {
    const stub = feedStub([
      [makeClip('a', 'complete', { audio_url: 'https://cdn.test/a.mp3' })],
      [
        makeClip('a', 'complete', { audio_url: 'https://cdn.test/a.mp3' }),
        makeClip('b', 'complete', { audio_url: 'https://cdn.test/b.mp3' }),
      ],
    ]);
    const job = new GenerationJob(makeClient(stub.fetch), [
      makeClip('a', 'submitted'),
      makeClip('b', 'submitted'),
    ]);

    const seen: JobUpdate[] = [];
    for await (const update of job.watch(FAST)) seen.push(update);

    expect(seen.map((u) => u.done)).toEqual([false, true]);
    expect(seen.at(-1)?.clips.map((c) => c.id)).toEqual(['a', 'b']);
  });

});

describe('GenerationJob.wait', () => {
  it('resolves with the newest clips, not the ones the job was constructed with', async () => {
    const stub = feedStub([
      [makeClip('a', 'streaming')],
      [makeClip('a', 'complete', { audio_url: 'https://cdn.test/a.mp3' })],
    ]);
    const job = new GenerationJob(makeClient(stub.fetch), [makeClip('a', 'submitted')]);

    const clips = await job.wait(FAST);

    expect(clips.map((c) => c.status)).toEqual(['complete']);
    expect(clips[0]?.audio_url).toBe('https://cdn.test/a.mp3');
    expect(job.clips).toEqual(clips);
  });

  it('times out instead of resolving when the feed never returns the clip at all', async () => {
    // An empty feed is the shape that made the reference client report success
    // having generated nothing. It must reach the timeout, not resolve.
    const stub = feedStub([[]]);
    const job = new GenerationJob(makeClient(stub.fetch), [makeClip('a', 'submitted')]);

    let error: unknown;
    try {
      await job.wait({ intervalMs: 1, timeoutMs: 5 });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SunoError);
    expect((error as SunoError).code).toBe('timeout');
  });

  it('names only the still-pending ids when it times out', async () => {
    const stub = feedStub([[makeClip('clip-done', 'complete')]]);
    const job = new GenerationJob(makeClient(stub.fetch), [
      makeClip('clip-done', 'submitted'),
      makeClip('clip-missing', 'submitted'),
    ]);

    let error: unknown;
    try {
      await job.wait({ intervalMs: 1, timeoutMs: 5 });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SunoError);
    const suno = error as SunoError;
    expect(suno.code).toBe('timeout');
    expect(suno.message).toContain('clip-missing');
    expect(suno.message).not.toContain('clip-done');
    expect(suno.message).toContain('1 of 2');
  });

  it('keeps the last observed clips readable after a timeout', async () => {
    const stub = feedStub([[makeClip('a', 'streaming')]]);
    const job = new GenerationJob(makeClient(stub.fetch), [
      makeClip('a', 'submitted'),
      makeClip('b', 'submitted'),
    ]);

    await job.wait({ intervalMs: 1, timeoutMs: 5 }).catch(() => undefined);

    expect(job.clips.map((c) => c.status)).toEqual(['streaming']);
  });
});

describe('GenerationJob result getters', () => {
  it('splits a half-failed batch into completed and failed', async () => {
    const stub = feedStub([
      [
        makeClip('ok', 'complete', { audio_url: 'https://cdn.test/ok.mp3' }),
        makeClip('bad', 'error', { metadata: { error_message: 'Prompt likely malformed' } }),
      ],
    ]);
    const job = new GenerationJob(makeClient(stub.fetch), [
      makeClip('ok', 'submitted'),
      makeClip('bad', 'submitted'),
    ]);

    await job.wait(FAST);

    expect(job.completed.map((c) => c.id)).toEqual(['ok']);
    expect(job.failed.map((f) => f.clip.id)).toEqual(['bad']);
    expect(job.failed[0]?.reason).toBe('Prompt likely malformed');
  });

  it('surfaces the error type when Suno attaches no message', () => {
    const job = new GenerationJob(offlineClient(), [
      makeClip('a', 'error', { metadata: { error_type: 'moderation' } }),
    ]);

    expect(job.failed[0]?.reason).toBe('moderation');
  });

  it('still gives a reason for a failure carrying no detail at all', () => {
    const job = new GenerationJob(offlineClient(), [makeClip('a', 'error')]);

    expect(job.failed).toHaveLength(1);
    expect(job.failed[0]?.reason).toMatch(/no detail/i);
  });

  it('counts an in-flight clip as neither completed nor failed', () => {
    const job = new GenerationJob(offlineClient(), [
      makeClip('a', 'streaming'),
      makeClip('b', 'submitted'),
    ]);

    expect(job.completed).toEqual([]);
    expect(job.failed).toEqual([]);
  });

  it('exposes the last known state without hitting the network', () => {
    const job = new GenerationJob(offlineClient(), [makeClip('a', 'submitted')]);

    expect(job.ids).toEqual(['a']);
    expect(job.clips.map((c) => c.status)).toEqual(['submitted']);
  });
});

describe('GenerationJob.refresh', () => {
  it('replaces the last known state with one fresh look at the feed', async () => {
    const stub = feedStub([[makeClip('a', 'complete', { audio_url: 'https://cdn.test/a.mp3' })]]);
    const job = new GenerationJob(makeClient(stub.fetch), [makeClip('a', 'submitted')]);

    const clips = await job.refresh();

    expect(clips.map((c) => c.status)).toEqual(['complete']);
    expect(job.completed.map((c) => c.id)).toEqual(['a']);
    expect(stub.requests).toHaveLength(1);
  });
});

describe('getClips', () => {
  it('asks for ids two at a time, because the feed silently truncates larger batches', async () => {
    // Asking for 4+ ids spanning different generation batches returns only the
    // first two, so the poller waits forever on clips that already finished.
    const stub = feedStub([
      [makeClip('a', 'complete'), makeClip('b', 'complete')],
      [makeClip('c', 'complete'), makeClip('d', 'complete')],
      [makeClip('e', 'complete')],
    ]);

    const clips = await getClips(makeClient(stub.fetch), ['a', 'b', 'c', 'd', 'e']);

    expect(stub.requests.map((u) => u.searchParams.get('ids'))).toEqual(['a,b', 'c,d', 'e']);
    expect(clips.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('makes no request at all when there is nothing to look up', async () => {
    const stub = feedStub([[]]);

    expect(await getClips(makeClient(stub.fetch), [])).toEqual([]);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('clip parsing during a poll', () => {
  it('polls to completion through fields the schema has never heard of', async () => {
    // Suno adds response fields regularly; a strict schema would turn each
    // addition into an outage for every running job.
    const stub = feedStub([
      [
        {
          id: 'a',
          title: 'song a',
          status: 'complete',
          model_name: 'chirp-something-new',
          created_at: '2026-08-17T00:00:00Z',
          audio_url: 'https://cdn.test/a.mp3',
          brand_new_field: { nested: true },
        },
      ],
    ]);
    const job = new GenerationJob(makeClient(stub.fetch), [makeClip('a', 'submitted')]);

    const clips = await job.wait(FAST);

    expect(clips[0]?.status).toBe('complete');
    expect(clips[0]?.['brand_new_field']).toEqual({ nested: true });
  });

  it('tolerates a queued clip with no audio url yet', async () => {
    const stub = feedStub([
      [{ ...makeClip('a', 'submitted'), audio_url: null }],
      [makeClip('a', 'complete', { audio_url: 'https://cdn.test/a.mp3' })],
    ]);
    const job = new GenerationJob(makeClient(stub.fetch), [makeClip('a', 'submitted')]);

    const clips = await job.wait(FAST);

    expect(clips[0]?.audio_url).toBe('https://cdn.test/a.mp3');
  });
});
