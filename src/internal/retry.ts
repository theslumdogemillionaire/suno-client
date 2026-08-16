export interface RetryOptions {
  /** Attempts beyond the first. 0 disables retrying entirely. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Full jitter. Without it, N workers that fail together retry together. */
  jitter: boolean;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitter: true,
};

export function backoffDelay(attempt: number, opts: RetryOptions, random = Math.random): number {
  const exponential = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
  return opts.jitter ? Math.floor(random() * exponential) : exponential;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Serialise an expensive idempotent operation so that N concurrent callers
 * trigger it once. Used for the JWT refresh: without this, ten in-flight
 * requests hitting a stale token would fire ten Clerk exchanges, and Clerk
 * rate-limits.
 */
export function singleFlight<T>(): (fn: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return (fn) => {
    if (inFlight) return inFlight;
    inFlight = fn().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
