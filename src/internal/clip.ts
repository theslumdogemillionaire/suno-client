import { ClipSchema, type Clip } from '../schemas.js';

/**
 * A clip from a public list, kept even when it is missing fields.
 *
 * Playlist, profile and search payloads carry the same objects as the feed,
 * but a public payload has been seen dropping fields ClipSchema treats as
 * required. Fill the holes so a missing `created_at` does not throw away a
 * playable track, and parse per item so one odd song cannot fail a page of
 * hundreds. Anything without a string `id` is not a clip and is skipped.
 */
export function salvageClip(raw: unknown): Clip | undefined {
  const direct = ClipSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (raw === null || typeof raw !== 'object' || !('id' in raw) || typeof (raw as { id: unknown }).id !== 'string') {
    return undefined;
  }
  // A null is as much a hole as a missing key. Spread as-is it overrode the
  // defaults below, and the clip was dropped anyway.
  const present = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null));
  const filled = ClipSchema.safeParse({
    title: '',
    status: 'complete',
    model_name: 'unknown',
    created_at: '1970-01-01T00:00:00.000Z',
    ...present,
  });
  return filled.success ? filled.data : undefined;
}

/** Every salvageable clip in a list, in order. */
export function salvageClips(raw: readonly unknown[] | null | undefined): Clip[] {
  const out: Clip[] = [];
  for (const item of raw ?? []) {
    const clip = salvageClip(item);
    if (clip) out.push(clip);
  }
  return out;
}
