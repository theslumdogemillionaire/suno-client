import { describe, expect, it } from 'vitest';

import {
  addPlaylistClips,
  createPlaylist,
  extractPlaylistId,
  getPlaylist,
  iterateMyPlaylists,
  listMyPlaylists,
  removePlaylistClips,
  setPlaylistMetadata,
  setPlaylistTrashed,
} from '../../src/api/playlist.js';
import type { FetchLike } from '../../src/auth.js';
import { SunoClient } from '../../src/client.js';
import { MemoryAuthStore } from '../../src/store.js';
import { Suno } from '../../src/suno.js';
import { always, callAt, collect, failure, inOrder, stubClient, stubClientOptions } from './support/harness.js';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function headerMap(init: Parameters<FetchLike>[1]): Record<string, string> {
  const raw = init?.headers;
  if (raw === undefined || raw === null) return {};
  if (Array.isArray(raw)) return Object.fromEntries(raw as Array<[string, string]>);
  return { ...(raw as unknown as Record<string, string>) };
}

function anonymousClient(pages: readonly unknown[]): { client: SunoClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const call: RecordedCall = {
      url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? 'GET',
      headers: headerMap(init),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    const index = calls.length;
    calls.push(call);
    const body = pages[index] ?? { playlist_clips: [], num_total_results: 0 };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  return {
    client: new SunoClient({
      fetch: fetchImpl,
      baseUrl: 'https://suno.test',
      store: new MemoryAuthStore(),
      retry: { maxRetries: 0 },
    }),
    calls,
  };
}

function clip(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `title ${id}`,
    status: 'complete',
    model_name: 'chirp-fenix',
    created_at: '2026-10-13T00:00:00Z',
    media_urls: [{ url: `https://cdn.example/${id}.m4a`, content_type: 'm4a-opus', delivery: 'progressive' }],
    ...extra,
  };
}

describe('extractPlaylistId', () => {
  it('accepts a share URL, a URL with junk around it, and a bare uuid', () => {
    expect(extractPlaylistId(`https://suno.com/playlist/${PID}`)).toBe(PID);
    expect(extractPlaylistId(`https://www.suno.com/playlist/${PID}?foo=1`)).toBe(PID);
    expect(extractPlaylistId(`  ${PID.toUpperCase()}  `)).toBe(PID);
  });

  it('rejects anything that is not a playlist id', () => {
    expect(() => extractPlaylistId('https://suno.com/song/' + PID)).toThrow(/not a Suno playlist/);
    expect(() => extractPlaylistId('not-an-id')).toThrow(/not a Suno playlist/);
  });
});

describe('getPlaylist', () => {
  it('walks pages without a session and keeps playlist order', async () => {
    const { client, calls } = anonymousClient([
      {
        id: PID,
        name: 'Night Drive',
        user_handle: 'bob',
        num_total_results: 3,
        playlist_clips: [
          { relative_index: 2, clip: clip('c2') },
          { relative_index: 1, clip: clip('c1') },
        ],
      },
      {
        id: PID,
        name: 'Night Drive',
        num_total_results: 3,
        playlist_clips: [{ relative_index: 3, clip: clip('c3') }],
      },
    ]);

    const pl = await getPlaylist(client, `https://suno.com/playlist/${PID}`);
    expect(pl.name).toBe('Night Drive');
    expect(pl.userHandle).toBe('bob');
    expect(pl.clips.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(`https://suno.test/api/playlist/${PID}?page=1`);
    expect(calls[1]?.url).toBe(`https://suno.test/api/playlist/${PID}?page=2`);
    expect(calls[0]?.headers['authorization']).toBeUndefined();
  });

  it('does not ask for a cookie when none is stored', async () => {
    const { client } = anonymousClient([{ id: PID, name: 'Empty', playlist_clips: [], num_total_results: 0 }]);
    const pl = await getPlaylist(client, PID);
    expect(pl.clips).toEqual([]);
  });

  it('skips duplicate ids and still accepts a clip missing created_at', async () => {
    const { client } = anonymousClient([
      {
        id: PID,
        name: 'Mix',
        num_total_results: 2,
        playlist_clips: [
          { relative_index: 1, clip: clip('c1') },
          { relative_index: 1, clip: clip('c1') },
          {
            relative_index: 2,
            clip: {
              id: 'c2',
              title: 'loose',
              status: 'complete',
              model_name: 'chirp-fenix',
              media_urls: [{ url: 'https://cdn.example/c2.m4a', content_type: 'm4a-opus', delivery: 'progressive' }],
            },
          },
        ],
      },
    ]);
    const pl = await getPlaylist(client, PID);
    expect(pl.clips.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(pl.clips[1]?.created_at).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('playlist entries', () => {
  it('keep the relative_index Suno sent, fractional ones included, alongside clips', async () => {
    const { client } = anonymousClient([
      {
        id: PID,
        name: 'Mix',
        num_total_results: 3,
        playlist_clips: [
          { relative_index: 2, clip: clip('c2') },
          { relative_index: 1.5, clip: clip('c15') },
          { clip: clip('c3') },
        ],
      },
    ]);

    const pl = await getPlaylist(client, PID);

    expect(pl.clips.map((c) => c.id)).toEqual(['c15', 'c2', 'c3']);
    expect(pl.entries.map((e) => [e.clipId, e.relativeIndex])).toEqual([
      ['c15', 1.5],
      ['c2', 2],
      // Ordered by a fallback, but never handed out as an index Suno knows.
      ['c3', undefined],
    ]);
    expect(pl.entries.map((e) => e.clip)).toEqual(pl.clips);
  });

  it('are read with the session when asked, for a playlist that is not public', async () => {
    const { client, calls } = stubClient(always({ body: { id: PID, name: 'Mine', num_total_results: 0, playlist_clips: [] } }));

    await getPlaylist(client, PID, { signedIn: true });
    await getPlaylist(client, PID);

    expect(callAt(calls, 0).headers['authorization']).toMatch(/^Bearer /);
    expect(callAt(calls, 1).headers['authorization']).toBeUndefined();
  });

  it('are read through the facade with options, or with a bare signal as before', async () => {
    const { clientOptions, calls } = stubClientOptions(always({ body: { id: PID, name: 'Mine', num_total_results: 0, playlist_clips: [] } }));
    const suno = new Suno(clientOptions);

    await suno.playlist(PID, { signedIn: true });
    await suno.playlist(PID, new AbortController().signal);
    await suno.playlist(PID);

    expect(callAt(calls, 0).headers['authorization']).toMatch(/^Bearer /);
    expect(callAt(calls, 1).headers['authorization']).toBeUndefined();
    expect(callAt(calls, 2).headers['authorization']).toBeUndefined();
  });
});

function summary(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entity_type: 'playlist_schema',
    id,
    name: `playlist ${id}`,
    description: '',
    image_url: 'https://cdn.example/p.jpg',
    is_owned: true,
    is_public: false,
    is_trashed: false,
    num_total_results: 0,
    playlist_clips: [],
    ...extra,
  };
}

const PID2 = '00000000-0000-0000-0000-000000000002';

describe('listMyPlaylists and iterateMyPlaylists', () => {
  it('ask for page N of the account playlists, trash and share lists left out', async () => {
    const { client, calls } = stubClient(always({ body: { num_total_results: 1, current_page: 1, playlists: [summary(PID)] } }));

    const page = await listMyPlaylists(client);

    const url = callAt(calls, 0).url;
    expect(url.pathname).toBe('/api/playlist/me');
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: '1', show_trashed: 'false', show_sharelist: 'false' });
    expect(callAt(calls, 0).headers['authorization']).toMatch(/^Bearer /);
    expect(page.playlists.map((p) => p.id)).toEqual([PID]);
  });

  it('stop at the reported total without asking for an empty page', async () => {
    const { client, calls } = stubClient(
      inOrder([{ body: { num_total_results: 2, playlists: [summary(PID), summary(PID2)] } }]),
    );

    expect((await collect(iterateMyPlaylists(client))).map((p) => p.id)).toEqual([PID, PID2]);
    expect(calls).toHaveLength(1);
  });

  it('stop on an empty page when no total is reported', async () => {
    const { client, calls } = stubClient(
      inOrder([{ body: { playlists: [summary(PID)] } }, { body: { playlists: [] } }]),
    );

    expect(await collect(iterateMyPlaylists(client))).toHaveLength(1);
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
  });
});

describe('createPlaylist', () => {
  it('posts the name alone and returns the new playlist', async () => {
    const { client, calls } = stubClient(always({ body: summary(PID, { name: 'Night Drive' }) }));

    const created = await createPlaylist(client, 'Night Drive');

    expect(callAt(calls, 0).method).toBe('POST');
    expect(callAt(calls, 0).url.pathname).toBe('/api/playlist/create/');
    expect(callAt(calls, 0).body).toEqual({ name: 'Night Drive' });
    expect(created.id).toBe(PID);
    expect(created.is_public).toBe(false);
  });

  it('refuses an empty name, which the server would turn into "Untitled"', async () => {
    const { client, calls } = stubClient(always({ body: summary(PID) }));

    expect((await failure(createPlaylist(client, ''))).code).toBe('invalid_input');
    expect((await failure(createPlaylist(client, '  \n'))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('is never retried, so a slow answer cannot make two playlists', async () => {
    const { client, calls } = stubClient(always({ status: 502, body: { detail: 'bad gateway' } }), { maxRetries: 3 });

    expect((await failure(createPlaylist(client, 'x'))).code).toBe('api_error');
    expect(calls).toHaveLength(1);
  });
});

describe('addPlaylistClips', () => {
  it('sends a flat update_clips body, never wrapped in spec', async () => {
    const { client, calls } = stubClient(always({ status: 204 }));

    await addPlaylistClips(client, `https://suno.com/playlist/${PID}`, ['c1', 'c2']);

    expect(callAt(calls, 0).url.pathname).toBe('/api/playlist/update_clips/');
    expect(callAt(calls, 0).body).toEqual({
      playlist_id: PID,
      update_type: 'add',
      metadata: { clip_ids: ['c1', 'c2'] },
    });
  });

  it('refuses no clips, an empty id, or something that is not a playlist', async () => {
    const { client, calls } = stubClient(always({ status: 204 }));

    expect((await failure(addPlaylistClips(client, PID, []))).code).toBe('invalid_input');
    expect((await failure(addPlaylistClips(client, PID, ['c1', '']))).code).toBe('invalid_input');
    expect((await failure(addPlaylistClips(client, 'not-a-playlist', ['c1']))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('is never retried, so a replay cannot add the clips twice', async () => {
    const { client, calls } = stubClient(always({ status: 503, body: { detail: 'unavailable' } }), { maxRetries: 3 });

    await failure(addPlaylistClips(client, PID, ['c1']));

    expect(calls).toHaveLength(1);
  });
});

describe('removePlaylistClips', () => {
  it('sends each clip with its relative_index, which Suno requires', async () => {
    const { client, calls } = stubClient(always({ status: 204 }));

    await removePlaylistClips(client, PID, [
      { clipId: 'c1', relativeIndex: 1 },
      { clipId: 'c2', relativeIndex: 2.5 },
    ]);

    expect(callAt(calls, 0).body).toEqual({
      playlist_id: PID,
      update_type: 'remove',
      metadata: { clip_ids: ['c1', 'c2'], indexes: [1, 2.5] },
    });
  });

  it('refuses an entry without an index rather than guess one', async () => {
    const { client, calls } = stubClient(always({ status: 204 }));

    const err = await failure(removePlaylistClips(client, PID, [{ clipId: 'c1', relativeIndex: undefined }]));

    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('c1');
    expect((await failure(removePlaylistClips(client, PID, []))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('takes the entries getPlaylist returns as they are', async () => {
    const { client, calls } = stubClient(
      inOrder([
        { body: { id: PID, name: 'Mine', num_total_results: 1, playlist_clips: [{ relative_index: 7, clip: clip('c7') }] } },
        { status: 204 },
      ]),
    );

    const pl = await getPlaylist(client, PID, { signedIn: true });
    await removePlaylistClips(client, PID, pl.entries);

    expect(callAt(calls, 1).body).toMatchObject({ metadata: { clip_ids: ['c7'], indexes: [7] } });
  });
});

describe('setPlaylistMetadata', () => {
  it('sends name and description together, as the server requires', async () => {
    const { client, calls } = stubClient(always({ body: summary(PID, { name: 'Renamed', description: 'late' }) }));

    const updated = await setPlaylistMetadata(client, PID, { name: 'Renamed', description: 'late' });

    expect(callAt(calls, 0).url.pathname).toBe('/api/playlist/set_metadata/');
    expect(callAt(calls, 0).body).toEqual({ playlist_id: PID, name: 'Renamed', description: 'late' });
    expect(updated.name).toBe('Renamed');
  });

  it('refuses an empty name or a missing description before a 422 can page anyone', async () => {
    const { client, calls } = stubClient(always({ body: summary(PID) }));

    expect((await failure(setPlaylistMetadata(client, PID, { name: ' ', description: '' }))).code).toBe('invalid_input');
    expect(
      (await failure(setPlaylistMetadata(client, PID, { name: 'x' } as unknown as { name: string; description: string })))
        .code,
    ).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});

describe('setPlaylistTrashed', () => {
  it('says undo_trash false to trash and true to restore', async () => {
    const { client, calls } = stubClient(always({ status: 204 }));

    await setPlaylistTrashed(client, PID, true);
    await setPlaylistTrashed(client, PID, false);

    expect(calls.map((c) => c.url.pathname)).toEqual(['/api/playlist/trash/', '/api/playlist/trash/']);
    expect(callAt(calls, 0).body).toEqual({ playlist_id: PID, undo_trash: false });
    expect(callAt(calls, 1).body).toEqual({ playlist_id: PID, undo_trash: true });
  });
});

describe('Suno.removeFromPlaylist', () => {
  it('reads the playlist with the session to find each clip, then removes by index', async () => {
    const { clientOptions, calls } = stubClientOptions(
      inOrder([
        {
          body: {
            id: PID,
            name: 'Mine',
            num_total_results: 2,
            playlist_clips: [
              { relative_index: 1, clip: clip('c1') },
              { relative_index: 2, clip: clip('c2') },
            ],
          },
        },
        { status: 204 },
      ]),
    );
    const suno = new Suno(clientOptions);

    await suno.removeFromPlaylist(PID, ['c2']);

    expect(callAt(calls, 0).url.pathname).toBe(`/api/playlist/${PID}`);
    expect(callAt(calls, 0).headers['authorization']).toMatch(/^Bearer /);
    expect(callAt(calls, 1).body).toEqual({
      playlist_id: PID,
      update_type: 'remove',
      metadata: { clip_ids: ['c2'], indexes: [2] },
    });
  });

  it('removes nothing when a clip is not in the playlist', async () => {
    const { clientOptions, calls } = stubClientOptions(
      always({ body: { id: PID, name: 'Mine', num_total_results: 1, playlist_clips: [{ relative_index: 1, clip: clip('c1') }] } }),
    );
    const suno = new Suno(clientOptions);

    expect((await failure(suno.removeFromPlaylist(PID, ['c1', 'missing']))).code).toBe('not_found');
    expect(calls).toHaveLength(1);
  });
});
