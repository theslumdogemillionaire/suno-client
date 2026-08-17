import {
  buildCustomBody,
  buildDescribeBody,
  submitGenerate,
  type CustomGenerateOptions,
  type DescribeGenerateOptions,
} from './api/generate.js';
import {
  concat,
  cover,
  extend,
  remaster,
  type CoverOptions,
  type ExtendOptions,
  type RemasterOptions,
} from './api/derive.js';
import { getClips, iterateClips, listClips, searchClips, type ListOptions } from './api/feed.js';
import {
  alignedLyrics,
  billingInfo,
  captchaCheck,
  generateLyrics,
  getPersona,
  requestStems,
  setMetadata,
  setTrashed,
  setVisibility,
  toLrc,
  type LyricsOptions,
  type SetMetadataOptions,
} from './api/misc.js';
import {
  barLines,
  getDownbeats,
  getMusicalKey,
  getStemPages,
  getWaveform,
  tempoFromDownbeats,
  type Downbeats,
  type MusicalKey,
  type Waveform,
} from './api/media.js';
import { SunoClient, type SunoClientOptions } from './client.js';
import { artworkUrl, downloadClip, downloadClips, type DownloadOptions } from './download.js';
import { SunoError } from './errors.js';
import { GenerationJob } from './poll.js';
import { registryFromBaselines } from './drift/registry.js';
import type { AlignedWord, BillingInfo, CaptchaCheck, Clip, FeedPage, LyricsResult, Model, PersonaInfo } from './schemas.js';

export interface SunoOptions extends SunoClientOptions {
  /**
   * Refuse to submit a generation when `/api/c/check` reports a captcha gate.
   *
   * OFF by default, which is the opposite of the obvious choice and is the
   * result of watching the flag for an afternoon: it went false, true, false
   * again within forty minutes with nothing to explain it, while the account
   * holder was never shown a captcha in the web UI. Blocking creates on a flag
   * that flickers stalls a bot for no reason, and it is not even established
   * that `required: true` prevents a create. Turn it on if you would rather
   * fail fast than find out mid-create.
   */
  preflightCaptcha?: boolean;
}

/**
 * The ergonomic surface.
 *
 * `SunoClient` is the transport (auth, retry, drift). This is what you actually
 * call. Every create returns a `GenerationJob` rather than raw clips, because
 * the interesting part of a Suno generation is the two minutes after you submit
 * it, and a Promise<Clip[]> throws that away.
 */
export class Suno {
  readonly client: SunoClient;
  private readonly preflightCaptcha: boolean;

  constructor(options: SunoOptions = {}) {
    this.client = new SunoClient({
      baselines: options.baselines ?? registryFromBaselines(),
      ...options,
    });
    this.preflightCaptcha = options.preflightCaptcha ?? false;
  }

  // --- account -------------------------------------------------------------

  billing(signal?: AbortSignal): Promise<BillingInfo> {
    return billingInfo(this.client, signal);
  }

  async credits(signal?: AbortSignal): Promise<{ left: number; plan: string; monthlyLimit: number | undefined }> {
    const info = await billingInfo(this.client, signal);
    return { left: info.total_credits_left, plan: info.plan.name, monthlyLimit: info.monthly_limit };
  }

  async models(signal?: AbortSignal): Promise<Model[]> {
    const info = await billingInfo(this.client, signal);
    return info.models ?? [];
  }

  captchaCheck(ctype = 'generation', signal?: AbortSignal): Promise<CaptchaCheck> {
    return captchaCheck(this.client, ctype, signal);
  }

  login(cookie: string, signal?: AbortSignal): Promise<unknown> {
    return this.client.login(cookie, signal);
  }

  logout(): Promise<void> {
    return this.client.logout();
  }

  // --- create --------------------------------------------------------------

  private async assertNotGated(signal?: AbortSignal): Promise<void> {
    if (!this.preflightCaptcha) return;
    const check = await captchaCheck(this.client, 'generation', signal);
    if (check.required) {
      throw new SunoError({
        code: 'captcha_required',
        message:
          'Suno is asking this account for a captcha. Generate one song manually at suno.com to clear it, or pass a solved token as captchaToken.',
        alert: true,
      });
    }
  }

  /** Custom mode: your lyrics, your style prompt, your title. */
  async generate(options: CustomGenerateOptions): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    const clips = await submitGenerate(this.client, buildCustomBody(options), options.signal);
    return new GenerationJob(this.client, clips);
  }

  /** Inspiration mode: a description, and Suno writes the lyrics. */
  async describe(options: DescribeGenerateOptions): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    const clips = await submitGenerate(this.client, buildDescribeBody(options), options.signal);
    return new GenerationJob(this.client, clips);
  }

  async cover(clipId: string, options: CoverOptions = {}): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    return new GenerationJob(this.client, await cover(this.client, clipId, options));
  }

  async remaster(clipId: string, options: RemasterOptions = {}): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    return new GenerationJob(this.client, await remaster(this.client, clipId, options));
  }

  /** Experimental: see docs/STATUS.md before relying on this. */
  async extend(clipId: string, options: ExtendOptions): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    return new GenerationJob(this.client, await extend(this.client, clipId, options));
  }

  concat(clipId: string, signal?: AbortSignal): Promise<Clip> {
    return concat(this.client, clipId, signal);
  }

  /** Free. No credits. */
  lyrics(prompt: string, options: LyricsOptions = {}): Promise<LyricsResult> {
    return generateLyrics(this.client, prompt, options);
  }

  stems(clipId: string, signal?: AbortSignal): ReturnType<typeof requestStems> {
    return requestStems(this.client, clipId, signal);
  }

  // --- read ----------------------------------------------------------------

  list(options: ListOptions = {}): Promise<FeedPage> {
    return listClips(this.client, options);
  }

  iterate(options: { limit?: number; maxPages?: number; signal?: AbortSignal } = {}): AsyncGenerator<Clip, void, undefined> {
    return iterateClips(this.client, options);
  }

  search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<FeedPage> {
    return searchClips(this.client, query, options);
  }

  get(ids: readonly string[], signal?: AbortSignal): Promise<Clip[]> {
    return getClips(this.client, ids, signal);
  }

  async info(id: string, signal?: AbortSignal): Promise<Clip> {
    const [clip] = await getClips(this.client, [id], signal);
    if (!clip) throw new SunoError({ code: 'not_found', message: `no clip with id ${id}` });
    return clip;
  }

  /** Rehydrate a job from ids, e.g. after a process restart. */
  async job(ids: readonly string[], signal?: AbortSignal): Promise<GenerationJob> {
    const clips = await getClips(this.client, ids, signal);
    return new GenerationJob(this.client, clips);
  }

  alignedLyrics(clipId: string, signal?: AbortSignal): Promise<AlignedWord[]> {
    return alignedLyrics(this.client, clipId, signal);
  }

  async lrc(clipId: string, signal?: AbortSignal): Promise<string> {
    return toLrc(await alignedLyrics(this.client, clipId, signal));
  }

  persona(personaId: string, signal?: AbortSignal): Promise<PersonaInfo> {
    return getPersona(this.client, personaId, signal);
  }

  // --- media analysis ------------------------------------------------------

  /** Beat grid. `[seconds, beatInBar]`; entries with beatInBar 1 are bar lines. */
  downbeats(clipId: string, signal?: AbortSignal): Promise<Downbeats> {
    return getDownbeats(this.client, clipId, signal);
  }

  /** Detected musical key. */
  musicalKey(clipId: string, signal?: AbortSignal): Promise<MusicalKey> {
    return getMusicalKey(this.client, clipId, signal);
  }

  /** Pre-computed waveform, several resolutions. Beats decoding the MP3. */
  waveform(clipId: string, signal?: AbortSignal): Promise<Waveform> {
    return getWaveform(this.client, clipId, signal);
  }

  stemPages(clipId: string, signal?: AbortSignal): Promise<number> {
    return getStemPages(this.client, clipId, signal);
  }

  /**
   * Everything an overlay needs about one track, in one call.
   *
   * Title, style, lyrics, cover art, word-level timings, bar lines and key.
   * The analysis endpoints are best-effort: Suno computes them asynchronously
   * and answers `state: "running"` for a while after a clip completes, so a
   * missing beat grid is normal on a fresh track rather than an error worth
   * failing the whole call over.
   */
  async track(
    clipId: string,
    signal?: AbortSignal,
  ): Promise<{
    clip: Clip;
    title: string;
    style: string | undefined;
    lyrics: string | undefined;
    audioUrl: string | undefined;
    artworkUrl: string | undefined;
    durationS: number | undefined;
    words: AlignedWord[];
    lrc: string;
    barLines: number[];
    bpm: number | undefined;
    key: string | undefined;
  }> {
    const clip = await this.info(clipId, signal);
    const [words, beats, key] = await Promise.all([
      alignedLyrics(this.client, clipId, signal).catch(() => [] as AlignedWord[]),
      getDownbeats(this.client, clipId, signal).catch(() => undefined),
      getMusicalKey(this.client, clipId, signal).catch(() => undefined),
    ]);

    return {
      clip,
      title: clip.title,
      style: clip.metadata?.tags ?? undefined,
      lyrics: clip.metadata?.prompt ?? undefined,
      audioUrl: clip.audio_url ?? undefined,
      artworkUrl: artworkUrl(clip),
      durationS: clip.metadata?.duration ?? undefined,
      words,
      lrc: toLrc(words),
      barLines: beats ? barLines(beats) : [],
      bpm: (beats ? tempoFromDownbeats(beats) : undefined) ?? clip.metadata?.avg_bpm ?? undefined,
      key: key?.key ?? undefined,
    };
  }

  // --- manage --------------------------------------------------------------

  trash(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    return setTrashed(this.client, ids, true, signal);
  }

  restore(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    return setTrashed(this.client, ids, false, signal);
  }

  setMetadata(clipId: string, options: SetMetadataOptions): Promise<void> {
    return setMetadata(this.client, clipId, options);
  }

  publish(clipId: string, isPublic: boolean, signal?: AbortSignal): Promise<void> {
    return setVisibility(this.client, clipId, isPublic, signal);
  }

  // --- files ---------------------------------------------------------------

  download(clip: Clip, options: DownloadOptions): Promise<string> {
    return downloadClip(this.client, clip, options);
  }

  downloadAll(clips: readonly Clip[], options: DownloadOptions): ReturnType<typeof downloadClips> {
    return downloadClips(this.client, clips, options);
  }
}
