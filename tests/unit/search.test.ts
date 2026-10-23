import { describe, expect, it } from 'vitest';

import { searchPublic } from '../../src/api/search.js';
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
