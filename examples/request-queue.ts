/**
 * A song-request queue, of the kind a Twitch bot needs.
 *
 * Deliberately transport-agnostic: you supply `say`, so this works with tmi.js,
 * a Discord client, a websocket to an overlay, or console.log. What it actually
 * demonstrates is the operational shape of running Suno behind other people's
 * input, which is where all the sharp edges live:
 *
 *   - one generation at a time, because credits are finite and Suno rate-limits
 *   - progress posted as it happens, not a two-minute silence
 *   - content rejections answered in chat, never retried
 *   - captcha gating and credit exhaustion pause the queue instead of burning it
 *   - drift and dead sessions reach an operator rather than a chat log
 *
 * Run: npx tsx examples/request-queue.ts
 */
import { Suno, SunoError, formatDriftReport, type Clip } from '../src/index.js';

export interface SongRequest {
  requester: string;
  prompt: string;
}

export interface QueueOptions {
  /** Post a line to chat. */
  say: (message: string) => void | Promise<void>;
  /** Something a human should see: dead session, schema drift, captcha wall. */
  alert: (message: string, error?: SunoError) => void | Promise<void>;
  /** Where finished tracks land. Omit to skip downloading. */
  outputDir?: string;
  /** Stop accepting requests below this many credits. */
  creditFloor?: number;
}

export class SongQueue {
  private readonly pending: SongRequest[] = [];
  private running = false;
  private paused = false;

  constructor(
    private readonly suno: Suno,
    private readonly options: QueueOptions,
  ) {}

  get length(): number {
    return this.pending.length;
  }

  async add(request: SongRequest): Promise<void> {
    if (this.paused) {
      await this.options.say(`@${request.requester} the song queue is paused right now.`);
      return;
    }
    this.pending.push(request);
    await this.options.say(`@${request.requester} queued, position ${this.pending.length}.`);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0 && !this.paused) {
        const request = this.pending.shift();
        if (request) await this.run(request);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(request: SongRequest): Promise<void> {
    // Set once the create is out. A pause before that keeps the request for
    // resume(); after it, replaying the request would bill a second song.
    let created = false;
    try {
      // Two preflights, both cheap, both preventing a wasted create. A gated
      // account cannot generate at all, and only a human at suno.com can clear
      // it, so discovering that here beats discovering it after the submit.
      const credits = await this.suno.credits();
      if (credits.left < (this.options.creditFloor ?? 50)) {
        this.hold(request);
        await this.options.alert(`credits exhausted: ${credits.left} left, queue paused`);
        await this.options.say('out of credits for now, song requests are paused.');
        return;
      }

      const gate = await this.suno.captchaCheck();
      if (gate.required) {
        this.hold(request);
        await this.options.alert('Suno is captcha-gating this account; generate one song by hand at suno.com to clear it');
        await this.options.say('song requests are paused, back shortly.');
        return;
      }

      await this.options.say(`@${request.requester} writing "${request.prompt}"...`);

      const job = await this.suno.describe({ prompt: request.prompt });
      created = true;

      for await (const update of job.watch({ timeoutMs: 480_000 })) {
        for (const clip of update.changed) {
          if (clip.status === 'streaming') {
            await this.options.say(`@${request.requester} "${clip.title}" is rendering...`);
          }
        }
      }

      for (const { clip, reason } of job.failed) {
        await this.options.say(`@${request.requester} "${clip.title}" failed: ${reason}`);
      }

      const done = job.completed;
      if (done.length === 0) {
        await this.options.say(`@${request.requester} that one did not come out, try a different idea.`);
        return;
      }

      await this.options.say(
        `@${request.requester} done: ${done.map((c: Clip) => c.title).join(' / ')}`,
      );

      if (this.options.outputDir !== undefined) {
        const result = await this.suno.downloadAll(done, { outputDir: this.options.outputDir });
        if (result.failed.length > 0) {
          await this.options.alert(`${result.failed.length} download(s) failed`);
        }
      }
    } catch (err) {
      await this.handle(request, err, created);
    }
  }

  /**
   * Pause, putting this request back at the head of the queue so resume()
   * runs it first. Pausing used to drop it: the viewer had been told
   * "queued", and it was never run nor mentioned again.
   */
  private hold(request: SongRequest): void {
    this.paused = true;
    this.pending.unshift(request);
  }

  private async handle(request: SongRequest, err: unknown, created: boolean): Promise<void> {
    if (!(err instanceof SunoError)) {
      await this.options.alert(`unexpected failure: ${String(err)}`);
      return;
    }

    // The whole point of the two booleans: `alert` decides whether a human is
    // needed, and it is independent of whether the queue can keep going.
    // Kept for resume() only when Suno refused it before creating anything.
    // `response_invalid` can follow a create that was accepted and charged.
    const keep = !created && err.code !== 'response_invalid';

    if (err.alert) {
      if (keep) this.hold(request);
      else this.paused = true;
      await this.options.alert(`[${err.code}] ${err.message}`, err);
      await this.options.say('song requests are paused, my human has been poked.');
      return;
    }

    switch (err.code) {
      case 'invalid_input':
        // Suno's content filter. The next request is unaffected, and retrying
        // this one produces the same rejection.
        await this.options.say(`@${request.requester} Suno would not write that one. Try rephrasing.`);
        return;
      case 'insufficient_credits':
        if (keep) this.hold(request);
        else this.paused = true;
        // Someone has to top up and call resume(), so say so to a human too.
        await this.options.alert('out of credits: queue paused until resume()', err);
        await this.options.say('out of credits, song requests are paused.');
        return;
      case 'rate_limited':
        // The client already backed off and retried. Reaching here means Suno
        // is still saying no, so put the request back and slow down.
        this.pending.unshift(request);
        await this.options.say('Suno is busy, retrying that one shortly.');
        await new Promise((r) => setTimeout(r, 60_000));
        return;
      default:
        await this.options.say(`@${request.requester} that failed (${err.code}), try again later.`);
    }
  }

  /** After a human clears a captcha gate or tops up credits. */
  resume(): void {
    this.paused = false;
    void this.drain();
  }
}

// --- demo -----------------------------------------------------------------

if (process.argv[1]?.endsWith('request-queue.ts')) {
  const suno = new Suno({
    ...(process.env['SUNO_COOKIE'] ? { cookie: process.env['SUNO_COOKIE'] } : {}),
    onDrift: (report) => {
      if (report.degraded) console.error(`[drift] ${formatDriftReport(report)}`);
    },
  });

  const queue = new SongQueue(suno, {
    say: (m) => console.log(`[chat] ${m}`),
    alert: (m) => console.error(`[ALERT] ${m}`),
    outputDir: './songs',
  });

  await queue.add({ requester: 'viewer1', prompt: 'a calm lo-fi track about rain on a window' });
}
