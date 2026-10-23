import { Buffer } from 'node:buffer';

import type { FetchLike } from '../../../src/auth.js';
import { SunoClient, type SunoClientOptions } from '../../../src/client.js';
import { SunoError } from '../../../src/errors.js';
import { MemoryAuthStore } from '../../../src/store.js';

/**
 * A real SunoClient over a stub transport, so a test asserts the bytes Suno
 * would receive: path, query, headers and body, as sent.
 */
export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** What the stub answers. A 204 carries no body, whatever `body` holds. */
export interface Reply {
  status?: number;
  body?: unknown;
}

export type Responder = (call: RecordedCall, index: number) => Reply;

/** A JWT whose only job is to be unexpired, so no Clerk round trip happens. */
export function unexpiredJwt(): string {
  const claims = { exp: Math.floor(Date.now() / 1000) + 7200 };
  return `header.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`;
}

export interface StubOptions {
  /** Defaults to true: a stored session with an unexpired JWT. */
  signedIn?: boolean;
  /** Defaults to 0, so a wrong answer fails the assertion rather than backing off. */
  maxRetries?: number;
}

export function stubClient(
  respond: Responder,
  options: StubOptions = {},
): { client: SunoClient; calls: RecordedCall[] } {
  const { clientOptions, calls } = stubClientOptions(respond, options);
  return { client: new SunoClient(clientOptions), calls };
}

/** The same stub as options, for building a `Suno` facade over it. */
export function stubClientOptions(
  respond: Responder,
  options: StubOptions = {},
): { clientOptions: SunoClientOptions; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const raw = init?.headers;
    const headers =
      raw === undefined || raw === null ? {} : { ...(raw as unknown as Record<string, string>) };
    const call: RecordedCall = {
      url: new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    };
    const index = calls.length;
    calls.push(call);
    const reply = respond(call, index);
    const status = reply.status ?? 200;
    return Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(reply.body ?? null), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
    );
  };
  const clientOptions: SunoClientOptions = {
    fetch: fetchImpl,
    baseUrl: 'https://suno.test',
    store:
      options.signedIn === false
        ? new MemoryAuthStore()
        : new MemoryAuthStore({ clerkClientCookie: 'cookie', sessionId: 'sess', deviceId: 'dev', jwt: unexpiredJwt() }),
    retry: { maxRetries: options.maxRetries ?? 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
  };
  return { clientOptions, calls };
}

/** Answer every request with the same reply. */
export function always(reply: Reply): Responder {
  return () => reply;
}

/** Answer request N with reply N, and with `fallback` past the end. */
export function inOrder(replies: readonly Reply[], fallback: Reply = { body: null }): Responder {
  return (_call, index) => replies[index] ?? fallback;
}

export function callAt(calls: readonly RecordedCall[], index: number): RecordedCall {
  const call = calls[index];
  if (!call) throw new Error(`expected a request at index ${index}, only ${calls.length} were made`);
  return call;
}

/** Minimum payload that satisfies ClipSchema. */
export function clip(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `title ${id}`,
    status: 'complete',
    model_name: 'chirp-fenix',
    created_at: '2026-10-23T00:00:00Z',
    ...extra,
  };
}

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

/** The SunoError a promise rejects with. Fails the test if it resolves. */
export async function failure(promise: Promise<unknown>): Promise<SunoError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof SunoError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

/** A signal that has already fired. */
export function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}
