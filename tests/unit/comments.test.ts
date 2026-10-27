import { describe, expect, it } from 'vitest';

import { deleteComment, iterateComments, listComments, postComment, setCommentReaction } from '../../src/api/comments.js';
import { always, callAt, collect, failure, inOrder, stubClient } from './support/harness.js';

const ID = '00000000-0000-0000-0000-000000000001';

function comment(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    entity_type: 'clip',
    clip_id: ID,
    user_id: 'u',
    user_display_name: 'Example',
    user_handle: 'example_user',
    content: `comment ${id}`,
    created_at: '2026-10-27T00:00:00Z',
    num_likes: 1,
    num_replies: 0,
    replies: [],
    ...extra,
  };
}

describe('listComments', () => {
  it('asks most_liked first, as the song page does', async () => {
    const { client, calls } = stubClient(
      always({ body: { results: [comment('a')], total_count: 120, next_cursor: 'n', allow_comment: true } }),
    );

    const page = await listComments(client, ID);

    expect(callAt(calls, 0).url.pathname).toBe(`/api/gen/${ID}/comments`);
    expect(Object.fromEntries(callAt(calls, 0).url.searchParams)).toEqual({ order: 'most_liked' });
    expect(page).toMatchObject({ total: 120, nextCursor: 'n', open: true });
    expect(page.comments[0]?.content).toBe('comment a');
  });

  it('keeps the first replies', async () => {
    const reply = { id: 'r', user_handle: 'other', content: 'reply', num_likes: 2 };
    const { client } = stubClient(always({ body: { results: [comment('a', { num_replies: 3, replies: [reply] })] } }));
    const [first] = (await listComments(client, ID)).comments;
    expect(first?.num_replies).toBe(3);
    expect(first?.replies?.[0]?.content).toBe('reply');
  });

  it('refuses an order the server rejects', async () => {
    const { client, calls } = stubClient(always({ body: {} }));
    // @ts-expect-error not an accepted order
    expect((await failure(listComments(client, ID, { order: 'top' }))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('reads without a session', async () => {
    const { client, calls } = stubClient(always({ body: { results: [] } }), { signedIn: false });
    await listComments(client, ID, { order: 'newest' });
    expect(callAt(calls, 0).headers['authorization']).toBeUndefined();
  });
});

describe('iterateComments', () => {
  it('follows next_cursor until there is none', async () => {
    const { client, calls } = stubClient(
      inOrder([
        { body: { results: [comment('a'), comment('b')], next_cursor: 'c1' } },
        { body: { results: [comment('c')], next_cursor: null } },
      ]),
    );
    expect((await collect(iterateComments(client, ID, { order: 'oldest' }))).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(Object.fromEntries(callAt(calls, 1).url.searchParams)).toEqual({ order: 'oldest', cursor: 'c1' });
  });
});

describe('comment writes', () => {
  it('posts with the body suno.com sends, and never retries', async () => {
    const { client, calls } = stubClient(always({ status: 503 }), { maxRetries: 3 });
    await failure(postComment(client, ID, 'nice', { replyTo: 'c1', trackTimestamp: 42 }));
    expect(calls).toHaveLength(1);
    expect(callAt(calls, 0).url.pathname).toBe(`/api/gen/${ID}/comment`);
    expect(callAt(calls, 0).body).toEqual({ content: 'nice', parent_id: 'c1', user_mentions: [], track_timestamp: 42 });
  });

  it('returns the posted comment', async () => {
    const { client, calls } = stubClient(always({ body: comment('new', { content: 'hi', num_likes: 0 }) }));
    expect((await postComment(client, ID, 'hi')).id).toBe('new');
    expect(callAt(calls, 0).body).toMatchObject({ parent_id: null, track_timestamp: null });
  });

  it('refuses an empty comment', async () => {
    const { client, calls } = stubClient(always({ body: {} }));
    expect((await failure(postComment(client, ID, '   '))).code).toBe('invalid_input');
    expect(calls).toHaveLength(0);
  });

  it('deletes by comment id', async () => {
    const { client, calls } = stubClient(always({ body: { id: 'c', status: 'deleted' } }));
    await deleteComment(client, 'c');
    expect(callAt(calls, 0).method).toBe('DELETE');
    expect(callAt(calls, 0).url.pathname).toBe('/api/comment/c');
  });

  it('likes, and takes it back with null', async () => {
    const { client, calls } = stubClient(
      inOrder([{ body: { id: 'c', num_likes: 1, reaction_type: 'LIKE' } }, { body: { id: 'c', num_likes: 0 } }]),
    );
    expect(await setCommentReaction(client, 'c', 'LIKE')).toEqual({ likes: 1, reaction: 'LIKE' });
    expect(await setCommentReaction(client, 'c', null)).toEqual({ likes: 0, reaction: null });
    expect(callAt(calls, 1).body).toEqual({ entity_type: 'clip', reaction: null });
  });
});
