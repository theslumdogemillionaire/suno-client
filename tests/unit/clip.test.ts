import { describe, expect, it } from 'vitest';

import { getClip } from '../../src/api/feed.js';
import { SunoClient, type RequestInfo } from '../../src/client.js';
import { setReaction } from '../../src/api/misc.js';
import { Suno } from '../../src/suno.js';
import { MemoryAuthStore } from '../../src/store.js';
import {
  abortedSignal,
  always,
  callAt,
  clip,
  failure,
  stubClient,
  stubClientOptions,
  type Responder,
} from './support/harness.js';

const ID = '00000000-0000-0000-0000-00000000000a';

const notFound = { status: 404, body: { detail: 'Not found.' } };

describe('getClip', () => {
  it('reads /api/clip/{id} with the session when one is stored', async () => {
    const { client, calls } = stubClient(always({ body: clip(ID, { is_download_unlocked: true }) }));

    const found = await getClip(client, ID);

    expect(callAt(calls, 0).method).toBe('GET');
    expect(callAt(calls, 0).url.pathname).toBe(`/api/clip/${ID}`);
    expect(callAt(calls, 0).headers['authorization']).toMatch(/^Bearer /);
    expect(found.is_download_unlocked).toBe(true);
  });

  it('reads anonymously when no session is stored', async () => {
    const { client, calls } = stubClient(always({ body: clip(ID) }), { signedIn: false });

    expect((await getClip(client, ID)).id).toBe(ID);
    expect(calls).toHaveLength(1);
    expect(callAt(calls, 0).headers['authorization']).toBeUndefined();
  });

  it('reports one exchange to onRequest when signed out, not a failed one first', async () => {
    const { clientOptions } = stubClientOptions(always({ body: clip(ID) }), { signedIn: false });
    const seen: RequestInfo[] = [];
    const client = new SunoClient({ ...clientOptions, onRequest: (info) => seen.push(info) });

    await getClip(client, ID);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe(200);
    expect(seen[0]?.error).toBeUndefined();
  });

  it('does not hide a dead session behind an anonymous read', async () => {
    // A stored cookie Clerk refuses is a session to replace, not a reason to
    // carry on as nobody.
    const { clientOptions, calls } = stubClientOptions(always({ status: 401, body: { errors: [] } }));
    const suno = new Suno({ ...clientOptions, store: new MemoryAuthStore({ clerkClientCookie: 'dead' }) });

    expect((await failure(getClip(suno.client, ID))).code).toBe('auth_dead');
    expect(calls.some((c) => c.url.pathname.startsWith('/api/clip/'))).toBe(false);
  });

  it('reports an unknown id as not_found, without an alert', async () => {
    const { client } = stubClient(always(notFound), { signedIn: false });

    const err = await failure(getClip(client, ID));

    expect(err.code).toBe('not_found');
    expect(err.alert).toBe(false);
  });

  it('encodes the id into its one path segment', async () => {
    const { client, calls } = stubClient(always({ body: clip(ID) }));

    await getClip(client, '../billing/info/#');

    expect(callAt(calls, 0).url.pathname).toBe('/api/clip/..%2Fbilling%2Finfo%2F%23');
  });

  it('sends nothing once the signal has fired', async () => {
    const { client, calls } = stubClient(always({ body: clip(ID) }));

    expect((await failure(getClip(client, ID, abortedSignal()))).retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('Suno.info', () => {
  function facade(respond: Responder, signedIn = true): { suno: Suno; paths: () => string[] } {
    const { clientOptions, calls } = stubClientOptions(respond, { signedIn });
    return { suno: new Suno(clientOptions), paths: () => calls.map((c) => c.url.pathname) };
  }

  it('reads the account clip from feed-by-ids, as before', async () => {
    const { suno, paths } = facade(always({ body: [clip(ID)] }));

    expect((await suno.info(ID)).id).toBe(ID);
    expect(paths()).toEqual(['/api/feed/']);
  });

  it('falls back to the public clip when feed-by-ids does not have it', async () => {
    const { suno, paths } = facade((call) =>
      call.url.pathname === '/api/feed/' ? { body: [] } : { body: clip(ID, { handle: 'example_user' }) },
    );

    expect((await suno.info(ID)).id).toBe(ID);
    expect(paths()).toEqual(['/api/feed/', `/api/clip/${ID}`]);
  });

  it('falls back on a feed-by-ids 404 too', async () => {
    const { suno, paths } = facade((call) => (call.url.pathname === '/api/feed/' ? notFound : { body: clip(ID) }));

    expect((await suno.info(ID)).id).toBe(ID);
    expect(paths()).toEqual(['/api/feed/', `/api/clip/${ID}`]);
  });

  it('works signed out, through the public endpoint alone', async () => {
    const { suno, paths } = facade(always({ body: clip(ID) }), false);

    expect((await suno.info(ID)).id).toBe(ID);
    expect(paths()).toEqual([`/api/clip/${ID}`]);
  });

  it('reports exactly the exchanges it made to onRequest', async () => {
    const { clientOptions } = stubClientOptions(always({ body: clip(ID) }), { signedIn: false });
    const seen: RequestInfo[] = [];
    const suno = new Suno({ ...clientOptions, onRequest: (info) => seen.push(info) });

    await suno.info(ID);

    expect(seen.map((i) => [i.path, i.status, i.error?.code])).toEqual([[`/api/clip/${ID}`, 200, undefined]]);
  });

  it('sends nothing once the signal has fired', async () => {
    const { suno, paths } = facade(always({ body: [clip(ID)] }), false);

    expect((await failure(suno.info(ID, abortedSignal()))).retryable).toBe(false);
    expect(paths()).toEqual([]);
  });

  it('still says not_found when neither endpoint knows the id', async () => {
    const { suno } = facade((call) => (call.url.pathname === '/api/feed/' ? { body: [] } : notFound));

    expect((await failure(suno.info(ID))).code).toBe('not_found');
  });

  it('lets any other feed failure through instead of masking it', async () => {
    const { suno, paths } = facade(always({ status: 429, body: { detail: 'slow down' } }));

    expect((await failure(suno.info(ID))).code).toBe('rate_limited');
    expect(paths()).toEqual(['/api/feed/']);
  });
});

describe('setReaction', () => {
  const liked = { play_count: 0, skip_count: 0, flagged: false, reaction_type: 'L', clip: ID, updated_at: '2026-10-23T00:00:00Z' };

  it('likes with reaction LIKE and unlikes with reaction null', async () => {
    const { reaction_type: _gone, ...cleared } = liked;
    const { client, calls } = stubClient((_call, index) => ({ body: index === 0 ? liked : cleared }));

    const on = await setReaction(client, ID, 'LIKE');
    const off = await setReaction(client, ID, null);

    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['POST', `/api/gen/${ID}/update_reaction_type/`],
      ['POST', `/api/gen/${ID}/update_reaction_type/`],
    ]);
    expect(callAt(calls, 0).body).toEqual({ reaction: 'LIKE' });
    // null on the wire, not an absent key: absent is not what was verified.
    expect(callAt(calls, 1).body).toEqual({ reaction: null });
    expect(on.reaction_type).toBe('L');
    expect(off.reaction_type).toBeUndefined();
  });

  it('is what Suno.like and Suno.unlike send', async () => {
    const { clientOptions, calls } = stubClientOptions(always({ body: liked }));
    const suno = new Suno(clientOptions);

    await suno.like(ID);
    await suno.unlike(ID);

    expect(calls.map((c) => c.body)).toEqual([{ reaction: 'LIKE' }, { reaction: null }]);
  });

  it('needs a session', async () => {
    const { client, calls } = stubClient(always({ body: liked }), { signedIn: false });

    expect((await failure(setReaction(client, ID, 'LIKE'))).code).toBe('auth_missing');
    expect(calls).toHaveLength(0);
  });
});
