import { afterEach, describe, expect, it, vi } from 'vitest';

import { getEditableProfile, setAvatar, updateProfile, uploadImage } from '../../src/api/profile-edit.js';
import { always, callAt, failure, inOrder, stubClient } from './support/harness.js';

const HANDLE = 'example_user';
const editable = {
  user_id: 'u',
  metadata: { handle: HANDLE, display_name: 'Example', avatar_image_url: 'https://cdn.example/a.jpg' },
  bio: { profile_description: 'hello', user_inputted_genres: ['jazz'] },
  social_links: {},
};
const updated = (fields: string[]) => ({ body: { success: true, updated_fields: fields, errors: {} } });

afterEach(() => vi.unstubAllGlobals());

describe('profile editing', () => {
  it('reads the editable profile', async () => {
    const { client, calls } = stubClient(always({ body: editable }));
    expect((await getEditableProfile(client, HANDLE)).bio?.user_inputted_genres).toEqual(['jazz']);
    expect(callAt(calls, 0).url.pathname).toBe(`/api/profiles/v2/${HANDLE}`);
  });

  it('sends only the bio when only the bio changes', async () => {
    const { client, calls } = stubClient(always(updated(['profile_description'])));
    expect(await updateProfile(client, HANDLE, { bio: 'new' })).toEqual(['profile_description']);
    expect(callAt(calls, 0).method).toBe('PATCH');
    expect(callAt(calls, 0).body).toEqual({ bio: { profile_description: 'new' } });
  });

  it('sends a name change with the handle, as the server wants', async () => {
    const { client, calls } = stubClient(always(updated(['display_name'])));
    await updateProfile(client, HANDLE, { displayName: 'New name' });
    expect(calls).toHaveLength(1);
    expect(callAt(calls, 0).body).toEqual({ metadata: { display_name: 'New name', handle: HANDLE } });
  });

  it('keeps the current name when only the avatar changes', async () => {
    const { client, calls } = stubClient(inOrder([{ body: editable }, updated(['avatar_image_url'])]));
    await updateProfile(client, HANDLE, { avatarUploadId: 'up' });
    expect(callAt(calls, 1).body).toEqual({
      metadata: { display_name: 'Example', handle: HANDLE, avatar_upload_id: 'up', avatar_is_ai_generated: false },
    });
  });

  it('maps links, null removing one', async () => {
    const { client, calls } = stubClient(always(updated(['x_link'])));
    await updateProfile(client, HANDLE, { links: { x: 'https://x.example/me', tiktok: null } });
    expect(callAt(calls, 0).body).toEqual({ social_links: { x_link: 'https://x.example/me', tiktok_link: null } });
  });

  it('throws what Suno refused', async () => {
    const { client } = stubClient(always({ body: { success: false, updated_fields: [], errors: { display_name: 'taken' } } }));
    expect((await failure(updateProfile(client, HANDLE, { displayName: 'x' }))).message).toContain('taken');
  });

  it('sends nothing for no change', async () => {
    const { client, calls } = stubClient(always({ body: {} }));
    expect(await updateProfile(client, HANDLE, {})).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('avatar', () => {
  const slot = { body: { id: 'img', url: 'https://storage.example/', fields: { key: 'k', policy: 'p' }, is_file_uploaded: false } };

  it('uploads through the signed form, then confirms', async () => {
    const storage = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      expect(form.get('key')).toBe('k');
      expect((form.get('file') as Blob).type).toBe('image/png');
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', storage);
    const { client, calls } = stubClient(inOrder([slot, { body: { upload_id: 'img', moderation_status: 'approved' } }]));

    expect(await uploadImage(client, new Uint8Array([1, 2, 3]), 'png')).toEqual({ uploadId: 'img', moderation: 'approved' });
    expect(callAt(calls, 0).body).toEqual({ extension: 'png' });
    expect(callAt(calls, 1).url.pathname).toBe('/api/uploads/image/img/upload-finish');
    expect(storage).toHaveBeenCalledWith('https://storage.example/', expect.objectContaining({ method: 'POST' }));
  });

  it('does not set an image moderation refused', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    const { client, calls } = stubClient(inOrder([slot, { body: { upload_id: 'img', moderation_status: 'rejected' } }]));
    expect((await failure(setAvatar(client, HANDLE, new Uint8Array([1]), 'jpeg'))).message).toContain('rejected');
    expect(calls).toHaveLength(2);
  });
});
