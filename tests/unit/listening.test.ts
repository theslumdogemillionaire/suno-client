import { describe, expect, it } from 'vitest';

import { getPlaybarState, iterateListenHistory, listListenHistory } from '../../src/api/listening.js';
import { always, callAt, clip, collect, failure, inOrder, stubClient } from './support/harness.js';

describe('listen history', () => {
  it('pairs each song with when it was heard, repeats included', async () => {
    const { client, calls } = stubClient(
      always({
        body: {
          history: [
            { content: clip('a'), listened_at: '2026-10-27T10:00:00Z' },
            { content: clip('a'), listened_at: '2026-10-27T09:00:00Z' },
            { content: { broken: true }, listened_at: '2026-10-27T08:00:00Z' },
          ],
          next_cursor: 'n',
          has_more: false,
        },
      }),
    );

    const page = await listListenHistory(client, { limit: 3 });

    expect(callAt(calls, 0).url.pathname).toBe('/api/profiles/listen-history');
    expect(Object.fromEntries(callAt(calls, 0).url.searchParams)).toEqual({ limit: '3' });
    expect(page.listens.map((l) => [l.clip.id, l.listenedAt])).toEqual([
      ['a', '2026-10-27T10:00:00Z'],
      ['a', '2026-10-27T09:00:00Z'],
    ]);
    expect(page.hasMore).toBe(false);
  });

  it('walks pages and keeps a song heard twice', async () => {
    const { client, calls } = stubClient(
      inOrder([
        { body: { history: [{ content: clip('a'), listened_at: 't2' }], next_cursor: 'c', has_more: true } },
        { body: { history: [{ content: clip('a'), listened_at: 't1' }], next_cursor: 'd', has_more: false } },
      ]),
    );
    const listens = await collect(iterateListenHistory(client, { pageSize: 1 }));
    expect(listens.map((l) => l.listenedAt)).toEqual(['t2', 't1']);
    expect(callAt(calls, 1).url.searchParams.get('cursor')).toBe('c');
  });

  it('refuses a limit past what Suno keeps', async () => {
    const { client } = stubClient(always({ body: {} }));
    expect((await failure(listListenHistory(client, { limit: 101 }))).code).toBe('invalid_input');
  });
});

describe('getPlaybarState', () => {
  it('reads the player state', async () => {
    const { client } = stubClient(
      always({
        body: {
          playbar_state: 'paused',
          song_index: 1,
          song_play_time: 45.3,
          repeat_state: 'no-repeat',
          song_ids_in_queue: ['a', 'b'],
          volume: 100,
          device_type: 'Mac',
        },
      }),
    );
    const state = await getPlaybarState(client);
    expect(state.song_ids_in_queue[state.song_index ?? 0]).toBe('b');
    expect(state.song_play_time).toBe(45.3);
  });
});
