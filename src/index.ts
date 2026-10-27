export { Suno, type SunoOptions } from './suno.js';
export { SunoClient, type SunoClientOptions, type RequestInfo, type DriftBaselines } from './client.js';
export { SunoError, planGateDetail, type SunoErrorCode } from './errors.js';
export { GenerationJob, allTerminal, pendingIds, type JobUpdate, type PollOptions } from './poll.js';

export {
  DEFAULT_MODEL,
  GENERATE_PATH,
  baseWireBody,
  buildCustomBody,
  buildDescribeBody,
  buildMetadata,
  validateSubmission,
  type ControlSliders,
  type CustomGenerateOptions,
  type DescribeGenerateOptions,
  type GenerateWireBody,
} from './api/generate.js';

export {
  DEFAULT_REMASTER_MODEL,
  buildCoverBody,
  buildExtendBody,
  buildRemasterBody,
  type CoverOptions,
  type ExtendOptions,
  type RemasterOptions,
} from './api/derive.js';

export {
  describeAccount,
  getAccount,
  pickDefaultModel,
  pickRemasterModel,
  type AccountInfo,
  type AccountTier,
} from './api/account.js';

export { CLIP_PATH, iterateClips, listClips, getClip, getClips, searchClips, type ListOptions } from './api/feed.js';
export {
  alignedLyrics,
  billingInfo,
  captchaCheck,
  generateLyrics,
  setReaction,
  toLrc,
  type LyricsOptions,
  type ReactionType,
  type SetMetadataOptions,
} from './api/misc.js';
export {
  MAX_SEARCH_SIZE,
  SEARCH_PATH,
  SEARCH_RANKINGS,
  SUGGEST_PATH,
  searchPublic,
  searchSuggest,
  type PublicSearchOptions,
  type PublicSearchPage,
  type SearchRanking,
  type SuggestedPlaylist,
  type SuggestOptions,
  type Suggestion,
} from './api/search.js';
export {
  PARENT_PATH,
  REMIXES_PAGE_SIZE,
  REMIXES_PATH,
  REMIX_COUNT_PATH,
  SIMILAR_PATH,
  iterateRemixes,
  listRemixes,
  parentClip,
  remixCount,
  remixSources,
  similarClips,
  type ParentClip,
  type RemixCount,
  type RemixesPage,
  type RemixSource,
} from './api/related.js';
export {
  COMMENTS_PAGE_SIZE,
  COMMENT_ORDERS,
  deleteComment,
  iterateComments,
  listComments,
  postComment,
  setCommentReaction,
  type Comment,
  type CommentOrder,
  type CommentReaction,
  type CommentReply,
  type PostCommentOptions,
  type CommentsOptions,
  type CommentsPage,
} from './api/comments.js';
export {
  IMAGE_TYPES,
  IMAGE_UPLOAD_PATH,
  PROFILE_V2_PATH,
  SOCIAL_LINKS,
  getEditableProfile,
  setAvatar,
  updateProfile,
  uploadImage,
  type EditableProfile,
  type ImageExtension,
  type ProfileChanges,
  type SocialLink,
  type UploadedImage,
} from './api/profile-edit.js';
export {
  LISTEN_HISTORY_MAX,
  LISTEN_HISTORY_PATH,
  PLAYBAR_STATE_PATH,
  getPlaybarState,
  iterateListenHistory,
  listListenHistory,
  type Listen,
  type ListenHistoryPage,
  type PlaybarState,
} from './api/listening.js';
export {
  NOTIFICATIONS_PATH,
  NOTIFICATION_BADGE_PATH,
  listNotifications,
  notificationText,
  unreadNotificationCount,
  type Notification,
} from './api/notifications.js';
export {
  FOLLOW_PATH,
  PROFILES_PATH,
  PROFILE_PAGE_SIZE,
  getProfile,
  iterateFollowers,
  iterateFollowing,
  iterateProfileClips,
  iterateRemixesInspired,
  listFollowers,
  listFollowing,
  listRemixesInspired,
  setFollowing,
  type FollowPage,
  type RemixesInspiredPage,
  type ProfileOptions,
  type ProfilePage,
  type ProfileSummary,
} from './api/profile.js';

export {
  artworkUrl,
  downloadClip,
  downloadClips,
  clipFilename,
  type DownloadOptions,
  type DownloadSource,
} from './download.js';
export {
  MY_PLAYLISTS_PATH,
  PLAYLIST_CREATE_PATH,
  PLAYLIST_PATH,
  PLAYLIST_SET_METADATA_PATH,
  PLAYLIST_TRASH_PATH,
  PLAYLIST_UPDATE_CLIPS_PATH,
  addPlaylistClips,
  createPlaylist,
  extractPlaylistId,
  getPlaylist,
  iterateMyPlaylists,
  listMyPlaylists,
  removePlaylistClips,
  setPlaylistMetadata,
  setPlaylistTrashed,
  type GetPlaylistOptions,
  type MyPlaylistsPage,
  type Playlist,
  type PlaylistEntry,
  type PlaylistPage,
  type PlaylistSummary,
  type SetPlaylistMetadataOptions,
} from './api/playlist.js';
export {
  MANGO_RIGHTS_PATH,
  createMangoDecipher,
  decryptMangoAudio,
  isPlayableAudio,
  mangoRights,
  pickPlaybackMedia,
  playTrack,
  type MangoRights,
  type PlaybackStream,
  type PlayTrackOptions,
} from './api/mango.js';
export {
  DOWNLOAD_FORMATS,
  authorizeDownload,
  downloadTicket,
  resolveDownloadUrl,
  type AuthorizeResult,
  type DownloadFormat,
  type DownloadTicket,
} from './api/download-unlock.js';


export {
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

export {
  browserToken,
  clerkRefreshJwt,
  clerkTokenExchange,
  decodeJwtClaims,
  isJwtExpired,
  normalizeCookieInput,
  type AuthState,
} from './auth.js';

export {
  BROWSER_NAMES,
  DEVICE_COOKIE_NAME,
  SESSION_COOKIE_HOST,
  SESSION_COOKIE_NAME,
  chooseCookie,
  clientIdOf,
  findSessionCookies,
  preferLongestLived,
  type BrowserName,
  type CookieChoice,
  type FindCookieOptions,
  type FoundCookie,
} from './browser-cookie.js';
export { FileAuthStore, MemoryAuthStore, defaultAuthPath, type AuthStore } from './store.js';

export {
  detectDrift,
  formatDriftReport,
  type DriftFinding,
  type DriftReport,
  type DriftSeverity,
} from './drift/detect.js';
export {
  emptyBaseline,
  foldIntoBaseline,
  shapeOf,
  type Baseline,
  type Shape,
  type TypeKind,
} from './drift/shape.js';
export { CONSUMED_PATHS, loadBaselines, registryFromBaselines, registryFromMap } from './drift/registry.js';

export {
  AUDIO_FORBIDDEN_URL,
  BillingInfoSchema,
  ClipReactionSchema,
  ClipSchema,
  ClipStatus,
  FeedPageSchema,
  GenerateResponseSchema,
  LyricsResultSchema,
  MediaUrlSchema,
  TERMINAL_STATUSES,
  isFetchableUrl,
  isTerminal,
  type AlignedWord,
  type BillingInfo,
  type CaptchaCheck,
  type Clip,
  type ClipReaction,
  type FeedPage,
  type LyricsResult,
  type MediaUrl,
  type Model,
  type PersonaInfo,
  type Plan,
} from './schemas.js';
