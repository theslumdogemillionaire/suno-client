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

export { iterateClips, listClips, getClips, searchClips, type ListOptions } from './api/feed.js';
export {
  alignedLyrics,
  billingInfo,
  captchaCheck,
  generateLyrics,
  toLrc,
  type LyricsOptions,
  type SetMetadataOptions,
} from './api/misc.js';

export { artworkUrl, downloadClip, downloadClips, clipFilename, type DownloadOptions } from './download.js';
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
  SESSION_COOKIE_HOST,
  SESSION_COOKIE_NAME,
  findSessionCookies,
  preferLongestLived,
  type BrowserName,
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
  type FeedPage,
  type LyricsResult,
  type MediaUrl,
  type Model,
  type PersonaInfo,
  type Plan,
} from './schemas.js';
