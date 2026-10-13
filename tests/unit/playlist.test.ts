import { describe, expect, it } from 'vitest';

import { extractPlaylistId, getPlaylist } from '../../src/api/playlist.js';
import type { FetchLike } from '../../src/auth.js';
import { SunoClient } from '../../src/client.js';
import { MemoryAuthStore } from '../../src/store.js';

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
