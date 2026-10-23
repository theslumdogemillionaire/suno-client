import { describe, expect, it } from 'vitest';

import {
  getProfile,
  iterateFollowers,
  iterateFollowing,
  iterateProfileClips,
  listFollowing,
  setFollowing,
} from '../../src/api/profile.js';
import {
  abortedSignal,
  always,
  callAt,
  clip,
  collect,
  failure,
  inOrder,
  stubClient,
  type Reply,
} from './support/harness.js';

const HANDLE = 'example_user';

function profilePage(clips: readonly unknown[], extra: Record<string, unknown> = {}): Reply {
  return {
    body: {
      user_id: '00000000-0000-0000-0000-000000000000',
      display_name: 'Example',
      handle: HANDLE,
      profile_description: '',
      clips,
      stats: { upvote_count__sum: 0, play_count__sum: 0, followers_count: 3, following_count: 2 },
      is_following: false,
      num_total_clips: 99,
      current_page: 1,
      playlists: [],
      favorite_songs: [],
      personas: [],
      ...extra,
    },
  };
}

function range(prefix: string, from: number, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => clip(`${prefix}${from + i}`));
}

function person(handle: string): Record<string, unknown> {
  // `user_id: -1` is what every entry carries; the schema must not trip on it.
  return {
    user_id: -1,
    entity_type: 'simple_profile_schema',
    external_user_id: `00000000-0000-0000-0000-${handle.padStart(12, '0')}`,
    display_name: handle,
    handle,
    avatar_image_url: 'https://cdn.example/a.jpg',
    is_following: false,
  };
}

function followPage(handles: readonly string[], total?: number): Reply {
  return {
    body: {
      user_id: '00000000-0000-0000-0000-000000000000',
      handle: HANDLE,
      profiles: handles.map(person),
      current_page: 1,
      ...(total !== undefined ? { num_total_profiles: total } : {}),
    },
  };
}

function handles(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe('getProfile', () => {
  it('sends all three query parameters, which the server requires', async () => {
    const { client, calls } = stubClient(always(profilePage([clip('a')])));

    const profile = await getProfile(client, HANDLE);

    const url = callAt(calls, 0).url;
    expect(url.pathname).toBe(`/api/profiles/${HANDLE}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: '1',
      playlists_sort_by: 'upvote_count',
      clips_sort_by: 'created_at',
    });
    expect(callAt(calls, 0).method).toBe('GET');
    expect(profile.handle).toBe(HANDLE);
    expect(profile.stats?.followers_count).toBe(3);
    expect(profile.clips.map((c) => c.id)).toEqual(['a']);
  });

  it('passes page and sort orders through', async () => {
    const { client, calls } = stubClient(always(profilePage([])));

    await getProfile(client, HANDLE, { page: 3, clipsSortBy: 'upvote_count', playlistsSortBy: 'created_at' });

    expect(Object.fromEntries(callAt(calls, 0).url.searchParams)).toEqual({
      page: '3',
      playlists_sort_by: 'created_at',
      clips_sort_by: 'upvote_count',
    });
  });

  it('sends the session when one is stored, so is_following is about this account', async () => {
    const { client, calls } = stubClient(always(profilePage([])));

    await getProfile(client, HANDLE);

    expect(callAt(calls, 0).headers['authorization']).toMatch(/^Bearer /);
  });

  it('reads anonymously when no session is stored, instead of failing', async () => {
    const { client, calls } = stubClient(always(profilePage([clip('a')])), { signedIn: false });

    const profile = await getProfile(client, HANDLE);

    expect(calls).toHaveLength(1);
    expect(callAt(calls, 0).headers['authorization']).toBeUndefined();
    expect(profile.clips).toHaveLength(1);
  });

  it('keeps a clip missing created_at and drops an entry that is not a clip', async () => {
    const { created_at: _dropped, ...loose } = clip('b');
    const { client } = stubClient(always(profilePage([clip('a'), loose, { title: 'no id' }])));

    const profile = await getProfile(client, HANDLE);

    expect(profile.clips.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('encodes the handle into one path segment', async () => {
    const { client, calls } = stubClient(always(profilePage([])));

    await getProfile(client, '../billing/info/#');

    expect(callAt(calls, 0).url.pathname).toBe('/api/profiles/..%2Fbilling%2Finfo%2F%23');
  });

  it('refuses an empty handle or a bad page before sending anything', async () => {
    const { client, calls } = stubClient(always(profilePage([])));

    expect((await failure(getProfile(client, '  '))).code).toBe('invalid_input');
    expect((await failure(getProfile(client, HANDLE, { page: 0 }))).code).toBe('invalid_input');
    expect((await failure(getProfile(client, HANDLE, { page: 1.5 }))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('sends nothing once the signal has fired', async () => {
    const { client, calls } = stubClient(always(profilePage([])));

    const err = await failure(getProfile(client, HANDLE, { signal: abortedSignal() }));

    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('iterateProfileClips', () => {
  it('yields pinned clips once, although page one repeats them further down', async () => {
    // Page one is the pinned clips plus 20. The pinned ones come back again in
    // the regular list, which is why num_total_clips cannot be a stop.
    const { client, calls } = stubClient(
      inOrder([
        profilePage([clip('pin'), ...range('c', 0, 20)]),
        profilePage([...range('c', 20, 19), clip('pin')]),
        profilePage([]),
      ]),
    );

    const ids = (await collect(iterateProfileClips(client, HANDLE))).map((c) => c.id);

    expect(ids).toHaveLength(40);
    expect(ids.filter((id) => id === 'pin')).toHaveLength(1);
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2', '3']);
  });

  it('stops on a short page without asking for the next one', async () => {
    const { client, calls } = stubClient(
      inOrder([profilePage(range('c', 0, 20)), profilePage(range('c', 20, 5))]),
    );

    expect(await collect(iterateProfileClips(client, HANDLE))).toHaveLength(25);
    expect(calls).toHaveLength(2);
  });

  it('stops on an empty page', async () => {
    const { client, calls } = stubClient(inOrder([profilePage(range('c', 0, 20)), profilePage([])]));

    expect(await collect(iterateProfileClips(client, HANDLE))).toHaveLength(20);
    expect(calls).toHaveLength(2);
  });

  it('stops when a page adds nothing new, as a server ignoring `page` would', async () => {
    const { client, calls } = stubClient(always(profilePage(range('c', 0, 20))));

    expect(await collect(iterateProfileClips(client, HANDLE))).toHaveLength(20);
    expect(calls).toHaveLength(2);
  });

  it('stops at maxPages', async () => {
    const { client, calls } = stubClient((_call, index) => profilePage(range('c', index * 20, 20)));

    expect(await collect(iterateProfileClips(client, HANDLE, { maxPages: 2 }))).toHaveLength(40);
    expect(calls).toHaveLength(2);
  });

  it('carries the signal to every page', async () => {
    const controller = new AbortController();
    const { client, calls } = stubClient((_call, index) => {
      controller.abort();
      return profilePage(range('c', index * 20, 20));
    });

    const err = await failure(collect(iterateProfileClips(client, HANDLE, { signal: controller.signal })));

    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('follow lists', () => {
  it('reads one page of who a handle follows, with the session', async () => {
    const { client, calls } = stubClient(always(followPage(['one', 'two'], 2)));

    const page = await listFollowing(client, HANDLE, { page: 2 });

    const call = callAt(calls, 0);
    expect(call.url.pathname).toBe(`/api/profiles/${HANDLE}/following`);
    expect(call.url.searchParams.get('page')).toBe('2');
    expect(call.headers['authorization']).toMatch(/^Bearer /);
    expect(page.profiles.map((p) => p.handle)).toEqual(['one', 'two']);
    expect(page.profiles[0]?.external_user_id).toMatch(/^0{8}-/);
  });

  it('needs a session: anonymous, Suno answers 401', async () => {
    const { client, calls } = stubClient(always(followPage([])), { signedIn: false });

    expect((await failure(listFollowing(client, HANDLE))).code).toBe('auth_missing');
    expect(calls).toHaveLength(0);
  });

  it('walks followers until a short page', async () => {
    const { client, calls } = stubClient(
      inOrder([followPage(handles('a', 20)), followPage(handles('b', 3))]),
    );

    const people = await collect(iterateFollowers(client, HANDLE));

    expect(people).toHaveLength(23);
    expect(calls.map((c) => c.url.pathname)).toEqual([
      `/api/profiles/${HANDLE}/followers`,
      `/api/profiles/${HANDLE}/followers`,
    ]);
    expect(calls.map((c) => c.url.searchParams.get('page'))).toEqual(['1', '2']);
  });

  it('stops on an empty page, and on the reported total', async () => {
    const empty = stubClient(inOrder([followPage(handles('a', 20)), followPage([])]));
    expect(await collect(iterateFollowing(empty.client, HANDLE))).toHaveLength(20);
    expect(empty.calls).toHaveLength(2);

    const counted = stubClient(inOrder([followPage(handles('a', 20), 20)]));
    expect(await collect(iterateFollowing(counted.client, HANDLE))).toHaveLength(20);
    expect(counted.calls).toHaveLength(1);
  });

  it('stops when a page repeats the last one', async () => {
    const { client, calls } = stubClient(always(followPage(handles('a', 20))));

    expect(await collect(iterateFollowing(client, HANDLE))).toHaveLength(20);
    expect(calls).toHaveLength(2);
  });
});

describe('setFollowing', () => {
  it('names the handle in the body, and says unfollow rather than follow', async () => {
    const { client, calls } = stubClient(always({ status: 204 }));

    await setFollowing(client, HANDLE, true);
    await setFollowing(client, HANDLE, false);

    expect(calls.map((c) => [c.method, c.url.pathname])).toEqual([
      ['POST', '/api/profiles/follow'],
      ['POST', '/api/profiles/follow'],
    ]);
    expect(callAt(calls, 0).body).toEqual({ handle: HANDLE, unfollow: false });
    expect(callAt(calls, 1).body).toEqual({ handle: HANDLE, unfollow: true });
  });

  it('accepts a null body as well as a 204', async () => {
    const { client } = stubClient(always({ body: null }));

    await expect(setFollowing(client, HANDLE, true)).resolves.toBeUndefined();
  });

  it('refuses an empty handle', async () => {
    const { client, calls } = stubClient(always({ status: 204 }));

    expect((await failure(setFollowing(client, '', true))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });
});
