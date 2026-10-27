/**
 * The comments under a song, read the way its page shows them.
 *
 * Public: measured on 2026-10-27, anonymous reads answer the same pages. With a
 * session, it is sent. Writing comments is not covered.
 */
import { z } from 'zod';

import { pathSegment, type SunoClient } from '../client.js';
import { SunoError } from '../errors.js';
import { walkCursorPages } from '../internal/pages.js';
import { requestWithSessionIfAny } from '../internal/session.js';

/** The orders the server accepts; anything else is a 422. */
export const COMMENT_ORDERS = ['newest', 'oldest', 'most_liked'] as const;
export type CommentOrder = (typeof COMMENT_ORDERS)[number];

/** Comments per page, fixed by the server. */
export const COMMENTS_PAGE_SIZE = 20;

const CommentFields = {
  id: z.string(),
  user_id: z.string().nullish(),
  user_display_name: z.string().nullish(),
  user_handle: z.string().nullish(),
  user_avatar_url: z.string().nullish(),
  user_is_verified: z.boolean().nullish(),
  content: z.string().default(''),
  created_at: z.string().nullish(),
  num_likes: z.number().nullish(),
};

export const ReplySchema = z.object(CommentFields).passthrough();
export type CommentReply = z.infer<typeof ReplySchema>;

export const CommentSchema = z
  .object({
    ...CommentFields,
    clip_id: z.string().nullish(),
    num_replies: z.number().nullish(),
    /** The first replies only. `num_replies` says how many there are. */
    replies: z.array(ReplySchema).nullish(),
    reply_continuation_token: z.string().nullish(),
    /** Seconds into the song the comment points at, when it does. */
    track_timestamp: z.number().nullish(),
  })
  .passthrough();

export type Comment = z.infer<typeof CommentSchema>;

const CommentsSchema = z
  .object({
    results: z.array(CommentSchema).default([]),
    total_count: z.number().nullish(),
    next_cursor: z.string().nullish(),
    allow_comment: z.boolean().nullish(),
  })
  .passthrough();

export interface CommentsPage {
  comments: Comment[];
  /** Top-level comments on the song, as the page counts them. */
  total: number | undefined;
  nextCursor: string | undefined;
  /** Whether the song takes new comments. */
  open: boolean | undefined;
}

export interface CommentsOptions {
  /** Defaults to `most_liked`, as the song page does. */
  order?: CommentOrder;
  cursor?: string;
  signal?: AbortSignal;
}

export async function listComments(
  client: SunoClient,
  clipId: string,
  options: CommentsOptions = {},
): Promise<CommentsPage> {
  const order = options.order ?? 'most_liked';
  if (!COMMENT_ORDERS.includes(order)) {
    throw new SunoError({
      code: 'invalid_input',
      message: `order must be one of ${COMMENT_ORDERS.join(', ')}, got ${JSON.stringify(order)}`,
    });
  }
  if (clipId.trim() === '') throw new SunoError({ code: 'invalid_input', message: 'a clip id cannot be empty' });
  const data = await requestWithSessionIfAny(client, {
    method: 'GET',
    path: `/api/gen/${pathSegment(clipId.trim())}/comments`,
    query: { order, ...(options.cursor !== undefined ? { cursor: options.cursor } : {}) },
    schema: CommentsSchema,
    endpointKey: 'clip.comments',
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    comments: data.results,
    total: data.total_count ?? undefined,
    nextCursor: data.next_cursor ?? undefined,
    open: data.allow_comment ?? undefined,
  };
}

/** Every top-level comment on a song, each once. */
export function iterateComments(
  client: SunoClient,
  clipId: string,
  options: { order?: CommentOrder; maxPages?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Comment, void, undefined> {
  return walkCursorPages<Comment>({
    fetchPage: async (cursor) => {
      const page = await listComments(client, clipId, {
        ...(options.order !== undefined ? { order: options.order } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { items: page.comments, nextCursor: page.nextCursor };
    },
    keyOf: (comment) => comment.id,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
  });
}
