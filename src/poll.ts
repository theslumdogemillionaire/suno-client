import { getClips } from './api/feed.js';
import type { SunoClient } from './client.js';
import { SunoError } from './errors.js';
import { sleep } from './internal/retry.js';
import { isTerminal, type Clip } from './schemas.js';

export interface PollOptions {
  /** Give up after this long. Suno queues have been known to sit for minutes. */
  timeoutMs?: number;
  /** First poll delay. Doubles up to `maxIntervalMs`. */
  intervalMs?: number;
  maxIntervalMs?: number;
  signal?: AbortSignal;
}

const DEFAULTS = { timeoutMs: 600_000, intervalMs: 3000, maxIntervalMs: 15_000 };

export interface JobUpdate {
  /** Every clip we know about, newest state. */
  clips: Clip[];
  /** Clips whose status changed since the previous update. */
  changed: Clip[];
  done: boolean;
  elapsedMs: number;
}

/**
 * Every requested id must reach a terminal state.
 *
 * Two traps, both of which the reference client hit in production:
 *
 *   1. An id absent from the feed is still pending, not finished. Checking
 *      `clips.every(terminal)` over the RETURNED clips reports success when the
 *      feed returns nothing at all.
 *   2. `error` is terminal. A moderation rejection never becomes `complete`, so
 *      waiting for `complete` specifically hangs until the timeout.
 */
export function allTerminal(ids: readonly string[], clips: readonly Clip[]): boolean {
  return ids.every((id) => clips.some((c) => c.id === id && isTerminal(c.status)));
}

export function pendingIds(ids: readonly string[], clips: readonly Clip[]): string[] {
  return ids.filter((id) => !clips.some((c) => c.id === id && isTerminal(c.status)));
}

/**
 * A submitted generation, with the waiting factored out.
 *
 * `wait()` is the batch ergonomic. `watch()` is the one that matters for a live
 * consumer: it yields on every status change, so a bot can post "queued",
 * "streaming", "done" as they happen instead of blocking for two minutes and
 * then dumping a result.
 */
export class GenerationJob {
  readonly ids: string[];
  private latest: Clip[];

  constructor(
    private readonly client: SunoClient,
    clips: Clip[],
  ) {
    this.ids = clips.map((c) => c.id);
    this.latest = clips;
  }

  /** Last known state, without hitting the network. */
  get clips(): Clip[] {
    return this.latest;
  }

  async refresh(signal?: AbortSignal): Promise<Clip[]> {
    this.latest = await getClips(this.client, this.ids, signal);
    return this.latest;
  }

  async *watch(options: PollOptions = {}): AsyncGenerator<JobUpdate, void, undefined> {
    const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    const maxIntervalMs = options.maxIntervalMs ?? DEFAULTS.maxIntervalMs;
    let delay = options.intervalMs ?? DEFAULTS.intervalMs;
    const started = Date.now();
    let previous = new Map(this.latest.map((c) => [c.id, c.status]));
    let first = true;

    for (;;) {
      const clips = await getClips(this.client, this.ids, options.signal);
      this.latest = clips;

      const changed = clips.filter((c) => previous.get(c.id) !== c.status);
      previous = new Map(clips.map((c) => [c.id, c.status]));
      const done = allTerminal(this.ids, clips);
      const elapsedMs = Date.now() - started;

      // Yield the first observation and every subsequent change, so a consumer
      // sees the initial state without polling separately. Gating the first one
      // on `elapsedMs === 0` looked equivalent and was not: the round trip
      // almost never lands inside the same millisecond, so a job that sat at
      // `submitted` for its first two polls emitted nothing at all.
      if (first || changed.length > 0 || done) {
        first = false;
        yield { clips, changed, done, elapsedMs };
      }
      if (done) return;

      if (elapsedMs >= timeoutMs) {
        const pending = pendingIds(this.ids, clips);
        throw new SunoError({
          code: 'timeout',
          message: `generation timed out after ${Math.round(timeoutMs / 1000)}s; ${pending.length} of ${this.ids.length} clip(s) still pending: ${pending.join(', ')}`,
        });
      }

      await sleep(delay, options.signal);
      delay = Math.min(delay * 2, maxIntervalMs);
    }
  }

  /** Block until every clip is terminal, then return them. */
  async wait(options: PollOptions = {}): Promise<Clip[]> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of this.watch(options)) {
      // Draining the generator is the wait. The final update carries done.
    }
    return this.latest;
  }

  /** Clips that finished successfully and have audio. */
  get completed(): Clip[] {
    return this.latest.filter((c) => c.status === 'complete');
  }

  /** Clips Suno gave up on, with whatever reason it attached. */
  get failed(): Array<{ clip: Clip; reason: string }> {
    return this.latest
      .filter((c) => c.status === 'error')
      .map((clip) => ({
        clip,
        reason:
          clip.metadata?.error_message ??
          clip.metadata?.error_type ??
          'Suno reported an error with no detail',
      }));
  }
}
