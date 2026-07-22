// @homespunapps/core — typed client for the Homespun relay HTTP + WebSocket API.
// Pure and framework-free: no argv, no MCP, no server deps.

export { HomespunClient, HomespunApiError } from "./client.js";
export type {
  ClientOptions,
  RelayResponse,
  AttachmentRef,
  UploadBlobOptions,
  PresignBlobOptions,
  AttachmentTokenMintResponse,
  ListBlobsOptions,
  AttachmentTokenAuditEntry,
  AttachmentTokenListResponse,
  QueryResponse,
  AppAsset,
  DeployAppRequest,
  DeployAppResponse,
  RedeployAppRequest,
  RedeployAppResponse,
  DeployCheckRequest,
  DeployCheckResult,
  KeyMintResult,
  AppSummary,
  AppDetail,
  AppsPage,
  AppDomain,
  AppDomainDnsRecord,
  AppMember,
  AddAppMemberResult,
  AppRow,
  AppRowsPage,
  ListScalar,
  ListWhereCondition,
  ListSortSpec,
  BatchRowInput,
  BatchRowResult,
  BatchResult,
  BatchWriteOptions,
  AppFeedEntry,
  AppFeedPage,
  CommunitySetupStep,
} from "./client.js";

export { openStream } from "./stream.js";
export type {
  OpenStreamOptions,
  StreamHandlers,
  StreamHandle,
} from "./stream.js";

export { openAppStream, appWsUrlFromAppUrl } from "./app-stream.js";
export type {
  OpenAppStreamOptions,
  AppStreamHandlers,
  AppStreamHandle,
} from "./app-stream.js";

export { registerAgent } from "./register.js";
export type { RegisterAgentOptions, RegisterAgentResult } from "./register.js";

export { feedbackTypeSchema, submitFeedbackSchema } from "./schemas.js";

export {
  validateIconEmoji,
  isValidIconEmoji,
  isRasterImageMime,
  RASTER_ICON_MIME_ALLOWLIST,
  MAX_ICON_EMOJI_BYTES,
} from "./icons.js";
export type { RasterIconMime } from "./icons.js";

export {
  MAX_EVENT_TYPE_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_RESPONSE_SNIPPET_LENGTH,
  MAX_FRAME_SNIPPET_LENGTH,
} from "./limits.js";

export type {
  AuthorKind,
  HomespunEvent,
  SerializedRecord,
  DeletedRecordRef,
  RecordDeltaMessage,
  Template,
  KeyInfo,
  TasteInfo,
  FeedbackType,
  FeedbackSubmission,
  FeedbackRecord,
  FeedbackPage,
  Callback,
  RelayError,
} from "./types.js";
