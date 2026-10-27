import { describe, expect, it } from 'vitest';

import { listNotifications, notificationText, unreadNotificationCount } from '../../src/api/notifications.js';
import { always, callAt, stubClient } from './support/harness.js';

describe('notifications', () => {
  it('lists them and reads their sentence', async () => {
    const { client, calls } = stubClient(
      always({
        body: {
          notified_at: '2026-10-27T00:00:00Z',
          notifications: [
            {
              id: 'n1',
              notification_type: 'clip_like',
              content_id: 'c',
              is_read: false,
              text: [{ text: 'Example', bold: true }, { text: ' liked your song ' }, { text: 'Song', bold: true }],
              avatars: [{ image_url: 'https://cdn.example/a.jpg' }],
              action: { type: 'navigate', url: 'suno://suno.com/song/c' },
            },
          ],
        },
      }),
    );
    const [n] = await listNotifications(client);
    expect(callAt(calls, 0).url.pathname).toBe('/api/notification/v3');
    expect(n && notificationText(n)).toBe('Example liked your song Song');
    expect(n?.action?.url).toBe('suno://suno.com/song/c');
  });

  it('counts the unread ones', async () => {
    const { client } = stubClient(always({ body: { badge_count: 3 } }));
    expect(await unreadNotificationCount(client)).toBe(3);
  });
});
