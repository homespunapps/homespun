// Wire types for the Homespun relay HTTP + WebSocket API.
//
// These mirror the relay's public response shapes (see the relay's
// src/types.ts, src/http/serialize.ts and src/http/routes/*). They are
// re-declared here rather than imported from @homespunapps/relay so that @homespunapps/core
// stays pure and framework-free — no Prisma, no Hono, no server deps.

export type AuthorKind = "human" | "agent" | "system";

/** A single event envelope as emitted by the relay. */
export interface HomespunEvent {
  id: string;
  app_id: string;
  author: { kind: AuthorKind; id: string };
  ts: string;
  type: string;
  data: unknown;
  causation_id: string | null;
  idempotency_key: string | null;
  /**
   * The template version this event was written under — the app's pinned
   * templateVersionId at the moment of the write. Stamped at write time and
   * never rewritten, so a downstream upgrade (#267) can read old events
   * under the new schema (Level 1 polymorphic render). Nullable for events
   * written before #268 landed; the relay's one-shot migration backfilled
   * those from the app's current pin where possible.
   */
  template_version_id: string | null;
  /** Denormalised integer version number for `template_version_id`. */
  template_version: number | null;
}

/**
 * One record on the wire (#287). Returned by the records CRUD routes
 * (#292) and by the WS record-delta messages (#294). Structurally
 * identical to the relay-side SerializedRecord; mirrored here so the
 * core package is self-contained.
 */
export interface SerializedRecord {
  id: string;
  collection: string;
  key: string;
  data: unknown;
  version: number;
  seq: number;
  author: { kind: AuthorKind; id: string };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Wire shape for a soft-deleted record on the WS channel. */
export interface DeletedRecordRef {
  id: string;
  key: string;
  seq: number;
  deleted_at: string;
}

/** Discriminated wire shape for record-state changes. */
export type RecordDeltaMessage =
  | { kind: "record.upsert"; collection: string; record: SerializedRecord }
  | { kind: "record.delete"; collection: string; record: DeletedRecordRef }
  | { kind: "record.replay.complete"; collection: string; seq: number };

/**
 * An template: discriminated on `type`. `html-inline` carries raw HTML in
 * `source`; `html-ref` carries a URL the relay/shell fetches on the human's
 * behalf. The discriminant keeps the type↔source coupling explicit.
 */
export type Template =
  | { type: "html-inline"; source: string }
  | { type: "html-ref"; source: string };

/** Optional webhook callback config. */
export interface Callback {
  url: string;
  events: string[];
  secret: string;
}

/**
 * Response from GET /v1/keys — the calling agent's own key info. The relay
 * scopes this to the authenticated agent: it returns ONE key (the caller's),
 * not a list.
 */
export interface KeyInfo {
  agent_id: string;
  name: string | null;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/**
 * Response from GET /v1/taste, PUT /v1/taste — the calling agent's freeform
 * "taste notes" markdown attachment (presentation preferences the agent has picked
 * up from human feedback over time). `taste` and `updated_at` are null when
 * the agent has never written notes; `bytes` is the utf8 byte length and 0
 * when `taste` is null.
 */
export interface TasteInfo {
  taste: string | null;
  updated_at: string | null;
  bytes: number;
}

/** A feedback `type` discriminant accepted by POST /v1/feedback. */
export type FeedbackType = "bug" | "feature" | "note";

/** Response from POST /v1/feedback — id, type, created_at only (no message echo). */
export interface FeedbackSubmission {
  id: string;
  type: FeedbackType;
  created_at: string;
}

/** A row from GET /v1/feedback, the full record including message. */
export interface FeedbackRecord {
  id: string;
  type: FeedbackType;
  message: string;
  app_id: string | null;
  created_at: string;
}

/** Response from GET /v1/feedback — page of the calling agent's own submissions. */
export interface FeedbackPage {
  items: FeedbackRecord[];
  next_before?: string;
}

/** A relay error envelope. */
export interface RelayError {
  code: string;
  message?: string;
  details?: unknown;
  /** Agent-friendly remediation hint. */
  hint?: string;
  /** Whether retrying the same request may succeed. */
  retryable?: boolean;
  /** Documentation URL for this error class (snake_case on the wire). */
  docs_url?: string;
}
