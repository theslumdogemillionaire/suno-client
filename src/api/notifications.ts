/**
 * The account's notifications, as the bell on suno.com lists them. Needs a
 * session. Marking them read is not covered.
 */
import { z } from 'zod';

import type { SunoClient } from '../client.js';

export const NOTIFICATIONS_PATH = '/api/notification/v3';
export const NOTIFICATION_BADGE_PATH = '/api/notification/v2/badge-count';

const ActionSchema = z.object({ type: z.string().nullish(), url: z.string().nullish() }).passthrough();

export const NotificationSchema = z
  .object({
    id: z.string(),
    /** `clip_like` and the like. */
    notification_type: z.string().nullish(),
    /** The clip, profile or playlist the notification is about. */
    content_id: z.string().nullish(),
    updated_at: z.string().nullish(),
    is_read: z.boolean().nullish(),
    /** The sentence, in runs: join the `text` values to read it. */
    text: z
      .array(z.object({ text: z.string().default(''), bold: z.boolean().nullish(), action: ActionSchema.nullish() }).passthrough())
      .default([]),
    avatars: z.array(z.object({ image_url: z.string().nullish(), action: ActionSchema.nullish() }).passthrough()).default([]),
    thumbnail_url: z.string().nullish(),
    /** Where tapping it leads: a `suno://suno.com/...` link. */
    action: ActionSchema.nullish(),
  })
  .passthrough();

export type Notification = z.infer<typeof NotificationSchema>;

const NotificationsSchema = z
  .object({ notifications: z.array(NotificationSchema).default([]), notified_at: z.string().nullish() })
  .passthrough();

/** The recent notifications, newest first. Not paged. */
export async function listNotifications(client: SunoClient, signal?: AbortSignal): Promise<Notification[]> {
  const data = await client.request({
    method: 'GET',
    path: NOTIFICATIONS_PATH,
    schema: NotificationsSchema,
    endpointKey: 'notifications.list',
    ...(signal ? { signal } : {}),
  });
  return data.notifications;
}

/** The number on the bell: unread notifications. */
export async function unreadNotificationCount(client: SunoClient, signal?: AbortSignal): Promise<number> {
  const data = await client.request({
    method: 'GET',
    path: NOTIFICATION_BADGE_PATH,
    schema: z.object({ badge_count: z.number().default(0) }).passthrough(),
    endpointKey: 'notifications.badge',
    ...(signal ? { signal } : {}),
  });
  return data.badge_count;
}

/** A notification's sentence as plain text. */
export function notificationText(notification: Notification): string {
  return notification.text.map((run) => run.text).join('');
}
