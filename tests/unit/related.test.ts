import { describe, expect, it } from 'vitest';

import {
  iterateRemixes,
  listRemixes,
  parentClip,
  remixCount,
  remixSources,
  similarClips,
} from '../../src/api/related.js';
import { always, callAt, clip, collect, failure, inOrder, stubClient } from './support/harness.js';

const ID = '00000000-0000-0000-0000-000000000001';

describe('similarClips', () => {
  it('asks by id and keeps the clips that parse', async () => {
    const { client, calls } = stubClient(always({ body: { similar_clips: [clip('a'), { no: 'id' }, clip('b')] } }));

    const clips = await similarClips(client, ID);

    expect(callAt(calls, 0).url.pathname).toBe('/api/clips/get_similar');
    expect(callAt(calls, 0).url.searchParams.get('id')).toBe(ID);
    expect(callAt(calls, 0).headers['authorization']).toMatch(/^Bearer /);
    expect(clips.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('refuses an empty id without a request', async () => {
    const { client, calls } = stubClient(always({ body: {} }));
    expect((await failure(similarClips(client, ' '))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});

describe('remixes', () => {
  it('sends clip_id and limit, and the cursor only after page one', async () => {
    const { client, calls } = stubClient(
      inOrder([
        { body: { remixes: [clip('a'), clip('b')], has_more: true, next_cursor: 'c1' } },
        { body: { remixes: [clip('c')], has_more: false, next_cursor: null } },
      ]),
    );

    const clips = await collect(iterateRemixes(client, ID, { pageSize: 2 }));

    expect(clips.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(Object.fromEntries(callAt(calls, 0).url.searchParams)).toEqual({ clip_id: ID, limit: '2' });
    expect(callAt(calls, 1).url.searchParams.get('cursor')).toBe('c1');
  });

  it('stops on a repeated cursor', async () => {
    const { client, calls } = stubClient(
      inOrder([
        { body: { remixes: [clip('a')], has_more: true, next_cursor: 'same' } },
        { body: { remixes: [clip('b')], has_more: true, next_cursor: 'same' } },
        { body: { remixes: [clip('z')], has_more: true, next_cursor: 'same' } },
      ]),
    );
    expect((await collect(iterateRemixes(client, ID))).map((c) => c.id)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(2);
  });

  it('reads one page', async () => {
    const { client } = stubClient(always({ body: { remixes: [clip('a')], has_more: false } }));
    expect(await listRemixes(client, ID)).toEqual({ clips: [expect.objectContaining({ id: 'a' })], hasMore: false, nextCursor: undefined });
  });

  it('counts them', async () => {
    const { client, calls } = stubClient(always({ body: { count: 55, is_capped: false } }));
    expect(await remixCount(client, ID)).toEqual({ count: 55, capped: false });
    expect(callAt(calls, 0).url.pathname).toBe('/api/clips/remixes/count');
  });
});

describe('remixSources', () => {
  const source = {
    relationship: 'AG',
    clip_id: 'src',
    is_deleted: false,
    user: { user_id: 'u', user_display_name: 'Example', user_handle: 'example_user', user_avatar_url: null },
    title: 'Source',
    image_url: 'https://cdn.example/i.jpg',
    audio_url: 'https://cdn.example/a.mp3',
  };

  it('reads the attribution of a clip', async () => {
    const { client, calls } = stubClient(always({ body: { source_clips: [source] } }));
    const sources = await remixSources(client, ID);
    expect(callAt(calls, 0).url.pathname).toBe(`/api/clips/${ID}/attribution`);
    expect(sources[0]?.clip_id).toBe('src');
    expect(sources[0]?.user?.user_handle).toBe('example_user');
  });

  it('goes out anonymous without a session', async () => {
    const { client, calls } = stubClient(always({ body: { source_clips: [] } }), { signedIn: false });
    expect(await remixSources(client, ID)).toEqual([]);
    expect(callAt(calls, 0).headers['authorization']).toBeUndefined();
  });
});

describe('parentClip', () => {
  it('returns the public parent', async () => {
    const { client, calls } = stubClient(
      always({ body: { id: 'p', title: 'Parent', is_public: true, user_handle: 'example_user' } }),
    );
    expect((await parentClip(client, ID))?.id).toBe('p');
    expect(callAt(calls, 0).url.searchParams.get('clip_id')).toBe(ID);
  });

  it('reads an answer without id as no parent', async () => {
    const { client } = stubClient(always({ body: { is_public: false, user_handle: 'example_user' } }));
    expect(await parentClip(client, ID)).toBeUndefined();
  });
});
