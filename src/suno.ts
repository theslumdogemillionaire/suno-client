import {
  buildCustomBody,
  buildDescribeBody,
  submitGenerate,
  type CustomGenerateOptions,
  type DescribeGenerateOptions,
} from './api/generate.js';
import {
  describeAccount,
  pickDefaultModel,
  pickRemasterModel,
  type AccountInfo,
} from './api/account.js';
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
import { playTrack, type PlaybackStream } from './api/mango.js';
import { getPlaylist, type Playlist } from './api/playlist.js';
import { artworkUrl, downloadClip, downloadClips, type DownloadOptions } from './download.js';
import { SunoError } from './errors.js';
import { GenerationJob } from './poll.js';
import { registryFromBaselines } from './drift/registry.js';
import type { AccountTier } from './api/account.js';
import type { AlignedWord, BillingInfo, CaptchaCheck, Clip, FeedPage, LyricsResult, Model, PersonaInfo } from './schemas.js';

export interface SunoOptions extends SunoClientOptions {
  /**
   * Refuse to submit a generation when `/api/c/check` reports a captcha gate.
   *
   * `required: true` genuinely does block creates. Measured on a Free account
   * 2026-08-18: the flag flipped mid-session and the identical body that had
   * generated two clips minutes earlier began answering 422
   * `token_validation_failed` - custom, describe and extend alike.
   *
   * Still OFF by default, for a narrower reason than before: a gated create
   * costs nothing. Suno rejects it before charging, and the client already
   * reports `captcha_required` with an actionable message, so the preflight
   * buys one saved round trip rather than saved credits - while a flag that has
   * been watched going false, true, false within forty minutes would stall a
   * bot on a false positive. Turn it on if you would rather fail fast.
   */
  preflightCaptcha?: boolean;
  /**
   * Ask the account which models it may use before a create that names none.
   *
   * ON by default, and the reason is a live failure: `DEFAULT_MODEL` is v5.5,
   * which is subscription-only, so every default `generate()` on a Free account
   * came back HTTP 403 `You don't have access to this model`. The lookup is one
   * cached billing call per client, and it falls back to `DEFAULT_MODEL` if
   * billing is unavailable rather than adding a new way for a create to fail.
   *
   * Turn it off to pin the historical behaviour, or just pass `model`
   * explicitly - an explicit model always skips the lookup.
   */
  resolveModel?: boolean;
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
  private readonly wantModelResolution: boolean;
  /** One billing lookup per client, shared by every create. */
  private accountOnce: Promise<AccountInfo> | undefined;

  constructor(options: SunoOptions = {}) {
    this.client = new SunoClient({
      baselines: options.baselines ?? registryFromBaselines(),
      ...options,
    });
    this.preflightCaptcha = options.preflightCaptcha ?? false;
    this.wantModelResolution = options.resolveModel ?? true;
  }

  // --- account -------------------------------------------------------------

  billing(signal?: AbortSignal): Promise<BillingInfo> {
    return billingInfo(this.client, signal);
  }

  /**
   * Tier, plan, credits, unlocked features and usable models, in one call.
   *
   * Cached per client. Pass `refresh` after something that changes the answer,
   * such as an upgrade or a long-running process crossing a renewal.
   */
  async account(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<AccountInfo> {
    if (options.refresh === true) this.accountOnce = undefined;
    // Assigned before the await so concurrent creates share one billing call.
    this.accountOnce ??= billingInfo(this.client, options.signal)
      .then(describeAccount)
      .catch((err: unknown) => {
        // A failed lookup must not be cached, or one bad minute pins every
        // later create to the fallback model for the life of the process.
        this.accountOnce = undefined;
        throw err;
      });
    return this.accountOnce;
  }

  /**
   * Remaining credits, live.
   *
   * Deliberately NOT served from the `account()` cache. Tier, features and
   * usable models hold still for a session; the credit balance moves on every
   * create, and a queue worker checking headroom before each generation would
   * read one frozen number for the life of the process - spending blind, or
   * pausing itself forever. See examples/request-queue.ts.
   */
  async credits(
    signal?: AbortSignal,
  ): Promise<{ left: number; plan: string; tier: AccountTier; monthlyLimit: number | undefined }> {
    // describeAccount, not `info.plan.name`: a Free account has no plan object.
    const info = describeAccount(await billingInfo(this.client, signal));
    return {
      left: info.creditsLeft,
      plan: info.planName,
      tier: info.tier,
      monthlyLimit: info.monthlyLimit,
    };
  }

  /**
   * True when `accessible_features` names this feature, e.g. `get_stems`.
   *
   * A `true` is reliable. A `false` is not proof of a gate: a Free account
   * lists only `tag_upsample` and yet covers submit fine once the model is
   * resolved, because cover was never feature-gated - only its default model
   * was. Use this to skip work that is known to 403 (`get_stems`), not as a
   * blanket precondition, and let `plan_required` be the real answer.
   */
  async can(feature: string, signal?: AbortSignal): Promise<boolean> {
    const info = await this.account(signal ? { signal } : {});
    return info.features.includes(feature);
  }

  /**
   * The model a create will use when the caller names none.
   *
   * Falls back to `DEFAULT_MODEL` when billing cannot be read: a create that
   * might work beats a create that certainly does not.
   */
  private async modelFor(explicit: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (explicit !== undefined || !this.wantModelResolution) return explicit;
    try {
      const info = await this.account(signal ? { signal } : {});
      return pickDefaultModel(info.models);
    } catch {
      return undefined;
    }
  }

  private async remasterModelFor(explicit: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (explicit !== undefined || !this.wantModelResolution) return explicit;
    try {
      const info = await this.account(signal ? { signal } : {});
      return pickRemasterModel(info.raw);
    } catch {
      return undefined;
    }
  }

  async models(signal?: AbortSignal): Promise<Model[]> {
    return (await this.account(signal ? { signal } : {})).models;
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
          'Suno is asking this account for a captcha, and while it does, every create answers 422 rather than costing credits. Pass a solved token as captchaToken, or wait - the flag has been seen clearing itself within the hour.',
        alert: true,
      });
    }
  }

  /** Custom mode: your lyrics, your style prompt, your title. */
  async generate(options: CustomGenerateOptions): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    const model = await this.modelFor(options.model, options.signal);
    const clips = await submitGenerate(
      this.client,
      buildCustomBody(model === undefined ? options : { ...options, model }),
      options.signal,
    );
    return new GenerationJob(this.client, clips);
  }

  /** Inspiration mode: a description, and Suno writes the lyrics. */
  async describe(options: DescribeGenerateOptions): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    const model = await this.modelFor(options.model, options.signal);
    const clips = await submitGenerate(
      this.client,
      buildDescribeBody(model === undefined ? options : { ...options, model }),
      options.signal,
    );
    return new GenerationJob(this.client, clips);
  }

  async cover(clipId: string, options: CoverOptions = {}): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    const model = await this.modelFor(options.model, options.signal);
    const resolved = model === undefined ? options : { ...options, model };
    return new GenerationJob(this.client, await cover(this.client, clipId, resolved));
  }

  async remaster(clipId: string, options: RemasterOptions = {}): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    const model = await this.remasterModelFor(options.model, options.signal);
    const resolved = model === undefined ? options : { ...options, model };
    return new GenerationJob(this.client, await remaster(this.client, clipId, resolved));
  }

  /** Experimental: see docs/STATUS.md before relying on this. */
  async extend(clipId: string, options: ExtendOptions): Promise<GenerationJob> {
    await this.assertNotGated(options.signal);
    const model = await this.modelFor(options.model, options.signal);
    const resolved = model === undefined ? options : { ...options, model };
    return new GenerationJob(this.client, await extend(this.client, clipId, resolved));
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

  /**
   * Public playlist by share link or id. No session required: this is the GET
   * suno.com makes for anyone who opens the link.
   */
  playlist(idOrUrl: string, signal?: AbortSignal): Promise<Playlist> {
    return getPlaylist(this.client, idOrUrl, signal ? { signal } : {});
  }

  /**
   * Decrypted audio stream, obtained the way suno.com's player gets it, with
   * no download credit spent. An id is looked up first, which needs a session;
   * pass a `Clip` (from `playlist()`, say) to play signed out.
   */
  async playTrack(idOrClip: string | Clip, signal?: AbortSignal): Promise<PlaybackStream> {
    const clip = typeof idOrClip === 'string' ? await this.info(idOrClip, signal) : idOrClip;
    return playTrack(this.client, clip, signal ? { signal } : {});
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

  /**
   * Fetch a public playlist and write every clip. Defaults to `playback` so it
   * does not spend the account's download quota; pass `source: 'download'` to
   * use the sanctioned button instead.
   */
  async downloadPlaylist(
    idOrUrl: string,
    options: DownloadOptions,
  ): ReturnType<typeof downloadClips> {
    const playlist = await getPlaylist(this.client, idOrUrl, options.signal ? { signal: options.signal } : {});
    return downloadClips(this.client, playlist.clips, {
      ...options,
      source: options.source ?? 'playback',
    });
  }
}
