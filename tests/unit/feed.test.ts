import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { getClips, iterateClips, listClips, searchClips } from '../../src/api/feed.js';
import type { FetchLike } from '../../src/auth.js';
import { SunoClient } from '../../src/client.js';
import type { Clip } from '../../src/schemas.js';
import { MemoryAuthStore } from '../../src/store.js';

/**
 * Every test here drives the real SunoClient with a stub transport, so what is
 * asserted is the bytes Suno would actually receive. Paging and batching bugs
 * only show up on the wire: a client that "works" against a mocked feed module
 * can still ask for page one twenty times.
 */

interface RecordedCall {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

type Responder = (call: RecordedCall, index: number) => unknown;

/** A JWT whose only job is to be unexpired, so no auth round trip happens. */
function unexpiredJwt(): string {
  const claims = { exp: Math.floor(Date.now() / 1000) + 7200 };
  return `header.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`;
}

function harness(respond: Responder): { client: SunoClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const fetchImpl: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    const index = calls.length;
    calls.push(call);
    return Promise.resolve(
      new Response(JSON.stringify(respond(call, index)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  const client = new SunoClient({
    fetch: fetchImpl,
    baseUrl: 'https://suno.test',
    store: new MemoryAuthStore({
      clerkClientCookie: 'cookie',
      sessionId: 'sess',
      deviceId: 'dev',
      jwt: unexpiredJwt(),
    }),
    // A stub that answers wrongly should fail the assertion, not spend the
    // suite's budget in jittered backoff first.
    retry: { maxRetries: 0 },
  });

  return { client, calls };
}

function pages(sequence: readonly unknown[]): { client: SunoClient; calls: RecordedCall[] } {
  return harness((_call, index) => sequence[index] ?? { clips: [], next_cursor: null });
}

/** Minimum payload that satisfies ClipSchema; anything less fails validation. */
function clip(id: string): Record<string, unknown> {
  return {
    id,
    title: `title ${id}`,
    status: 'complete',
    model_name: 'chirp-fenix',
    created_at: '2026-08-17T00:00:00Z',
  };
}

function callAt(calls: readonly RecordedCall[], index: number): RecordedCall {
  const call = calls[index];
  if (!call) throw new Error(`expected a request at index ${index}, only ${calls.length} were made`);
  return call;
}

function postBody(calls: readonly RecordedCall[], index: number): Record<string, unknown> {
  const body = callAt(calls, index).body;
  if (!body) throw new Error(`request ${index} carried no JSON body`);
  return body;
}

function idsParam(call: RecordedCall): string | null {
  return new URL(call.url).searchParams.get('ids');
}

async function collectIds(source: AsyncIterable<Clip>): Promise<string[]> {
  const ids: string[] = [];
  for await (const c of source) ids.push(c.id);
  return ids;
}

describe('listClips', () => {
  it('omits the cursor key entirely on the first page', async () => {
    // feed/v3 treats an explicit `cursor: null` as a malformed page request, not
    // as "start from the beginning".
    const { client, calls } = pages([{ clips: [clip('a')], next_cursor: 'c2' }]);

    await listClips(client);

    const body = postBody(calls, 0);
    expect(body).not.toHaveProperty('cursor');
    expect(Object.keys(body)).toEqual(['limit']);
  });

  it('sends the cursor back byte for byte on later pages', async () => {
    const opaque = 'eyJvIjoyMH0=|2026-08-17T00:00:00Z';
    const { client, calls } = pages([{ clips: [], next_cursor: null }]);

    await listClips(client, { cursor: opaque });

    expect(postBody(calls, 0)['cursor']).toBe(opaque);
  });

  it('asks for 20 clips unless told otherwise', async () => {
    const { client, calls } = pages([{ clips: [], next_cursor: null }]);

    await listClips(client);
    await listClips(client, { limit: 100 });

    expect(postBody(calls, 0)['limit']).toBe(20);
    expect(postBody(calls, 1)['limit']).toBe(100);
  });
});

describe('iterateClips', () => {
  it('walks every page and yields the clips in server order', async () => {
    const { client, calls } = pages([
      { clips: [clip('a'), clip('b')], next_cursor: 'c2' },
      { clips: [clip('c')], next_cursor: 'c3' },
      { clips: [clip('d')], next_cursor: null },
    ]);

    expect(await collectIds(iterateClips(client))).toEqual(['a', 'b', 'c', 'd']);
    expect(calls).toHaveLength(3);
    expect(postBody(calls, 0)).not.toHaveProperty('cursor');
    expect(postBody(calls, 1)['cursor']).toBe('c2');
    expect(postBody(calls, 2)['cursor']).toBe('c3');
  });

  it('stops when the next cursor comes back null, after yielding that page', async () => {
    const { client, calls } = pages([
      { clips: [clip('a')], next_cursor: 'c2' },
      { clips: [clip('b')], next_cursor: null },
    ]);

    expect(await collectIds(iterateClips(client))).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
  });

  it('stops when the next cursor comes back as an empty string', async () => {
    // An empty cursor is not a usable page token; echoing it back re-requests
    // page one forever.
    const { client, calls } = pages([{ clips: [clip('a')], next_cursor: '' }]);

    expect(await collectIds(iterateClips(client))).toEqual(['a']);
    expect(calls).toHaveLength(1);
  });

  it('stops on a page with no clips even when the server still offers a cursor', async () => {
    const { client, calls } = pages([
      { clips: [clip('a')], next_cursor: 'c2' },
      { clips: [], next_cursor: 'c3' },
    ]);

    expect(await collectIds(iterateClips(client))).toEqual(['a']);
    expect(calls).toHaveLength(2);
  });

  it('stops when the server echoes back the cursor it was given', async () => {
    // Without this guard a stuck cursor is an infinite loop that re-yields the
    // same page: unbounded memory downstream and a request storm at Suno.
    const { client, calls } = pages([
      { clips: [clip('a')], next_cursor: 'c2' },
      { clips: [clip('b')], next_cursor: 'c2' },
    ]);

    expect(await collectIds(iterateClips(client))).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
  });

  it('keeps paging on has_more false as long as a fresh cursor is offered', async () => {
    // has_more is unreliable and sometimes absent. Terminating on it truncates
    // a library silently, which is far worse than one extra request.
    const { client, calls } = pages([
      { clips: [clip('a')], next_cursor: 'c2', has_more: false },
      { clips: [clip('b')], next_cursor: null, has_more: false },
    ]);

    expect(await collectIds(iterateClips(client))).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
  });

  it('stops at maxPages even when the server keeps offering more', async () => {
    const { client, calls } = harness((_call, index) => ({
      clips: [clip(`p${index}`)],
      // Bounded so a broken cap fails the length assertion instead of hanging.
      next_cursor: index < 50 ? `c${index + 2}` : null,
    }));

    expect(await collectIds(iterateClips(client, { maxPages: 3 }))).toEqual(['p0', 'p1', 'p2']);
    expect(calls).toHaveLength(3);
  });

  it('makes no request at all when maxPages is zero', async () => {
    const { client, calls } = pages([{ clips: [clip('a')], next_cursor: null }]);

    expect(await collectIds(iterateClips(client, { maxPages: 0 }))).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('applies the requested page size to every page, not just the first', async () => {
    const { client, calls } = pages([
      { clips: [clip('a')], next_cursor: 'c2' },
      { clips: [clip('b')], next_cursor: null },
    ]);

    await collectIds(iterateClips(client, { limit: 5 }));

    expect(calls.map((_, i) => postBody(calls, i)['limit'])).toEqual([5, 5]);
  });
});

describe('searchClips', () => {
  it('sends the query as filters.searchText and excludes trash', async () => {
    // `trashed` is the string "False", capital F: the filter is evaluated
    // server-side in Python and a JSON boolean is not the same value.
    const { client, calls } = harness(() => ({ clips: [clip('a')], next_cursor: null }));

    await searchClips(client, 'rainy lo-fi');

    expect(postBody(calls, 0)['filters']).toEqual({ searchText: 'rainy lo-fi', trashed: 'False' });
  });

  it('searches the whole library from the first page, never with a cursor', async () => {
    const { client, calls } = harness(() => ({ clips: [], next_cursor: null }));

    await searchClips(client, 'anything');

    expect(postBody(calls, 0)).not.toHaveProperty('cursor');
    expect(postBody(calls, 0)['limit']).toBe(50);
  });

  it('honours an explicit limit', async () => {
    const { client, calls } = harness(() => ({ clips: [], next_cursor: null }));

    await searchClips(client, 'anything', { limit: 5 });

    expect(postBody(calls, 0)['limit']).toBe(5);
  });
});

describe('getClips', () => {
  const echoRequestedIds: Responder = (call) => (idsParam(call) ?? '').split(',').map(clip);

  it('splits ids into pairs, because larger batches come back truncated', async () => {
    const { client, calls } = harness(echoRequestedIds);

    await getClips(client, ['a', 'b', 'c', 'd', 'e']);

    expect(calls).toHaveLength(3);
    // The comma is percent-encoded on the wire, so read it back through URL
    // rather than matching the raw query string.
    expect(calls.map(idsParam)).toEqual(['a,b', 'c,d', 'e']);
    expect(new URL(callAt(calls, 0).url).pathname).toBe('/api/feed/');
    expect(callAt(calls, 0).method).toBe('GET');
  });

  it('returns the clips of every batch, in the order the ids were asked for', async () => {
    const { client } = harness(echoRequestedIds);

    const clips = await getClips(client, ['a', 'b', 'c', 'd', 'e']);

    expect(clips.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps fetching later batches when an earlier one comes back short', async () => {
    // The exact production failure: Suno drops ids from a batch, and a client
    // that reads a short response as "the rest do not exist" leaves a poller
    // waiting on clips that finished long ago.
    const { client, calls } = harness((call) => {
      const first = (idsParam(call) ?? '').split(',')[0];
      return first === undefined ? [] : [clip(first)];
    });

    const clips = await getClips(client, ['a', 'b', 'c', 'd', 'e']);

    expect(calls).toHaveLength(3);
    expect(clips.map((c) => c.id)).toEqual(['a', 'c', 'e']);
  });

  it('makes no request when given no ids', async () => {
    const { client, calls } = harness(() => []);

    expect(await getClips(client, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('liked clips', () => {
  it('adds the liked filter as capitalised strings, trash excluded', async () => {
    // `{ liked: { presence: "True" } }`, the shape `stem` takes, is accepted
    // and ignored: it returns the whole library.
    const { client, calls } = pages([{ clips: [clip('a')], next_cursor: null }]);

    await listClips(client, { liked: true });

    expect(postBody(calls, 0)).toEqual({ limit: 20, filters: { liked: 'True', trashed: 'False' } });
  });

  it('leaves the plain listing body untouched when liked is false', async () => {
    const { client, calls } = pages([{ clips: [], next_cursor: null }]);

    await listClips(client, { liked: false });

    expect(Object.keys(postBody(calls, 0))).toEqual(['limit']);
  });

  it('keeps the filter on every page while it walks the cursor', async () => {
    const { client, calls } = pages([
      { clips: [clip('a')], next_cursor: 'c2', has_more: true },
      { clips: [clip('b')], next_cursor: null, has_more: false },
    ]);

    expect(await collectIds(iterateClips(client, { liked: true }))).toEqual(['a', 'b']);
    expect(postBody(calls, 0)['filters']).toEqual({ liked: 'True', trashed: 'False' });
    expect(postBody(calls, 1)).toEqual({ limit: 20, cursor: 'c2', filters: { liked: 'True', trashed: 'False' } });
  });
});
