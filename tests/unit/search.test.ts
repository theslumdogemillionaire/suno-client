import { describe, expect, it } from 'vitest';

import { searchPublic, searchSuggest } from '../../src/api/search.js';
import { searchClips } from '../../src/api/feed.js';
import { abortedSignal, always, callAt, clip, failure, stubClient, type Reply } from './support/harness.js';

function answer(songs: readonly unknown[], extra: Record<string, unknown> = {}): Reply {
  return {
    body: {
      result: {
        tag_song: { total_hits: 5000, result: songs, from_index: 0, page_size: songs.length, tuned_count: 0, ...extra },
      },
    },
  };
}

describe('searchPublic', () => {
  it('sends the one tag_song query suno.com sends', async () => {
    const { client, calls } = stubClient(always(answer([clip('a')])));

    await searchPublic(client, 'piano ballad');

    const call = callAt(calls, 0);
    expect(call.method).toBe('POST');
    expect(call.url.pathname).toBe('/api/search');
    expect(call.headers['authorization']).toMatch(/^Bearer /);
    expect(call.body).toEqual({
      search_queries: [
        {
          name: 'tag_song',
          search_type: 'tag_song',
          term: 'piano ballad',
          from_index: 0,
          size: 20,
          rank_by: 'most_relevant',
          is_public: true,
        },
      ],
    });
  });

  it('passes size, offset and ranking through', async () => {
    const { client, calls } = stubClient(always(answer([])));

    await searchPublic(client, 'x', { size: 1000, fromIndex: 40, rankBy: 'trending' });

    expect(callAt(calls, 0).body).toMatchObject({
      search_queries: [{ size: 1000, from_index: 40, rank_by: 'trending' }],
    });
  });

  it('flattens the nested answer into clips and counts', async () => {
    const { client } = stubClient(always(answer([clip('a'), clip('b')], { from_index: 0, page_size: 2 })));

    const page = await searchPublic(client, 'x');

    expect(page.clips.map((c) => c.id)).toEqual(['a', 'b']);
    expect(page.totalHits).toBe(5000);
    expect(page.fromIndex).toBe(0);
    expect(page.pageSize).toBe(2);
  });

  it('drops a song it cannot read instead of failing the whole page', async () => {
    const { client } = stubClient(always(answer([clip('a'), { title: 'no id' }, clip('b', { created_at: null })])));

    const page = await searchPublic(client, 'x');

    expect(page.clips.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('reads an answer without the tag_song section as no results', async () => {
    const { client } = stubClient(always({ body: { result: {} } }));

    const page = await searchPublic(client, 'x');

    expect(page.clips).toEqual([]);
    expect(page.totalHits).toBeUndefined();
  });

  it('refuses what the server would reject, or answer for nothing, before sending', async () => {
    const { client, calls } = stubClient(always(answer([])));

    for (const attempt of [
      searchPublic(client, '   '),
      searchPublic(client, 'x', { size: 0 }),
      searchPublic(client, 'x', { size: 1001 }),
      searchPublic(client, 'x', { size: 2.5 }),
      searchPublic(client, 'x', { fromIndex: -1 }),
      searchPublic(client, 'x', { rankBy: 'newest' as never }),
    ]) {
      expect((await failure(attempt)).code).toBe('invalid_input');
    }
    expect(calls).toHaveLength(0);
  });

  it('sends nothing once the signal has fired', async () => {
    const { client, calls } = stubClient(always(answer([])));

    expect((await failure(searchPublic(client, 'x', { signal: abortedSignal() }))).retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('is not searchClips, which filters the account library through feed/v3', async () => {
    const { client, calls } = stubClient(always({ body: { clips: [], next_cursor: null } }));

    await searchClips(client, 'x');

    expect(callAt(calls, 0).url.pathname).toBe('/api/feed/v3');
  });
});

describe('searchSuggest', () => {
  const items = [
    { content_id: 'flamenco', content_type: 'genre', content_item: { entity_type: 'genre_schema', genre: 'flamenco', image: 'https://cdn.example/g.jpg' } },
    {
      content_id: 'u1',
      content_type: 'creator_profile',
      match_reason: 'self_name',
      content_item: { user_id: -1, handle: 'example_user', display_name: 'Example', external_user_id: 'u1' },
    },
    {
      content_id: 'p1',
      content_type: 'playlist_shortcut',
      match_reason: 'self_name',
      content_item: { playlist_id: 'p1', playlist_name: 'List', playlist_song_count: 12, playlist_user_handle: 'example_user' },
    },
    { content_id: 'a', content_type: 'clip', match_reason: 'from_matched_genre', content_item: clip('a') },
    { content_id: 'x', content_type: 'something_new', content_item: { any: 1 } },
  ];

  it('sends what the search box sends and types each kind', async () => {
    const { client, calls } = stubClient(always({ body: { feed: { feed_id: 'search_suggest', items } } }));

    const out = await searchSuggest(client, 'flam');

    expect(callAt(calls, 0).url.pathname).toBe('/api/unified/search/suggest');
    expect(callAt(calls, 0).body).toEqual({ term: 'flam', suggestion_size: 5, content_size: 5 });
    expect(out.map((s) => s.kind)).toEqual(['style', 'profile', 'playlist', 'clip', 'other']);
    expect(out[0]).toMatchObject({ kind: 'style', style: 'flamenco' });
    expect(out[1]).toMatchObject({ kind: 'profile', profile: { handle: 'example_user' }, reason: 'self_name' });
    expect(out[2]).toMatchObject({ kind: 'playlist', playlist: { id: 'p1', songCount: 12 } });
    expect(out[3]).toMatchObject({ kind: 'clip', clip: { id: 'a' }, reason: 'from_matched_genre' });
    expect(out[4]).toMatchObject({ kind: 'other', contentType: 'something_new', id: 'x' });
  });

  it('refuses an empty term', async () => {
    const { client, calls } = stubClient(always({ body: {} }));
    expect((await failure(searchSuggest(client, '  '))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});
