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
import { getClip, getClips, iterateClips, listClips, searchClips, type ListOptions } from './api/feed.js';
import {
  alignedLyrics,
  billingInfo,
  captchaCheck,
  generateLyrics,
  getPersona,
  requestStems,
  setMetadata,
  setReaction,
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
import {
  addPlaylistClips,
  createPlaylist,
  extractPlaylistId,
  getPlaylist,
  iterateMyPlaylists,
  removePlaylistClips,
  setPlaylistMetadata,
  setPlaylistTrashed,
  type GetPlaylistOptions,
  type Playlist,
  type PlaylistSummary,
  type SetPlaylistMetadataOptions,
} from './api/playlist.js';
import {
  getProfile,
  iterateFollowers,
  iterateFollowing,
  iterateProfileClips,
  iterateRemixesInspired,
  setFollowing,
  type ProfileOptions,
  type ProfilePage,
  type ProfileSummary,
} from './api/profile.js';
import {
  searchPublic,
  searchSuggest,
  type PublicSearchOptions,
  type PublicSearchPage,
  type SuggestOptions,
  type Suggestion,
} from './api/search.js';
import {
  iterateRemixes,
  parentClip,
  remixCount,
  remixSources,
  similarClips,
  type ParentClip,
  type RemixCount,
  type RemixSource,
} from './api/related.js';
import {
  deleteComment,
  iterateComments,
  listComments,
  postComment,
  setCommentReaction,
  type Comment,
  type CommentOrder,
  type CommentReaction,
  type CommentReply,
  type CommentsOptions,
  type CommentsPage,
  type PostCommentOptions,
} from './api/comments.js';
import {
  getEditableProfile,
  setAvatar,
  updateProfile,
  type EditableProfile,
  type ImageExtension,
  type ProfileChanges,
  type UploadedImage,
} from './api/profile-edit.js';
import { decodeJwtClaims } from './auth.js';
import { getPlaybarState, iterateListenHistory, type Listen, type PlaybarState } from './api/listening.js';
import { listNotifications, unreadNotificationCount, type Notification } from './api/notifications.js';
import { artworkUrl, downloadClip, downloadClips, type DownloadOptions } from './download.js';
import { SunoError } from './errors.js';
import { GenerationJob } from './poll.js';
import { untilAborted } from './internal/retry.js';
import { hasSession } from './internal/session.js';
import { registryFromBaselines } from './drift/registry.js';
import type { AccountTier } from './api/account.js';
import { isFetchableUrl, type AlignedWord, type BillingInfo, type CaptchaCheck, type Clip, type ClipReaction, type FeedPage, type LyricsResult, type Model, type PersonaInfo } from './schemas.js';

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
    // The shared call carries no caller's signal: one caller cancelling must
    // not fail the others waiting on it. Each waits under its own signal.
    if (this.accountOnce === undefined) {
      const lookup: Promise<AccountInfo> = billingInfo(this.client)
        .then(describeAccount)
        .catch((err: unknown) => {
          // A failed lookup must not be cached, or one bad minute pins every
          // later create to the fallback model for the life of the process.
          // Only this lookup, though: a newer one may have replaced it.
          if (this.accountOnce === lookup) this.accountOnce = undefined;
          throw err;
        });
      this.accountOnce = lookup;
    }
    return untilAborted(this.accountOnce, options.signal);
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
    } catch (err) {
      // A cancel is not billing being unavailable: falling back would carry
      // on and submit the create the caller just cancelled.
      if (signal?.aborted === true) throw err;
      return undefined;
    }
  }

  private async remasterModelFor(explicit: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
    if (explicit !== undefined || !this.wantModelResolution) return explicit;
    try {
      const info = await this.account(signal ? { signal } : {});
      return pickRemasterModel(info.raw);
    } catch (err) {
      if (signal?.aborted === true) throw err;
      return undefined;
    }
  }

  async models(signal?: AbortSignal): Promise<Model[]> {
    return (await this.account(signal ? { signal } : {})).models;
  }

  captchaCheck(ctype = 'generation', signal?: AbortSignal): Promise<CaptchaCheck> {
    return captchaCheck(this.client, ctype, signal);
  }

  // Both drop the account cache: tier, models and default belong to the
  // session, and keeping them sent the old account's default model with the
  // new account's session - a 403 on every create until a restart.
  async login(cookie: string, signal?: AbortSignal): Promise<unknown> {
    const state = await this.client.login(cookie, signal);
    this.accountOnce = undefined;
    return state;
  }

  async logout(): Promise<void> {
    await this.client.logout();
    this.accountOnce = undefined;
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

  iterate(
    options: { limit?: number; maxPages?: number; liked?: boolean; signal?: AbortSignal } = {},
  ): AsyncGenerator<Clip, void, undefined> {
    return iterateClips(this.client, options);
  }

  /** Search this account's own library. For everyone's songs, see `searchPublic`. */
  search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<FeedPage> {
    return searchClips(this.client, query, options);
  }

  /**
   * Search every public song on Suno, the way suno.com's search box does.
   * Needs a session. Results stop about 200 deep, whatever `totalHits` says.
   */
  searchPublic(term: string, options: PublicSearchOptions = {}): Promise<PublicSearchPage> {
    return searchPublic(this.client, term, options);
  }

  get(ids: readonly string[], signal?: AbortSignal): Promise<Clip[]> {
    return getClips(this.client, ids, signal);
  }

  /** What suno.com's search box offers while typing. Needs a session. */
  suggest(term: string, options: SuggestOptions = {}): Promise<Suggestion[]> {
    return searchSuggest(this.client, term, options);
  }

  // --- around a song -------------------------------------------------------

  /** Ten songs Suno considers like this one. Needs a session. */
  similar(clipId: string, signal?: AbortSignal): Promise<Clip[]> {
    return similarClips(this.client, clipId, signal);
  }

  /** Every public remix of a clip, each once. Needs a session. */
  remixes(
    clipId: string,
    options: { pageSize?: number; maxPages?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<Clip, void, undefined> {
    return iterateRemixes(this.client, clipId, options);
  }

  /** How many remixes a clip has. Needs a session. */
  remixCount(clipId: string, signal?: AbortSignal): Promise<RemixCount> {
    return remixCount(this.client, clipId, signal);
  }

  /** The songs a remix was made from; empty for an original. No session needed. */
  remixSources(clipId: string, signal?: AbortSignal): Promise<RemixSource[]> {
    return remixSources(this.client, clipId, signal);
  }

  /** The public clip this one was derived from, if any. Needs a session. */
  parent(clipId: string, signal?: AbortSignal): Promise<ParentClip | undefined> {
    return parentClip(this.client, clipId, signal);
  }

  /** One page of a song's comments. No session needed. */
  commentsPage(clipId: string, options: CommentsOptions = {}): Promise<CommentsPage> {
    return listComments(this.client, clipId, options);
  }

  /** Every top-level comment on a song, each once. No session needed. */
  comments(
    clipId: string,
    options: { order?: CommentOrder; maxPages?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<Comment, void, undefined> {
    return iterateComments(this.client, clipId, options);
  }

  /** Post a comment under a song, public at once. Never retried. */
  comment(clipId: string, content: string, options: PostCommentOptions = {}): Promise<CommentReply> {
    return postComment(this.client, clipId, content, options);
  }

  /** Delete one of this account's comments. */
  deleteComment(commentId: string, signal?: AbortSignal): Promise<void> {
    return deleteComment(this.client, commentId, signal);
  }

  /** `LIKE`, `DISLIKE`, or `null` to take it back. */
  reactToComment(
    commentId: string,
    reaction: CommentReaction,
    signal?: AbortSignal,
  ): Promise<{ likes: number | undefined; reaction: CommentReaction }> {
    return setCommentReaction(this.client, commentId, reaction, signal);
  }

  // --- this account's profile ----------------------------------------------

  /** The handle of the signed-in account, read from its session. */
  async handle(signal?: AbortSignal): Promise<string> {
    const { jwt } = await this.client.ensureAuth(signal);
    const handle = jwt ? decodeJwtClaims(jwt)?.['suno/handle'] : undefined;
    if (typeof handle !== 'string' || handle === '') {
      throw new SunoError({ code: 'response_invalid', message: 'the session names no handle' });
    }
    return handle;
  }

  /** This account's profile as it edits it: name, avatar, bio, genres, links. */
  async myProfile(signal?: AbortSignal): Promise<EditableProfile> {
    return getEditableProfile(this.client, await this.handle(signal), signal);
  }

  /** Change this account's name, bio, genres or links. Only what is given changes. */
  async updateProfile(changes: ProfileChanges, signal?: AbortSignal): Promise<string[]> {
    return updateProfile(this.client, await this.handle(signal), changes, signal);
  }

  /** Upload an image and make it this account's avatar. */
  async setAvatar(bytes: Uint8Array, extension: ImageExtension, signal?: AbortSignal): Promise<UploadedImage> {
    return setAvatar(this.client, await this.handle(signal), bytes, extension, signal);
  }

  // --- this account's listening -------------------------------------------

  /** The account's last 100 listens on Suno, newest first. */
  listenHistory(options: { maxPages?: number; signal?: AbortSignal } = {}): AsyncGenerator<Listen, void, undefined> {
    return iterateListenHistory(this.client, options);
  }

  /** Where suno.com's player stands: queue, song, second. Read only. */
  playbarState(signal?: AbortSignal): Promise<PlaybarState> {
    return getPlaybarState(this.client, signal);
  }

  notifications(signal?: AbortSignal): Promise<Notification[]> {
    return listNotifications(this.client, signal);
  }

  unreadNotifications(signal?: AbortSignal): Promise<number> {
    return unreadNotificationCount(this.client, signal);
  }

  /**
   * Playlist by share link or id. Signed out by default: this is the GET
   * suno.com makes for anyone who opens the link. Pass `{ signedIn: true }` to
   * read one of the account's own playlists, which start out private. A bare
   * `AbortSignal` is still accepted in place of the options.
   */
  playlist(idOrUrl: string, options: GetPlaylistOptions | AbortSignal = {}): Promise<Playlist> {
    return getPlaylist(this.client, idOrUrl, options instanceof AbortSignal ? { signal: options } : options);
  }

  /**
   * Decrypted audio stream, obtained the way suno.com's player gets it, with
   * no download credit spent. An id is looked up first through `info()`, which
   * works signed out for any public clip; pass a `Clip` to skip that request.
   */
  async playTrack(idOrClip: string | Clip, signal?: AbortSignal): Promise<PlaybackStream> {
    const clip = typeof idOrClip === 'string' ? await this.info(idOrClip, signal) : idOrClip;
    return playTrack(this.client, clip, signal ? { signal } : {});
  }

  /**
   * One clip by id, anyone's, signed in or not.
   *
   * The account's own clips are read from feed-by-ids, as before 0.6.0, so a
   * clip still rendering reads the way the poller sees it. Anything that
   * finds nothing there, and every id when no session is stored, falls back
   * to the public `GET /api/clip/{id}`.
   */
  async info(id: string, signal?: AbortSignal): Promise<Clip> {
    // Signed out there is no library to look in. A fired signal goes on to
    // the feed call, which refuses it the usual way.
    const signedIn = signal?.aborted === true || (await hasSession(this.client, signal));
    const owned = signedIn
      ? await getClips(this.client, [id], signal).catch((err: unknown) => {
          // An id feed-by-ids does not know is for the public endpoint to
          // answer, including with its own 404.
          if (err instanceof SunoError && err.code === 'not_found') return [];
          throw err;
        })
      : [];
    return owned[0] ?? getClip(this.client, id, signal);
  }

  /** Rehydrate a job from ids, e.g. after a process restart. */
  async job(ids: readonly string[], signal?: AbortSignal): Promise<GenerationJob> {
    const clips = await getClips(this.client, ids, signal);
    // Track the ids asked for, not the clips the feed happened to return: one
    // still rendering can be missing from it, and dropping it let wait()
    // report done without ever seeing that clip.
    return new GenerationJob(this.client, clips, ids);
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

  // --- people --------------------------------------------------------------

  /**
   * One page of a public profile. No session needed; with one,
   * `is_following` is about this account.
   */
  profile(handle: string, options: ProfileOptions = {}): Promise<ProfilePage> {
    return getProfile(this.client, handle, options);
  }

  /** Every public clip on a profile, pinned ones included, each once. */
  profileClips(
    handle: string,
    options: { clipsSortBy?: string; maxPages?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<Clip, void, undefined> {
    return iterateProfileClips(this.client, handle, options);
  }

  /** The profiles `handle` follows. Needs a session. */
  following(
    handle: string,
    options: { maxPages?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ProfileSummary, void, undefined> {
    return iterateFollowing(this.client, handle, options);
  }

  /** The profiles following `handle`. Needs a session. */
  followers(
    handle: string,
    options: { maxPages?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<ProfileSummary, void, undefined> {
    return iterateFollowers(this.client, handle, options);
  }

  /** Songs others made from this creator's songs, each once. Needs a session. */
  remixesInspired(
    handle: string,
    options: { pageSize?: number; maxPages?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<Clip, void, undefined> {
    return iterateRemixesInspired(this.client, handle, options);
  }

  follow(handle: string, signal?: AbortSignal): Promise<void> {
    return setFollowing(this.client, handle, true, signal);
  }

  unfollow(handle: string, signal?: AbortSignal): Promise<void> {
    return setFollowing(this.client, handle, false, signal);
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
      // The 403 sentinel is not a URL anyone can play. See AUDIO_FORBIDDEN_URL.
      audioUrl: isFetchableUrl(clip.audio_url) ? clip.audio_url : undefined,
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

  /** Like a clip. It then shows up in `list({ liked: true })`. */
  like(clipId: string, signal?: AbortSignal): Promise<ClipReaction> {
    return setReaction(this.client, clipId, 'LIKE', signal);
  }

  unlike(clipId: string, signal?: AbortSignal): Promise<ClipReaction> {
    return setReaction(this.client, clipId, null, signal);
  }

  // --- playlists -----------------------------------------------------------

  /** Every playlist this account owns, trashed ones left out. */
  myPlaylists(options: { maxPages?: number; signal?: AbortSignal } = {}): AsyncGenerator<PlaylistSummary, void, undefined> {
    return iterateMyPlaylists(this.client, options);
  }

  /** A new, empty, private playlist. */
  createPlaylist(name: string, signal?: AbortSignal): Promise<PlaylistSummary> {
    return createPlaylist(this.client, name, signal);
  }

  addToPlaylist(playlistIdOrUrl: string, clipIds: readonly string[], signal?: AbortSignal): Promise<void> {
    return addPlaylistClips(this.client, playlistIdOrUrl, clipIds, signal);
  }

  /**
   * Take clips out of a playlist by id.
   *
   * Suno removes by position too, so this reads the playlist first, with the
   * session, to find where each clip sits. A clip that is not in it is
   * `not_found`, and nothing is removed. A clip listed twice loses one entry.
   */
  async removeFromPlaylist(playlistIdOrUrl: string, clipIds: readonly string[], signal?: AbortSignal): Promise<void> {
    const pid = extractPlaylistId(playlistIdOrUrl);
    // Checked before the read, not after it: an empty list is a mistake
    // whatever the playlist holds.
    if (clipIds.length === 0) throw new SunoError({ code: 'invalid_input', message: 'name at least one clip' });
    const playlist = await getPlaylist(this.client, pid, { signedIn: true, ...(signal ? { signal } : {}) });
    const entries = clipIds.map((id) => {
      const entry = playlist.entries.find((e) => e.clipId === id);
      if (!entry) throw new SunoError({ code: 'not_found', message: `clip ${id} is not in playlist ${pid}` });
      return entry;
    });
    return removePlaylistClips(this.client, pid, entries, signal);
  }

  /** Rename a playlist and set its description; the server wants both. */
  updatePlaylist(playlistIdOrUrl: string, options: SetPlaylistMetadataOptions): Promise<PlaylistSummary> {
    return setPlaylistMetadata(this.client, playlistIdOrUrl, options);
  }

  trashPlaylist(playlistIdOrUrl: string, signal?: AbortSignal): Promise<void> {
    return setPlaylistTrashed(this.client, playlistIdOrUrl, true, signal);
  }

  /** Unverified: sends `undo_trash: true`, which has not been seen working. */
  restorePlaylist(playlistIdOrUrl: string, signal?: AbortSignal): Promise<void> {
    return setPlaylistTrashed(this.client, playlistIdOrUrl, false, signal);
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
