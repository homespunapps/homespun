// Homespun relay HTTP client. Pure: no argv, no process.env reads, no MCP.
// The caller supplies the relay base URL + API key explicitly.

import type {
  FeedbackPage,
  FeedbackSubmission,
  FeedbackType,
  KeyInfo,
  TasteInfo,
} from "./types.js";
import { MAX_RESPONSE_SNIPPET_LENGTH } from "./limits.js";

export interface ClientOptions {
  /** Relay base URL, e.g. https://homespun.example.com. Trailing slash is trimmed. */
  url: string;
  /** Agent API key (bearer token). */
  apiKey: string;
  /** Optional fetch override (defaults to global fetch). */
  fetch?: typeof fetch;
  /**
   * Optional client version string sent as `x-homespun-cli-version` on every
   * request. The CLI passes its own `VERSION` constant here so a relay can
   * detect version skew and respond with a `cli_upgrade_required` error
   * (HTTP 426) when the CLI is below the relay's minimum supported version.
   * Library callers (non-CLI) can leave this unset — the header is omitted
   * and the relay treats the request as version-unknown.
   */
  cliVersion?: string;
}

/** Low-level relay response: ok flag, HTTP status, parsed JSON body. */
export interface RelayResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

/** Response from POST /v1/query. */
export interface QueryResponse {
  /** Ordered column names exactly as DuckDB returned them. */
  columns: string[];
  /** Result rows; each row is an array of values aligned to `columns`. */
  rows: unknown[][];
  /** True if the result was capped by the relay's per-query row cap. */
  truncated: boolean;
  /** Tells the caller which apps the query saw and how it was scoped. */
  scope: { kind: "human" | "agent"; app_count: number };
  /** Wall-clock milliseconds the relay spent serving the query. */
  elapsed_ms: number;
}

/**
 * An error thrown by the typed operations when the relay returns a non-2xx
 * response (or the request fails outright). Carries the HTTP status and the
 * relay error envelope so callers can branch on `code`.
 */
export class HomespunApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  /** Agent-friendly remediation hint, when the relay supplies one. */
  readonly hint?: string;
  /** Whether retrying the same request may succeed (e.g. 429). */
  readonly retryable?: boolean;
  /** Documentation URL for this error class (mapped from the wire's `docs_url`). */
  readonly docsUrl?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    extra?: { hint?: string; retryable?: boolean; docsUrl?: string },
  ) {
    super(message);
    this.name = "HomespunApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = extra?.hint;
    this.retryable = extra?.retryable;
    this.docsUrl = extra?.docsUrl;
  }
}

export class HomespunClient {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly cliVersion: string | undefined;

  constructor(opts: ClientOptions) {
    this.base = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.cliVersion = opts.cliVersion;
  }

  /** Relay base URL (trailing slash trimmed). */
  get baseUrl(): string {
    return this.base;
  }

  /** WebSocket base URL derived from the relay base URL (http→ws, https→wss). */
  get wsBaseUrl(): string {
    const u = new URL(this.base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString().replace(/\/$/, "");
  }

  /**
   * Low-level HTTP helper. Mirrors the relay API contract: Bearer auth,
   * JSON bodies, 204 handled. Never throws on non-2xx — returns `ok: false`.
   * Network failures return `{ ok: false, status: 0, ... }`.
   */
  async call(
    method: string,
    path: string,
    body?: object,
  ): Promise<RelayResponse> {
    const url = this.base + path;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: "Bearer " + this.apiKey,
          ...(body ? { "content-type": "application/json" } : {}),
          // x-homespun-cli-version drives the relay's version-skew check. Header
          // is omitted entirely when no version was supplied so the relay
          // can distinguish "old CLI" from "non-CLI caller".
          ...(this.cliVersion
            ? { "x-homespun-cli-version": this.cliVersion }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        status: 0,
        data: { error: { code: "fetch_error", message: msg } },
      };
    }
    let data: unknown = null;
    if (res.status !== 204) {
      const text = await res.text().catch(() => "");
      if (text !== "") {
        try {
          data = JSON.parse(text);
        } catch {
          // Body was not JSON (HTML error page, plain-text proxy error, …).
          // Don't discard it — app the raw text so callers can diagnose.
          const snippet =
            text.length > MAX_RESPONSE_SNIPPET_LENGTH
              ? text.slice(0, MAX_RESPONSE_SNIPPET_LENGTH) + "…"
              : text;
          data = {
            error: {
              code: "non_json_response",
              message: `relay returned a non-JSON body (status ${res.status})`,
              details: { body: snippet },
            },
          };
        }
      }
    }
    return { ok: res.ok, status: res.status, data };
  }

  /** Assert a 2xx body is a non-null object before treating it as typed JSON. */
  private asObject<T>(r: RelayResponse): T {
    if (
      r.data === null ||
      typeof r.data !== "object" ||
      Array.isArray(r.data)
    ) {
      throw new HomespunApiError(
        r.status,
        "invalid_response",
        `relay returned a ${r.status} with a non-object body`,
        { body: r.data },
      );
    }
    return r.data as T;
  }

  /** Throw a HomespunApiError from a failed RelayResponse. */
  private fail(r: RelayResponse): never {
    const err = (
      r.data as {
        error?: {
          code?: string;
          message?: string;
          details?: unknown;
          hint?: string;
          retryable?: boolean;
          docs_url?: string;
        };
      } | null
    )?.error;
    throw new HomespunApiError(
      r.status,
      err?.code ?? "relay_error",
      err?.message ?? `relay returned ${r.status}`,
      err?.details,
      {
        hint: err?.hint,
        retryable: err?.retryable,
        docsUrl: err?.docs_url,
      },
    );
  }

  /**
   * GET /v1/keys — the calling agent's own key info. The relay scopes this to
   * the authenticated agent: it returns one key (the caller's), not a list.
   */
  async listKeys(): Promise<KeyInfo> {
    const r = await this.call("GET", "/v1/keys");
    if (!r.ok) this.fail(r);
    return this.asObject<KeyInfo>(r);
  }

  /**
   * DELETE /v1/keys/:id — revoke an API key. The relay only permits revoking
   * the caller's OWN key (any other id is rejected 403): this is a
   * self-destruct. Returns 204 with no body on success.
   */
  async revokeKey(id: string): Promise<void> {
    const r = await this.call("DELETE", `/v1/keys/${encodeURIComponent(id)}`);
    if (!r.ok) this.fail(r);
  }

  /**
   * POST /v1/keys: mint a NEW sibling API key for the calling agent's OWN
   * identity. The relay derives the identity from the bearer token, so a caller
   * can only ever mint a sibling of itself (never another agent's key). The new
   * key has the same scope/ownership as the caller and shows up in a subsequent
   * `listKeys()` call made WITH the new key.
   *
   * The raw `api_key` is returned exactly ONCE in this response and is never
   * retrievable again (only its hash is stored). Bootstraps a fresh CLI /
   * process credential from an MCP-driven agent that has no key of its own to
   * hand off. The owner can revoke any minted sibling via the normal revoke
   * path.
   */
  async mintKey(): Promise<KeyMintResult> {
    const r = await this.call("POST", "/v1/keys");
    if (!r.ok) this.fail(r);
    return this.asObject<KeyMintResult>(r);
  }

  /**
   * POST /v1/agents/claim — bind this agent to a human via a one-shot
   * claim code the human generated in their settings UI. After a
   * successful claim the agent's existing API key continues to work,
   * but the agent (and its apps/templates) now belong to the
   * claiming human. One-way operation — there is no unclaim in v1.
   */
  async claimAgent(
    code: string,
  ): Promise<{ ok: true; owner_human_id: string; claimed_at: string }> {
    const r = await this.call("POST", "/v1/agents/claim", { code });
    if (!r.ok) this.fail(r);
    return this.asObject<{
      ok: true;
      owner_human_id: string;
      claimed_at: string;
    }>(r);
  }

  /**
   * GET /v1/taste — the calling agent's freeform "taste notes" markdown attachment:
   * presentation preferences the agent has picked up from human feedback over
   * time. Returns `{ taste: null, updated_at: null, bytes: 0 }` when the
   * agent has never written notes. Read this before generating an template so
   * the agent applies prior feedback.
   */
  async getTaste(): Promise<TasteInfo> {
    const r = await this.call("GET", "/v1/taste");
    if (!r.ok) this.fail(r);
    return this.asObject<TasteInfo>(r);
  }

  /**
   * PUT /v1/taste — whole-attachment replace of the calling agent's taste notes.
   * Empty/whitespace-only values are rejected by the relay; callers asking to
   * clear must use {@link clearTaste}. The relay caps the payload at the
   * server's `MAX_TASTE_BYTES` (utf8 bytes).
   */
  async setTaste(taste: string): Promise<TasteInfo> {
    const r = await this.call("PUT", "/v1/taste", { taste });
    if (!r.ok) this.fail(r);
    return this.asObject<TasteInfo>(r);
  }

  /**
   * DELETE /v1/taste — clear the calling agent's taste notes (idempotent on
   * the relay; clearing already-empty notes still succeeds). Returns 204 with
   * no body.
   */
  async clearTaste(): Promise<void> {
    const r = await this.call("DELETE", "/v1/taste");
    if (!r.ok) this.fail(r);
  }

  /**
   * POST /v1/feedback — submit a one-shot bug report, feature request, or
   * note to the relay operator. Returns the new row's id, type, and
   * created_at; the message is not echoed.
   */
  async submitFeedback(req: {
    type: FeedbackType;
    message: string;
    appId?: string;
  }): Promise<FeedbackSubmission> {
    const r = await this.call("POST", "/v1/feedback", {
      type: req.type,
      message: req.message,
      app_id: req.appId,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<FeedbackSubmission>(r);
  }

  /**
   * GET /v1/feedback — the calling agent's own submissions, newest first.
   * `before` is an opaque cursor from a previous page's `next_before`.
   */
  async listFeedback(
    opts: { limit?: number; before?: string } = {},
  ): Promise<FeedbackPage> {
    const q = new URLSearchParams();
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.before != null && opts.before !== "") q.set("before", opts.before);
    const qs = q.toString();
    const r = await this.call("GET", `/v1/feedback${qs ? "?" + qs : ""}`);
    if (!r.ok) this.fail(r);
    return this.asObject<FeedbackPage>(r);
  }

  // ------------------------------------------------------------------------
  // Blobs (v0.1.0). Two-scope binary attachments with multipart upload.
  // See proposal hs#152 for the original design; scopes were cut over to
  // the v2 App domain (agent | app) in the 2c2 rebrand.
  // ------------------------------------------------------------------------

  /**
   * Upload a attachment to the relay. Returns a `AttachmentRef` that can be referenced
   * in event payloads (the relay's `format: homespun-attachment-id` schema vocab
   * validates the id) or in `homespun create --input-data`.
   *
   * Scope defaults to "agent" (reusable). For `scope: "app"` pass `appId`.
   * The calling agent's owning human must own the referenced App;
   * cross-tenant attempts return app_not_found.
   *
   * MIME is inferred from `mime` if supplied; otherwise the relay sniffs
   * leading bytes and may reject with mime_mismatch / mime_disallowed.
   *
   * Backed by the relay's multipart `POST /v1/attachments` (the fallback path).
   * For large uploads (>1 MB on hosted Azure) call `presignBlob()` +
   * `confirmBlob()` instead — those use SAS direct-to-storage and don't
   * stream bytes through the relay.
   */
  async uploadBlob(
    file: Blob | Buffer | Uint8Array,
    opts: UploadBlobOptions = {},
  ): Promise<AttachmentRef> {
    const fd = new FormData();
    let attachment: Blob;
    if (file instanceof Blob) {
      attachment = file;
    } else {
      // Buffer / Uint8Array path — wrap in a Blob with the declared MIME.
      // Copy into a freshly allocated Uint8Array so the buffer type
      // narrows from `ArrayBufferLike` (which includes SharedArrayBuffer)
      // to `ArrayBuffer` specifically — the Blob constructor accepts only
      // the latter under @types/node ≥25 + TS ≥5.7's generic narrowing of
      // Uint8Array<TArrayBuffer>. `new Uint8Array(length)` returns
      // `Uint8Array<ArrayBuffer>` by construction, satisfying AttachmentPart
      // without a type cast. The extra copy is one walk over the bytes —
      // negligible vs the network upload that follows.
      const src = file instanceof Uint8Array ? file : new Uint8Array(file);
      const u8 = new Uint8Array(src.byteLength);
      u8.set(src);
      attachment = new Blob([u8], {
        type: opts.mime ?? "application/octet-stream",
      });
    }
    fd.set("file", attachment, opts.filename ?? "attachment");
    if (opts.scope) fd.set("scope", opts.scope);
    if (opts.appId) fd.set("app_id", opts.appId);
    if (opts.filename) fd.set("filename", opts.filename);

    const url = this.base + "/v1/attachments";
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + this.apiKey,
          ...(this.cliVersion
            ? { "x-homespun-cli-version": this.cliVersion }
            : {}),
        },
        body: fd,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HomespunApiError(0, "fetch_error", msg);
    }
    const text = await res.text().catch(() => "");
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new HomespunApiError(
        res.status,
        "non_json_response",
        `relay returned a non-JSON body (status ${res.status})`,
      );
    }
    if (!res.ok) {
      this.fail({ ok: false, status: res.status, data });
    }
    return data as AttachmentRef;
  }

  /**
   * Upload a attachment from INLINE base64 bytes: the no-filesystem sibling of
   * `uploadBlob()`. Use this when the bytes were produced in memory (an image
   * the agent generated, a document it assembled) and there is no local file to
   * stream: an MCP client running inside a Claude session has no filesystem to
   * point `uploadBlob()` at.
   *
   * The bytes are sent as base64 in a JSON body to the relay's
   * `POST /v1/attachments` inline variant ({ content_base64, filename?, mime?,
   * scope?, app_id? }). The relay decodes them behind a pre-decode size guard and runs
   * the IDENTICAL validation pipeline the multipart `uploadBlob()` path runs:
   * magic-byte MIME sniff, BLOB_MIME_ALLOWLIST, per-attachment size cap, and the
   * per-agent / per-app / per-account quota reservation. `mime` is advisory
   * (the relay sniffs the real type regardless), and an oversized or disallowed
   * inline upload returns the same errors the file path would.
   *
   * @param contentBase64 standard base64 (e.g. `Buffer.from(bytes).toString("base64")`).
   */
  async uploadBlobInline(
    contentBase64: string,
    opts: UploadBlobOptions = {},
  ): Promise<AttachmentRef> {
    const body: {
      content_base64: string;
      scope?: "agent" | "app";
      app_id?: string;
      filename?: string;
      mime?: string;
    } = { content_base64: contentBase64 };
    if (opts.scope) body.scope = opts.scope;
    if (opts.appId) body.app_id = opts.appId;
    if (opts.filename) body.filename = opts.filename;
    if (opts.mime) body.mime = opts.mime;

    const r = await this.call("POST", "/v1/attachments", body);
    if (!r.ok) this.fail(r);
    return this.asObject<AttachmentRef>(r);
  }

  /** GET /v1/attachments/:id — download bytes as an ArrayBuffer. */
  async downloadBlob(attachmentId: string): Promise<ArrayBuffer> {
    const url =
      this.base + "/v1/attachments/" + encodeURIComponent(attachmentId);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: "Bearer " + this.apiKey,
        ...(this.cliVersion
          ? { "x-homespun-cli-version": this.cliVersion }
          : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      this.fail({ ok: false, status: res.status, data });
    }
    return res.arrayBuffer();
  }

  /**
   * GET a attachment's metadata only — useful before downloading large attachments, or
   * for `homespun attachment show <id>` which doesn't want the bytes. Returns the full
   * AttachmentRef (the same shape POST /v1/attachments returns): id, scope, mime, size,
   * sha256, filename, width, height, status, scope FKs, timestamps.
   *
   * Backed by GET /v1/attachments/:id/metadata which serves the JSON AttachmentRef
   * without streaming the bytes — cheap on the relay and avoids the
   * encrypt-at-rest decrypt cost when only the metadata is needed.
   */
  async getBlob(attachmentId: string): Promise<AttachmentRef> {
    const r = await this.call(
      "GET",
      "/v1/attachments/" + encodeURIComponent(attachmentId) + "/metadata",
    );
    if (!r.ok) this.fail(r);
    return this.asObject<AttachmentRef>(r);
  }

  /** DELETE /v1/attachments/:id — soft-delete (idempotent). */
  async deleteBlob(attachmentId: string): Promise<{ deleted: true }> {
    const r = await this.call(
      "DELETE",
      "/v1/attachments/" + encodeURIComponent(attachmentId),
    );
    if (!r.ok) this.fail(r);
    return { deleted: true };
  }

  /**
   * Mint a `/b/<token>` capability URL for `attachmentId`. Default TTL is set by
   * the relay (24h agent-scope, 30d app-scope). `once: true`
   * tokens self-delete on first GET.
   */
  async mintBlobToken(
    attachmentId: string,
    opts: { ttlSeconds?: number; once?: boolean } = {},
  ): Promise<AttachmentTokenMintResponse> {
    const r = await this.call(
      "POST",
      "/v1/attachments/" + encodeURIComponent(attachmentId) + "/tokens",
      { ttl_seconds: opts.ttlSeconds, once: opts.once },
    );
    if (!r.ok) this.fail(r);
    return r.data as AttachmentTokenMintResponse;
  }

  /** Revoke a previously-minted token. Idempotent. */
  async revokeBlobToken(
    attachmentId: string,
    tokenId: string,
  ): Promise<{ token_id: string; revoked: true }> {
    const r = await this.call(
      "DELETE",
      "/v1/attachments/" +
        encodeURIComponent(attachmentId) +
        "/tokens/" +
        encodeURIComponent(tokenId),
    );
    if (!r.ok) this.fail(r);
    return r.data as { token_id: string; revoked: true };
  }

  /**
   * GET /v1/attachments — list YOUR agent's non-deleted attachments (newest first).
   * Paginated via opaque cursor: when `next_cursor` is non-null, pass it
   * back as `cursor` on the next call.
   */
  async listBlobs(
    opts: ListBlobsOptions = {},
  ): Promise<{ items: AttachmentRef[]; next_cursor: string | null }> {
    const params = new URLSearchParams();
    if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const r = await this.call("GET", "/v1/attachments" + (qs ? "?" + qs : ""));
    if (!r.ok) this.fail(r);
    return r.data as { items: AttachmentRef[]; next_cursor: string | null };
  }

  /**
   * GET /v1/attachments/:id/tokens — enumerate the capability tokens minted
   * against one attachment, including revoked rows (for audit). The plaintext
   * token is NEVER returned — it isn't stored, only its sha256 is.
   */
  async listBlobTokens(
    attachmentId: string,
  ): Promise<AttachmentTokenListResponse> {
    const r = await this.call(
      "GET",
      "/v1/attachments/" + encodeURIComponent(attachmentId) + "/tokens",
    );
    if (!r.ok) this.fail(r);
    return r.data as AttachmentTokenListResponse;
  }

  /**
   * Issue a presigned PUT URL for direct-to-storage upload. Returns the
   * upload URL + the attachment_id (already reserved in the relay's DB with
   * status=pending) + expiry. After PUTting the bytes to the URL, call
   * `confirmBlob(attachment_id)` to finalise.
   *
   * Filesystem backend returns 501 not_implemented — use uploadBlob()
   * (multipart fallback) instead. Azure backend returns a SAS URL.
   */
  async presignBlob(opts: PresignBlobOptions): Promise<{
    attachment_id: string;
    upload_url: string;
    expires_at: string;
  }> {
    const r = await this.call("POST", "/v1/attachments/presign", {
      mime: opts.mime,
      size: opts.size,
      sha256: opts.sha256,
      scope: opts.scope,
      app_id: opts.appId,
      filename: opts.filename,
    });
    if (!r.ok) this.fail(r);
    return r.data as {
      attachment_id: string;
      upload_url: string;
      expires_at: string;
    };
  }

  /**
   * Finalise a presigned upload. After the client PUTs the bytes to the
   * `upload_url` from `presignBlob()`, the relay re-reads the stored bytes and
   * runs the SAME validation a normal upload runs: it BYTE-SNIFFS the actual
   * content and derives the stored/served mime from that (never the
   * presign-declared mime), re-verifies size + sha256, enforces the allowlist +
   * quota, and runs the scan hook, before flipping the attachment to `ready`.
   * A finalize whose bytes fail any check leaves the attachment unready (it is
   * never served) and returns a clean error. Returns the ready `AttachmentRef`.
   */
  async confirmBlob(attachmentId: string): Promise<AttachmentRef> {
    const r = await this.call(
      "POST",
      "/v1/attachments/" + encodeURIComponent(attachmentId) + "/confirm",
    );
    if (!r.ok) this.fail(r);
    return r.data as AttachmentRef;
  }

  /**
   * Alias for {@link confirmBlob}: the "finalize" half of the presign ->
   * PUT -> finalize flow, named to match the MCP `attachments` action.
   */
  async finalizeBlob(attachmentId: string): Promise<AttachmentRef> {
    return this.confirmBlob(attachmentId);
  }

  // -------------------------------------------------------------------------
  // v2 app lifecycle (spec-cli §2.1). `:id` on every route below is always the
  // App.id (cuid) — a slug is resolved to an id via `listApps({ slug })`
  // first (the CLI's `resolveAppId` helper does this transparently).
  // -------------------------------------------------------------------------

  /** POST /v1/apps — create (deploy) a new App + its first AppVersion. */
  async deployApp(req: DeployAppRequest): Promise<DeployAppResponse> {
    const r = await this.call("POST", "/v1/apps", {
      html: req.html,
      manifest: req.manifest,
      visibility: req.visibility,
      slug: req.slug,
      assets: req.assets,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<DeployAppResponse>(r);
  }

  /** POST /v1/apps/:id/versions — redeploy (compat-gated unless force). */
  async redeployApp(
    appId: string,
    req: RedeployAppRequest,
  ): Promise<RedeployAppResponse> {
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/versions`,
      {
        html: req.html,
        manifest: req.manifest,
        force: req.force,
        assets: req.assets,
      },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<RedeployAppResponse>(r);
  }

  /**
   * Dry-run a deploy: validate the manifest + asset shapes, run the compat gate
   * (for a redeploy) and compute the deploy advisories, WITHOUT creating a
   * version or mutating anything. Posts the deploy body with `dry_run: true` to
   * the same route the real deploy uses (`POST /v1/apps` for a create check,
   * `POST /v1/apps/:id/versions` for a redeploy check), so the relay returns the
   * SAME validation error a real deploy would for an invalid manifest, and the
   * SAME warnings/compat result for a valid one. Nothing is persisted.
   */
  async checkDeploy(req: DeployCheckRequest): Promise<DeployCheckResult> {
    const path =
      req.app_id !== undefined
        ? `/v1/apps/${encodeURIComponent(req.app_id)}/versions`
        : "/v1/apps";
    const body: Record<string, unknown> = {
      html: req.html,
      manifest: req.manifest,
      dry_run: true,
    };
    if (req.app_id !== undefined && req.force !== undefined)
      body["force"] = req.force;
    if (req.assets !== undefined) body["assets"] = req.assets;
    const r = await this.call("POST", path, body);
    if (!r.ok) this.fail(r);
    return this.asObject<DeployCheckResult>(r);
  }

  /**
   * GET /v1/apps — list apps scoped to the calling agent's owning human.
   * `slug` is an exact-match filter — the one case a caller resolves a
   * human-given slug to an id (see the class-level note above).
   */
  async listApps(
    opts: {
      status?: "active" | "dormant" | "archived" | "all";
      limit?: number;
      cursor?: string;
      slug?: string;
    } = {},
  ): Promise<AppsPage> {
    const q = new URLSearchParams();
    if (opts.status !== undefined) q.set("status", opts.status);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.cursor !== undefined && opts.cursor !== "")
      q.set("cursor", opts.cursor);
    if (opts.slug !== undefined && opts.slug !== "") q.set("slug", opts.slug);
    const qs = q.toString();
    const r = await this.call("GET", `/v1/apps${qs ? "?" + qs : ""}`);
    if (!r.ok) this.fail(r);
    return this.asObject<AppsPage>(r);
  }

  /** GET /v1/apps/:id — full app detail (manifest, current_version, quota). */
  async getApp(appId: string): Promise<AppDetail> {
    const r = await this.call("GET", `/v1/apps/${encodeURIComponent(appId)}`);
    if (!r.ok) this.fail(r);
    return this.asObject<AppDetail>(r);
  }

  /**
   * PATCH /v1/apps/:id updates the app's mutable settings. Both fields are
   * optional but at least one must be given: `visibility` (private|link|public)
   * and/or `timezone` (an IANA zone name like "Europe/Berlin", used for
   * `schedules` reminders). Returns the updated `{ id, visibility, timezone }`.
   * A transition INTO `link` visibility also returns a `share_url` carrying the
   * app's freshly minted share token in its `#k=` fragment, shown ONCE (the
   * token is hashed at rest and never recoverable). A transition AWAY from
   * `link` clears the token (every prior share URL stops working).
   */
  async updateApp(
    appId: string,
    update: {
      visibility?: "private" | "link" | "public";
      timezone?: string;
    },
  ): Promise<{
    id: string;
    visibility: string;
    timezone: string | null;
    share_url?: string;
  }> {
    const body: Record<string, unknown> = {};
    if (update.visibility !== undefined) body["visibility"] = update.visibility;
    if (update.timezone !== undefined) body["timezone"] = update.timezone;
    const r = await this.call(
      "PATCH",
      `/v1/apps/${encodeURIComponent(appId)}`,
      body,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{
      id: string;
      visibility: string;
      timezone: string | null;
      share_url?: string;
    }>(r);
  }

  /**
   * POST /v1/apps/:id/share-link/rotate rotates a `link` app's share token.
   * Mints a fresh token and returns the new `share_url` (its `#k=` fragment
   * carries the raw token, shown ONCE). Rotating instantly revokes the previous
   * share URL and every pass derived from it. Also serves as "generate" for a
   * `link` app that has no share token yet. Only valid for a `link` app; a
   * public/private app returns a conflict.
   */
  async rotateShareLink(appId: string): Promise<{ share_url: string }> {
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/share-link/rotate`,
      {},
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ share_url: string }>(r);
  }

  /** DELETE /v1/apps/:id — soft-delete (idempotent). */
  async deleteApp(appId: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appId)}`,
    );
    if (!r.ok) this.fail(r);
  }

  /** POST /v1/apps/:id/wake — wake a dormant app; a no-op on a non-dormant one. */
  async wakeApp(appId: string): Promise<{ id: string; status: string }> {
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/wake`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ id: string; status: string }>(r);
  }

  // -------------------------------------------------------------------------
  // Custom domains (Cloudflare for SaaS). One primary domain per app. The
  // relay rejects setAppDomain with `custom_domains_not_enabled` (501) when
  // the deployment has no Cloudflare configuration.
  // -------------------------------------------------------------------------

  /**
   * POST /v1/apps/:id/domain - bind a custom domain to the app. Returns the
   * record including `dns_records`: the DNS entries the domain owner must
   * publish (the routing CNAME plus any Cloudflare validation records).
   */
  async setAppDomain(appId: string, domain: string): Promise<AppDomain> {
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/domain`,
      { domain },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<AppDomain>(r);
  }

  /**
   * GET /v1/apps/:id/domain - the app's domain record, live-refreshed against
   * Cloudflare when the feature is enabled (status/last_error/last_checked_at
   * update as a side effect).
   */
  async getAppDomain(appId: string): Promise<AppDomain> {
    const r = await this.call(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/domain`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<AppDomain>(r);
  }

  /**
   * DELETE /v1/apps/:id/domain - remove the domain binding (Cloudflare
   * hostname best-effort + record + quota release). Idempotent.
   */
  async deleteAppDomain(appId: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appId)}/domain`,
    );
    if (!r.ok) this.fail(r);
  }

  // -------------------------------------------------------------------------
  // v2 app membership (auth spec §6, spec-cli §2.5). Auth is owner-or-agent;
  // this client always authenticates as the owning agent. Note: unlike most
  // v1/v2 wire shapes, the member fields below are camelCase on the wire
  // (humanId/createdAt), matching packages/relay/src/http/routes/app-members.ts
  // exactly rather than the usual snake_case convention.
  //
  // Template `install`/`uninstall` is intentionally NOT wrapped here — that
  // route is `requireHuman` (human login cookie only), not agent-key
  // authorizable, so it has no place on this agent-facing client.
  // -------------------------------------------------------------------------

  /**
   * POST /v1/apps/:id/members — add or invite a member by email. If a Human
   * already exists for the email, the member row is created immediately
   * (`{ member }`); otherwise the relay mints a signed invite and emails a
   * magic link (`{ ok: true, invited, expires_at }`). 503s if the relay has
   * EMAIL_PROVIDER=none (no invite-email path available).
   */
  async addAppMember(
    appId: string,
    opts: { email: string; role?: "member"; customRole?: string },
  ): Promise<AddAppMemberResult> {
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/members`,
      { email: opts.email, role: opts.role, custom_role: opts.customRole },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<AddAppMemberResult>(r);
  }

  /** GET /v1/apps/:id/members — list the app's owner + member rows. */
  async listAppMembers(appId: string): Promise<{ members: AppMember[] }> {
    const r = await this.call(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/members`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ members: AppMember[] }>(r);
  }

  /**
   * PATCH /v1/apps/:id/members/:humanId — change an existing member's custom
   * role in place. `customRole: null` clears it back to a plain member. The
   * role must be one the app's manifest declares (a reserved base role or an
   * undeclared name is a 400), and the app owner's own membership cannot be
   * re-roled.
   *
   * Unlike remove-then-re-add, this does NOT revoke the member's live app
   * sessions: they stay signed in and pick up the new role on their next
   * request. Roles are not cached: they are re-derived from the Member row on
   * every request, so a downgrade takes effect immediately and a live session
   * can never escalate.
   */
  async setAppMemberRole(
    appId: string,
    humanId: string,
    opts: { customRole: string | null },
  ): Promise<{ member: AppMember }> {
    const r = await this.call(
      "PATCH",
      `/v1/apps/${encodeURIComponent(appId)}/members/${encodeURIComponent(humanId)}`,
      { custom_role: opts.customRole },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ member: AppMember }>(r);
  }

  /**
   * GET /v1/apps/:id/roles — the derived roles summary: every custom role the
   * app's manifest declares, what holding it actually allows per collection
   * (reported separately for members and for grant-link holders, whose role
   * floors differ), and how many members and live grant links hold it.
   * Read-only and computed on the fly; permissions themselves stay
   * manifest-declared. An app that declares no roles returns an empty list.
   */
  async listAppRoles(appId: string): Promise<{ roles: AppRoleSummary[] }> {
    const r = await this.call(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/roles`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ roles: AppRoleSummary[] }>(r);
  }

  /**
   * DELETE /v1/apps/:id/members/:humanId — remove a member (idempotent);
   * cascades to revoke that human's live app sessions. The app owner cannot
   * be removed — the relay refuses with a 409 conflict.
   */
  async removeAppMember(appId: string, humanId: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appId)}/members/${encodeURIComponent(humanId)}`,
    );
    if (!r.ok) this.fail(r);
  }

  // -------------------------------------------------------------------------
  // Inbound catch-hooks (inbound-webhooks PR 3). Read + rotate the smallest
  // surface an agent needs: list an app's declared hooks with their full secret
  // URL (so the agent can tell its owner the exact URL to paste into an external
  // system during app setup), and rotate a leaked secret. Hooks themselves are
  // manifest-declared, so there is no create/delete here.
  // -------------------------------------------------------------------------

  /**
   * GET /v1/apps/:id/ingest-hooks lists the app's inbound catch-hooks with the
   * full secret URL (decrypted server-side), the current rule metadata
   * (collection/mode/wake/handshake), and per-hook delivery counts by status.
   * The URL is the app owner's to share with a sender; it is never exposed on a
   * public path, only here to the app's own owner/agent.
   */
  async listIngestHooks(appId: string): Promise<{ hooks: IngestHookInfo[] }> {
    const r = await this.call(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/ingest-hooks`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ hooks: IngestHookInfo[] }>(r);
  }

  /**
   * POST /v1/apps/:id/ingest-hooks/:name/rotate mints a fresh secret for one
   * hook and return its new full URL once. No redeploy needed; the old URL stops
   * working immediately.
   */
  async rotateIngestHook(
    appId: string,
    name: string,
  ): Promise<{ hook: { name: string; url: string } }> {
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/ingest-hooks/${encodeURIComponent(name)}/rotate`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ hook: { name: string; url: string } }>(r);
  }

  // -------------------------------------------------------------------------
  // v2 grant links (M5). An owner/agent mints a capability URL carrying a
  // DECLARED custom role (x-homespun-manifest.roles) plus an optional row/filter
  // pin. The raw link token rides the returned grant_url's FRAGMENT (#g=), never
  // a query param, so it is never logged; the page SDK exchanges it once for a
  // per-holder credential. A grant can NEVER carry a built-in role and never
  // escalates past its custom role on a stable per-holder identity.
  // -------------------------------------------------------------------------

  /**
   * POST /v1/apps/:id/grants: mint a grant link. `role` must be a declared
   * custom role for the app. `mode` is "once" (one-time, first-browser-claims)
   * or "multi" (shared, capped by `maxUses` within expiry); defaults to "multi".
   * An optional `pin` NARROWS the holder to a single `rowKey` OR a `where`
   * filter (never widens). Returns the once-only `grant_url` carrying the token.
   */
  async mintAppGrant(
    appId: string,
    opts: {
      role: string;
      mode?: "once" | "multi";
      maxUses?: number;
      label?: string;
      ttlSeconds?: number;
      pin?: { rowKey?: string; where?: ListWhereCondition[] };
    },
  ): Promise<MintAppGrantResult> {
    const pin = opts.pin
      ? opts.pin.rowKey !== undefined
        ? { row_key: opts.pin.rowKey }
        : { where: opts.pin.where }
      : undefined;
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/grants`,
      {
        role: opts.role,
        mode: opts.mode,
        max_uses: opts.maxUses,
        label: opts.label,
        ttl_seconds: opts.ttlSeconds,
        pin,
      },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<MintAppGrantResult>(r);
  }

  /** GET /v1/apps/:id/grants: list the app's grant links (never any token). */
  async listAppGrants(appId: string): Promise<{ grants: AppGrantSummary[] }> {
    const r = await this.call(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/grants`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ grants: AppGrantSummary[] }>(r);
  }

  /** DELETE /v1/apps/:id/grants/:grantId: revoke one grant link (idempotent). */
  async revokeAppGrant(appId: string, grantId: string): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appId)}/grants/${encodeURIComponent(grantId)}`,
    );
    if (!r.ok) this.fail(r);
  }

  // -------------------------------------------------------------------------
  // v2 collection row CRUD + feed catch-up (spec-cli §2.2/§2.3). Same wire
  // shapes as the v1 homespun-records methods above, mounted under
  // /v1/apps/:id/collections/:name instead of /v1/apps/:id/records/:name.
  // -------------------------------------------------------------------------

  /**
   * GET /v1/apps/:id/collections/:name — list rows (current-state page).
   *
   * Wave C2 structured read query: pass `where` (an AND of `{field, op, value}`
   * conditions) and/or `sort` (`{field, dir}` list) to filter/order DB-side. The
   * relay applies read permission + author scoping FIRST, then the filter, so a
   * filtered read is always a subset of what the caller could already read. The
   * query is serialized into the `q` param as URL-encoded JSON. Note: a custom
   * `sort` cannot be combined with cursor pagination (`since`) in this version.
   */
  async listAppRows(
    appId: string,
    collection: string,
    opts: {
      since?: string;
      limit?: number;
      where?: ListWhereCondition[];
      sort?: ListSortSpec[];
    } = {},
  ): Promise<AppRowsPage> {
    const q = new URLSearchParams();
    if (opts.since !== undefined) q.set("since", opts.since);
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const query = buildListQueryParam(opts.where, opts.sort);
    if (query !== undefined) q.set("q", query);
    const qs = q.toString();
    const r = await this.call(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/collections/${encodeURIComponent(collection)}${qs ? "?" + qs : ""}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<AppRowsPage>(r);
  }

  /**
   * GET /v1/apps/:id/collections/:name/:key — read one row. A dedicated
   * route (not a client-side scan like v1's `getRecord`) — spec-cli §8
   * ruling 3 confirms it as a first-class relay route.
   */
  async getAppRow(
    appId: string,
    collection: string,
    key: string,
  ): Promise<{ row: AppRow }> {
    const r = await this.call(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/collections/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ row: AppRow }>(r);
  }

  /**
   * POST /v1/apps/:id/collections/:name — upsert (create, or return the
   * existing row when `key` collides — `deduped: true`). §8 ruling 4: this is
   * the ONLY create-shaped verb — there is no strict create that errors on
   * an existing key.
   */
  async upsertAppRow(
    appId: string,
    collection: string,
    body: { key?: string; data: unknown; on?: string },
  ): Promise<{ row: AppRow; deduped?: true }> {
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/collections/${encodeURIComponent(collection)}`,
      body,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ row: AppRow; deduped?: true }>(r);
  }

  /**
   * POST /v1/apps/:id/collections/:name with `{ on, data }`, natural-key upsert
   * (Wave C1). Matches the existing row whose `<field>` value equals data[field]
   * and updates it in place (idempotent re-import), else creates a fresh row.
   * `field` must be declared in the collection's manifest `unique` list.
   */
  async upsertAppRowOn(
    appId: string,
    collection: string,
    field: string,
    data: unknown,
  ): Promise<{ row: AppRow; deduped?: true }> {
    return this.upsertAppRow(appId, collection, { on: field, data });
  }

  /**
   * DELETE /v1/apps/:id/collections/:name/:key/purge, owner/agent-only removal
   * that bypasses an append-only collection (Wave C1). Frees the row's unique
   * values and writes an audited delete feed entry. A missing/already-deleted key
   * is a 404 (HomespunApiError `row_not_found`), matching a normal delete.
   */
  async purgeAppRow(
    appId: string,
    collection: string,
    key: string,
  ): Promise<void> {
    const r = await this.call(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appId)}/collections/${encodeURIComponent(collection)}/${encodeURIComponent(key)}/purge`,
    );
    if (!r.ok) this.fail(r);
  }

  /** PATCH /v1/apps/:id/collections/:name/:key — optimistic-locked update. */
  async updateAppRow(
    appId: string,
    collection: string,
    key: string,
    body: { data: unknown; if_match?: number },
  ): Promise<{ row: AppRow }> {
    const r = await this.call(
      "PATCH",
      `/v1/apps/${encodeURIComponent(appId)}/collections/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`,
      body,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<{ row: AppRow }>(r);
  }

  /** DELETE /v1/apps/:id/collections/:name/:key — soft-delete. */
  async deleteAppRow(
    appId: string,
    collection: string,
    key: string,
    opts: { ifMatch?: number } = {},
  ): Promise<void> {
    const body = opts.ifMatch != null ? { if_match: opts.ifMatch } : undefined;
    const r = await this.call(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appId)}/collections/${encodeURIComponent(collection)}/${encodeURIComponent(key)}`,
      body,
    );
    if (!r.ok) this.fail(r);
  }

  /**
   * POST /v1/apps/:id/collections/:name/batch: bulk create/upsert (Wave B).
   * Returns a per-row result array: a single invalid row is reported by index
   * without aborting the good rows. A batch over the server's BATCH_MAX_ROWS cap
   * is a clean 400 (throws HomespunApiError `invalid_request`). DEFAULTS TO
   * SILENT (suppresses notify + webhooks): pass `{emitEffects:true}` or
   * `{suppress:[]}` to fire effects. Owner/agent key only for suppression control.
   */
  async batchRows(
    appId: string,
    collection: string,
    rows: BatchRowInput[],
    opts: BatchWriteOptions = {},
  ): Promise<BatchResult> {
    const body: {
      rows: BatchRowInput[];
      suppress?: ("notify" | "webhooks")[];
      emitEffects?: boolean;
      on?: string;
    } = { rows };
    if (opts.suppress !== undefined) body.suppress = opts.suppress;
    if (opts.emitEffects !== undefined) body.emitEffects = opts.emitEffects;
    if (opts.on !== undefined) body.on = opts.on;
    const r = await this.call(
      "POST",
      `/v1/apps/${encodeURIComponent(appId)}/collections/${encodeURIComponent(collection)}/batch`,
      body,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<BatchResult>(r);
  }

  /**
   * DELETE /v1/apps/:id/collections/:name/batch: bulk soft-delete (Wave B).
   * Same per-row result shape + cap as `batchRows`.
   */
  async deleteRows(
    appId: string,
    collection: string,
    keys: string[],
  ): Promise<BatchResult> {
    const r = await this.call(
      "DELETE",
      `/v1/apps/${encodeURIComponent(appId)}/collections/${encodeURIComponent(collection)}/batch`,
      { keys },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<BatchResult>(r);
  }

  /**
   * GET /v1/apps/:id/feed — change-feed catch-up; the long-poll fallback
   * transport for `watch` (spec-cli §2.3/§5). `wait` (0-30s) long-polls when
   * the caller is already caught up.
   */
  async getAppFeed(
    appId: string,
    opts: { since: number; limit?: number; wait?: number },
  ): Promise<AppFeedPage> {
    const q = new URLSearchParams();
    q.set("since", String(opts.since));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.wait !== undefined) q.set("wait", String(opts.wait));
    const r = await this.call(
      "GET",
      `/v1/apps/${encodeURIComponent(appId)}/feed?${q.toString()}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<AppFeedPage>(r);
  }

  // -------------------------------------------------------------------------
  // Community publish + review (M4b). publishCommunityTemplate is an OWNER
  // action (the calling agent's owning human); the review methods are
  // operator-gated server-side.
  // -------------------------------------------------------------------------

  /** POST /v1/community/publish: publish an owned app as a pending template. */
  async publishCommunityTemplate(
    req: PublishCommunityTemplateRequest,
  ): Promise<PublishCommunityTemplateResponse> {
    const r = await this.call("POST", "/v1/community/publish", {
      app_id: req.appId,
      title: req.title,
      description: req.description,
      long_description: req.longDescription,
      category: req.category,
      tags: req.tags,
      slug: req.slug,
      version: req.version,
      changelog_note: req.changelogNote,
      setup_steps: req.setupSteps,
      derived_from_snapshot_id: req.derivedFromSnapshotId,
      attest_example_only: req.attestExampleOnly,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<PublishCommunityTemplateResponse>(r);
  }

  /** GET /v1/community/pending (operator): list pending submissions. */
  async listCommunitySubmissions(
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<CommunitySubmissionsPage> {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.cursor !== undefined && opts.cursor !== "")
      q.set("cursor", opts.cursor);
    const qs = q.toString();
    const r = await this.call(
      "GET",
      `/v1/community/pending${qs ? "?" + qs : ""}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<CommunitySubmissionsPage>(r);
  }

  /** GET /v1/community/submissions/:id (operator): a submission's full content. */
  async getCommunitySubmission(
    snapshotId: string,
  ): Promise<CommunitySubmissionDetail> {
    const r = await this.call(
      "GET",
      `/v1/community/submissions/${encodeURIComponent(snapshotId)}`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<CommunitySubmissionDetail>(r);
  }

  /**
   * POST /v1/community/submissions/:id/{approve,reject} (operator): review a
   * submission. `decision` "reject" requires a `note` (delivered to the
   * publisher's app feed).
   */
  async reviewCommunitySubmission(
    snapshotId: string,
    review: { decision: "approve" | "reject"; note?: string },
  ): Promise<CommunitySubmissionDetail> {
    const path = `/v1/community/submissions/${encodeURIComponent(snapshotId)}/${review.decision}`;
    const r = await this.call(
      "POST",
      path,
      review.decision === "reject" ? { note: review.note } : undefined,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<CommunitySubmissionDetail>(r);
  }

  // -------------------------------------------------------------------------
  // Community publisher identity (marketplace PR 1). All three act AS the
  // calling agent's owning human. claim/update additionally need a verified
  // email server-side.
  // -------------------------------------------------------------------------

  /** GET /v1/publisher: the caller's own publisher profile. */
  async getPublisher(): Promise<PublisherProfile> {
    const r = await this.call("GET", "/v1/publisher");
    if (!r.ok) this.fail(r);
    return this.asObject<PublisherProfile>(r);
  }

  /** POST /v1/publisher/claim: set the handle once (permanent after claiming). */
  async claimPublisherHandle(handle: string): Promise<PublisherProfile> {
    const r = await this.call("POST", "/v1/publisher/claim", { handle });
    if (!r.ok) this.fail(r);
    return this.asObject<PublisherProfile>(r);
  }

  /** POST /v1/publisher/update: update displayName/bio/url. */
  async updatePublisher(
    update: PublisherProfileUpdate,
  ): Promise<PublisherProfile> {
    const r = await this.call("POST", "/v1/publisher/update", {
      display_name: update.displayName,
      bio: update.bio,
      url: update.url,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<PublisherProfile>(r);
  }

  /**
   * POST /v1/community/publishers/:handle/trust (operator, marketplace PR 11):
   * set a publisher's trust level ("new" | "established"), the MVP promotion
   * path for the review fast-track. Operator-gated server-side; returns the
   * updated publisher profile.
   */
  async setPublisherTrustLevel(
    handle: string,
    trustLevel: "new" | "established",
  ): Promise<PublisherProfile> {
    const r = await this.call(
      "POST",
      `/v1/community/publishers/${encodeURIComponent(handle)}/trust`,
      { trust_level: trustLevel },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<PublisherProfile>(r);
  }

  // -------------------------------------------------------------------------
  // Community reviews (marketplace PR 7). createReview / respondToReview /
  // reportReview act AS the calling agent's owning human; the moderation
  // methods (removeReview / unholdReview) are operator-gated server-side.
  // -------------------------------------------------------------------------

  /**
   * POST /v1/reviews: review a template the caller installed. Identify the
   * template by its namespaced `<handle>/<slug>` OR by explicit handle + slug.
   */
  async createReview(
    req: CreateCommunityReviewRequest,
  ): Promise<CommunityReview> {
    const r = await this.call("POST", "/v1/reviews", {
      template: req.template,
      handle: req.handle,
      slug: req.slug,
      stars: req.stars,
      body: req.body,
    });
    if (!r.ok) this.fail(r);
    return this.asObject<CommunityReview>(r);
  }

  /** POST /v1/reviews/:id/respond: respond to a review as the publisher. */
  async respondToReview(
    reviewId: string,
    response: string | null,
  ): Promise<CommunityReview> {
    const r = await this.call(
      "POST",
      `/v1/reviews/${encodeURIComponent(reviewId)}/respond`,
      { response },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<CommunityReview>(r);
  }

  /** POST /v1/reviews/:id/report: flag a review for operator attention. */
  async reportReview(
    reviewId: string,
    reason: string,
  ): Promise<CommunityReviewReportResult> {
    const r = await this.call(
      "POST",
      `/v1/reviews/${encodeURIComponent(reviewId)}/report`,
      { reason },
    );
    if (!r.ok) this.fail(r);
    return this.asObject<CommunityReviewReportResult>(r);
  }

  /** POST /v1/reviews/:id/remove (operator): take a review down. */
  async removeReview(reviewId: string): Promise<CommunityReview> {
    const r = await this.call(
      "POST",
      `/v1/reviews/${encodeURIComponent(reviewId)}/remove`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<CommunityReview>(r);
  }

  /** POST /v1/reviews/:id/unhold (operator): publish a held review. */
  async unholdReview(reviewId: string): Promise<CommunityReview> {
    const r = await this.call(
      "POST",
      `/v1/reviews/${encodeURIComponent(reviewId)}/unhold`,
    );
    if (!r.ok) this.fail(r);
    return this.asObject<CommunityReview>(r);
  }
}

// ---------------------------------------------------------------------------
// v2 app lifecycle + data (spec-cli §2.1-§2.3): deploy/redeploy/list/show/
// update/delete/wake, collection row CRUD, and feed catch-up. Mirrors the
// v1 template/records shapes above but against `/v1/apps` — a DEPLOYED App is
// the v2 primary entity (spec-schema D3), not a named template + app.
// ---------------------------------------------------------------------------

/**
 * One multi-file-deploy asset: bytes the deployed page references by a stable,
 * app-relative, same-origin path (e.g. `frames/000.jpg`). `content_base64` is the
 * standard base64 of the raw bytes; `mime` is advisory (the relay sniffs the
 * real type from the leading bytes).
 */
export interface AppAsset {
  path: string;
  content_base64: string;
  mime?: string;
}

/** Request body for `POST /v1/apps` — create (deploy) a new App. */
export interface DeployAppRequest {
  html: string;
  manifest: unknown;
  /** Defaults to "private" server-side when omitted. */
  visibility?: "private" | "link" | "public";
  /** Accepted for visibility public|private (including the omitted default); rejected for link. */
  slug?: string;
  /**
   * Optional asset bundle shipped alongside the HTML in ONE deploy. Each asset
   * is validated + stored app-scoped exactly like an attachment and served at
   * its `path` on the app's own origin, so `<img src="frames/000.jpg">` just
   * works. Rejected atomically if any asset fails validation.
   */
  assets?: AppAsset[];
}

export interface DeployAppResponse {
  app_id: string;
  slug: string;
  visibility: string;
  url: string;
  version: number;
  created: true;
  /**
   * The tokenized share URL, present ONLY when the app was created as `link`. Its
   * `#k=` fragment carries the raw share token and is shown exactly ONCE (the
   * token is hashed at rest and never recoverable). Anyone with this exact URL
   * can open the app until it is rotated (`rotateShareLink`).
   */
  share_url?: string;
  /**
   * Non-fatal deploy advisories, present only when there is at least one. Today
   * the schedules-without-timezone case: an app that declares `schedules` but has
   * no timezone set will fire reminders at 08:00 UTC until one is set. Relay these
   * to the human.
   */
  warnings?: string[];
}

/** Request body for `POST /v1/apps/:id/versions` — redeploy (compat-gated). */
export interface RedeployAppRequest {
  html: string;
  manifest: unknown;
  /** Bypass the compat gate; a narrowing collection is detached, not deleted. */
  force?: boolean;
  /**
   * Optional asset bundle for this version. Replaces the previous version's asset
   * set atomically (the new version carries its own map; old assets are detached).
   */
  assets?: AppAsset[];
}

export interface RedeployAppResponse {
  app_id: string;
  version: number;
  compat: "clean" | "forced";
  breaks?: Array<{ path: string; message: string }>;
  /**
   * Non-fatal deploy advisories, present only when there is at least one; see
   * DeployAppResponse.warnings. On redeploy the schedules-without-timezone
   * warning fires only when the app STILL has no timezone set.
   */
  warnings?: string[];
}

/**
 * Result of a DRY-RUN deploy (`checkDeploy`): the deploy validation + compat
 * gate run WITHOUT creating a version or mutating anything. Mirrors what a real
 * deploy would report: the manifest is validated (a structurally invalid
 * manifest throws the SAME error a real deploy would), asset shapes are checked,
 * the schedule-timezone / migration-mode advisories are computed, and (for a
 * redeploy) the compat gate runs against the current version.
 *
 *   - `ok` is true when a REAL deploy with the same inputs would succeed: a
 *     clean deploy, or a narrowing redeploy with `force: true`. It is false
 *     when a real un-forced redeploy would be REJECTED for narrowing the
 *     manifest (see `compat: "incompatible"` + `breaks`).
 *   - `compat` is present only for a redeploy check: "clean" (no narrowing),
 *     "forced" (narrows, but force was set so the real deploy would detach and
 *     proceed), or "incompatible" (narrows and force was NOT set, so the real
 *     deploy would return manifest_incompatible_redeploy).
 *   - `breaks` lists the narrowings, present only when there is at least one.
 */
export interface DeployCheckResult {
  ok: boolean;
  warnings: string[];
  compat?: "clean" | "forced" | "incompatible";
  breaks?: Array<{ path: string; message: string }>;
}

/**
 * Request for a dry-run deploy check. Omit `app_id` to check a CREATE; pass it
 * to check a REDEPLOY of an existing app (the compat gate then runs against its
 * current version, and `force` decides whether a narrowing would be accepted).
 */
export interface DeployCheckRequest {
  app_id?: string;
  html: string;
  manifest: unknown;
  force?: boolean;
  assets?: AppAsset[];
}

/**
 * Result of minting a sibling API key for the calling agent's own identity
 * (`mintKey`). The raw `api_key` is returned exactly ONCE here and is never
 * retrievable again (only its hash is stored). The new key has the same
 * scope/ownership as the caller and can be revoked by the owner via the normal
 * revoke path.
 */
export interface KeyMintResult {
  agent_id: string;
  /** The raw sibling key, shown ONCE, never returned again. */
  api_key: string;
  key_prefix: string;
  name: string | null;
  created_at: string;
}

/** Lean per-app summary — the shape `listApps` returns. */
export interface AppSummary {
  id: string;
  slug: string;
  visibility: string;
  status: string;
  url: string;
  /**
   * Whether the app currently has an active share token (a `link` app with a
   * live, revocable share link). NEVER the token itself: the raw token is
   * returned only at create/rotate. False for public/private apps.
   */
  has_share_token: boolean;
  created_at: string;
  last_activity_at: string;
}

/** Full app detail — the shape `getApp` returns. */
export interface AppDetail extends AppSummary {
  manifest: unknown;
  current_version: number | null;
  owner_human_id: string;
  row_count: number;
  storage_bytes: string;
  /**
   * The app's IANA timezone for `schedules` reminders, or null when unset. Set
   * it with `updateApp(id, { timezone })`; an app that declares schedules with no
   * timezone fires reminders at 08:00 UTC.
   */
  timezone: string | null;
}

export interface AppsPage {
  items: AppSummary[];
  next_cursor: string | null;
}

/** One DNS record the domain owner must publish (custom domains). */
export interface AppDomainDnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: "routing" | "ownership" | "certificate_validation";
}

/** The app's custom-domain record - the shape the /domain routes return. */
export interface AppDomain {
  domain: string;
  status: "pending" | "active" | "error" | "removed";
  dns_records: AppDomainDnsRecord[];
  cf_hostname_id: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One member row — the shape `listAppMembers` returns and the `member` half
 * of `addAppMember`'s union returns. Fields are camelCase on the wire (see
 * the app-membership section above for why).
 */
export interface AppMember {
  humanId: string;
  email: string;
  role: string;
  /** M5: an optional DECLARED custom role attached alongside base member powers. */
  customRole?: string | null;
  createdAt: string;
}

/**
 * One inbound catch-hook row from `listIngestHooks`. `url` is the full secret
 * ingest URL to hand a sender. Rule-derived fields (collection/mode/wake/
 * handshake) are null when the hook's rule has left the manifest (disabledAt
 * set). `deliveries` are per-status counts of the hook's inbound journal.
 */
export interface IngestHookInfo {
  name: string;
  url: string;
  collection: string | null;
  mode: string | null;
  wake: boolean | null;
  handshake: string | null;
  disabledAt: string | null;
  createdAt: string;
  deliveries: {
    accepted: number;
    failed: number;
    dropped_duplicate: number;
  };
}

/**
 * Effective per-verb access from `listAppRoles`: "all" = every row, "own" =
 * only rows the holder authored (the `:own` / author narrowing), "none" =
 * nothing. `create` is never "own" (no pre-existing row to be the author of).
 * The relay computes these by probing its real enforcement functions, so they
 * report what a holder can ACTUALLY do, including floors like `anyone`.
 */
export interface AppRoleVerbAccess {
  read: "all" | "own" | "none";
  create: "all" | "none";
  update: "all" | "own" | "none";
  delete: "all" | "own" | "none";
}

/**
 * One collection's access from `listAppRoles`, reported PER POPULATION:
 * `member_access` is what a signed-in member holding the role can do (their
 * principal also carries the member floor), `grant_access` what a grant-link
 * holder of the same role can do (no member floor, so the two can differ).
 * `append_only` is context: such a collection refuses update/delete for every
 * role while still allowing create, and the access tables reflect that.
 */
export interface AppRoleCollectionAccess {
  name: string;
  member_access: AppRoleVerbAccess;
  grant_access: AppRoleVerbAccess;
  append_only: boolean;
}

/**
 * One declared custom role from `listAppRoles`. `member_count` and
 * `active_grant_count` are separate numbers, never summed: members are
 * signed-in Humans, grant-link holders are anonymous per-holder identities.
 */
export interface AppRoleSummary {
  name: string;
  label: string;
  description: string | null;
  collections: AppRoleCollectionAccess[];
  member_count: number;
  active_grant_count: number;
}

/**
 * `POST /v1/apps/:id/members` response — either the member was attached
 * immediately (existing Human) or an invite email was sent (no Human yet).
 */
export type AddAppMemberResult =
  | { member: AppMember }
  | { ok: true; invited: string; expires_at: string };

/** `POST /v1/apps/:id/grants` response. `grant_url` carries the raw link token
 * in its #g= fragment and is shown ONCE (it is never recoverable afterward). */
export interface MintAppGrantResult {
  id: string;
  grant_url: string;
  role: string;
  mode: string;
  max_uses: number | null;
  expires_at: string;
}

/** One grant-link row from `listAppGrants` (never carries any token material). */
export interface AppGrantSummary {
  id: string;
  role: string;
  mode: string;
  max_uses: number | null;
  use_count: number;
  claim_count: number;
  pin_row_key: string | null;
  pin_where: unknown;
  label: string | null;
  active: boolean;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

/** One row in an app collection — the shape every row CRUD op returns. */
export interface AppRow {
  key: string;
  data: unknown;
  version: number;
  author: { kind: string; id: string };
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AppRowsPage {
  rows: AppRow[];
  next_cursor: string | null;
  has_more: boolean;
}

/** A scalar operand for a structured read-query condition (Wave C2). */
export type ListScalar = string | number | boolean;

/**
 * One structured read-query condition (Wave C2). `op` is one of eq / neq / in /
 * notIn / gt / lt / gte / lte, with the SAME type semantics as a notify `when`:
 * comparisons are same-type only (a number never matches a string operand), and
 * dates are compared as ISO-8601 strings. `value` is a single scalar for the
 * scalar ops and a non-empty scalar array for `in`/`notIn`.
 */
export interface ListWhereCondition {
  field: string;
  op: "eq" | "neq" | "in" | "notIn" | "gt" | "lt" | "gte" | "lte";
  value: ListScalar | ListScalar[];
}

/** One structured read-query sort key (Wave C2). `dir` defaults to "asc". */
export interface ListSortSpec {
  field: string;
  dir?: "asc" | "desc";
}

// Serialize `where`/`sort` into the `q` query param (URL-encoded JSON), or
// undefined when neither is given. URLSearchParams handles the percent-encoding.
function buildListQueryParam(
  where?: ListWhereCondition[],
  sort?: ListSortSpec[],
): string | undefined {
  const q: { where?: ListWhereCondition[]; sort?: ListSortSpec[] } = {};
  if (where !== undefined && where.length > 0) q.where = where;
  if (sort !== undefined && sort.length > 0) q.sort = sort;
  if (q.where === undefined && q.sort === undefined) return undefined;
  return JSON.stringify(q);
}

/** One row of a batch write (Wave B). `key` absent => create; present => upsert. */
export interface BatchRowInput {
  key?: string;
  data: unknown;
}

/**
 * The outcome of one row in a batch, addressed by its `index` in the input array
 * so a caller maps a failure back to the exact row it sent. `ok:true` carries the
 * written `key`; `ok:false` carries the per-row `error`.
 */
export interface BatchRowResult {
  index: number;
  ok: boolean;
  key?: string;
  error?: { code: string; message: string; status: number; details?: unknown };
}

/** The batch write / delete envelope: per-row results plus convenience counts. */
export interface BatchResult {
  results: BatchRowResult[];
  ok_count: number;
  error_count: number;
}

/**
 * Effect-suppression options for a batch (silent migration, Wave B). The batch
 * endpoint DEFAULTS to silent (suppresses both notify and webhooks). Pass
 * `emitEffects:true` (or `suppress:[]`) to fire effects, or `suppress` to mute a
 * specific subset. Honored only for an owner/agent key.
 */
export interface BatchWriteOptions {
  suppress?: ("notify" | "webhooks")[];
  emitEffects?: boolean;
  /**
   * Wave C1 natural-key upsert: match (or create) each row on this
   * declared-unique field's value instead of the row id, making a re-import
   * idempotent. Mutually exclusive with per-row `key`.
   */
  on?: string;
}

/**
 * One entry in an app's change feed — the SAME shape whether it arrives via
 * `GET /v1/apps/:id/feed` (long-poll) or the `/_hs/ws` live/batch frames
 * (openAppStream, app-stream.ts) — the CLI's `apps watch` prints this object
 * unchanged regardless of which transport served it (spec-cli §3.4/§5).
 */
export interface AppFeedEntry {
  seq: number;
  op: string;
  collection_name: string;
  row_key: string;
  // The row's true version at entry-record time (fix-sdk-version-drift),
  // reused here for consistency with the browser SDK's WireFeedEntry /
  // relay's SerializedFeedEntry. Optional: a relay predating this field, or
  // a locally-constructed test fixture, may omit it entirely.
  row_version?: number | null;
  data: unknown;
  author: { kind: string; id: string };
  ts: string;
}

export interface AppFeedPage {
  entries: AppFeedEntry[];
  cursor: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Community publish + review (M4b).
// ---------------------------------------------------------------------------

/** Request body for `publishCommunityTemplate()`. */
/**
 * One typed agent-setup step (marketplace PR 9). An ordered list of these tells
 * an installing agent what to configure after install. Carries only the
 * publisher's own defaults + hints, never an installer's value; `secret: true`
 * marks a step whose eventual value is sensitive (its default is masked on the
 * public detail page). The relay validates + normalizes on publish.
 */
export interface CommunitySetupStep {
  kind: "config" | "seed-data" | "connect" | "note" | "upload";
  label: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  default?: string;
  choices?: string[];
  valueHint?: string;
  /**
   * The settings-collection field this step's answer is written into
   * (install-config programme). Required for an `upload` step, optional for a
   * `config` step, and not allowed on the other kinds. Field-key identifier
   * (letters, digits, '_', up to 64 chars).
   */
  key?: string;
}

export interface PublishCommunityTemplateRequest {
  /** The owned app to publish. */
  appId: string;
  /** Listing title; defaults server-side to the app's manifest name. */
  title?: string;
  /** Listing blurb; defaults server-side to the manifest description. */
  description?: string;
  /**
   * Optional long-form description (template-experience PR 5a): richer prose
   * rendered on the detail page below the short blurb. Plain text, length-capped
   * server-side; blank lines become escaped paragraph breaks (never raw HTML).
   */
  longDescription?: string;
  /** Optional category (validated server-side against the fixed enum). */
  category?: string;
  /** Optional curation tags. */
  tags?: string[];
  /**
   * Optional per-publisher slug (marketplace PR 2). When set, the template gets
   * a namespaced id `<handle>/<slug>` and joins a versioned line.
   */
  slug?: string;
  /** Optional semver version; defaults server-side to "1.0.0". */
  version?: string;
  /** Optional note recorded in this version's changelog entry. */
  changelogNote?: string;
  /**
   * Optional ordered typed setup steps (marketplace PR 9). Validated + stored
   * server-side; read back through the detail page + get_submission.
   */
  setupSteps?: CommunitySetupStep[];
  /** Optional remix/fork lineage: the snapshot id this was derived from. */
  derivedFromSnapshotId?: string;
  /**
   * The example-only attestation (marketplace PR 10). Set true to attest the
   * captured template content AND its captured seed rows contain no real
   * personal data: publishing makes both PUBLIC to all platform users. Recorded
   * (not a hard gate) and surfaced to the operator review payload; omitting it
   * still publishes but is shown to the reviewer as "not attested".
   */
  attestExampleOnly?: boolean;
}

export interface PublishCommunityTemplateResponse {
  snapshot_id: string;
  review_status: "pending" | "approved" | "rejected";
  name: string;
  seeded_row_count: number;
  slug: string | null;
  version: string;
  /** How many typed setup steps were stored (marketplace PR 9). */
  setup_step_count: number;
  /**
   * The example-only attestation as recorded (marketplace PR 10): true/false as
   * attested, or null when the publish carried no attestation.
   */
  attest_example_only: boolean | null;
  /**
   * Fast-track outcome (marketplace PR 11). `expedited`: the publisher is
   * `established` and the submission still landed `pending`, flagged to sort
   * first in the operator review queue. `auto_approved`: the publisher is
   * `established` AND the relay enables true auto-approve, so it was approved
   * immediately at publish (review_status === "approved"). Both false for a
   * `new` publisher (ordinary full review).
   */
  expedited: boolean;
  auto_approved: boolean;
}

/** A pending-submission summary in the operator review queue. */
export interface CommunitySubmissionSummary {
  snapshot_id: string;
  name: string;
  description: string | null;
  /**
   * Publisher-provided long-form description (template-experience PR 5a),
   * surfaced in the review payload so the operator sees the full prose that
   * renders on the detail page. Null when the publish carried none.
   */
  long_description: string | null;
  category: string | null;
  tags: string[];
  review_status: "pending" | "approved" | "rejected";
  publisher_human_id: string | null;
  publisher_name: string | null;
  source_app_id: string | null;
  seeded_row_count: number;
  published_at: string;
  /** Namespaced identity + version (marketplace PR 2); null when unset. */
  slug: string | null;
  version: string | null;
  /**
   * Publish-time PII attestation (marketplace PR 10): true/false as attested by
   * the publisher, or null when the publish carried no attestation. Surfaced in
   * the review queue so a missing attestation is visible to the operator.
   */
  attest_example_only: boolean | null;
  /**
   * Fast-track flag (marketplace PR 11): true when this pending submission was
   * expedited (published by an `established` publisher, sorted first in the
   * queue). False for a `new` publisher and pre-PR-11 rows.
   */
  expedited: boolean;
  /** The publisher's trust level (marketplace PR 11): "new" | "established". */
  publisher_trust_level: string;
}

export interface CommunitySubmissionsPage {
  items: CommunitySubmissionSummary[];
  next_cursor: string | null;
}

/** One collection's captured-seed footprint (marketplace PR 10). */
export interface CommunitySeedCollectionSummary {
  collection: string;
  row_count: number;
  bytes: number;
}

/** A per-collection digest of a submission's captured seed rows (PR 10). */
export interface CommunitySeedRowSummary {
  collections: CommunitySeedCollectionSummary[];
  total_rows: number;
  total_bytes: number;
}

/** A submission's FULL content, for operator review. */
export interface CommunitySubmissionDetail extends CommunitySubmissionSummary {
  html: string;
  manifest: unknown;
  seed_rows: unknown;
  /**
   * A digest of seed_rows (marketplace PR 10): per-collection row counts + byte
   * sizes plus totals, so the operator sees how much (and which) captured
   * starter data would become public without parsing the raw rows.
   */
  seed_summary: CommunitySeedRowSummary;
  version_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  superseded_at: string | null;
  /** Namespaced identity + fork/license fields (marketplace PR 2). */
  changelog: unknown;
  license: string | null;
  license_terms: string | null;
  derived_from_snapshot_id: string | null;
  /**
   * Typed agent-setup steps (marketplace PR 9): the machine-readable structure
   * an agent reads. Full structure incl. secret-flagged steps (a step stores
   * only the publisher's default/hint, never an installer value). `null` when
   * the template declares no steps.
   */
  setup_steps: CommunitySetupStep[] | null;
}

// ---------------------------------------------------------------------------
// Community publisher identity (marketplace PR 1).
// ---------------------------------------------------------------------------

/** A publisher's own profile, as returned by the `/v1/publisher` routes. */
export interface PublisherProfile {
  handle: string;
  display_name: string | null;
  bio: string | null;
  url: string | null;
  /** True once the handle has been claimed (and is therefore permanent). */
  claimed: boolean;
  claimed_at: string | null;
  created_at: string;
  first_published_at: string | null;
  approved_template_count: number;
  rating_count: number;
  rating_sum: number;
  trust_level: string;
}

/**
 * The mutable profile fields for `updatePublisher()`. A field left `undefined`
 * is untouched; `null` clears it.
 */
export interface PublisherProfileUpdate {
  displayName?: string | null;
  bio?: string | null;
  url?: string | null;
}

// ---------------------------------------------------------------------------
// Community reviews (marketplace PR 7).
// ---------------------------------------------------------------------------

/** Request body for `createReview()`. Give `template` OR (`handle` + `slug`). */
export interface CreateCommunityReviewRequest {
  /** Namespaced template id, "<handle>/<slug>". */
  template?: string;
  /** Publisher handle (with `slug`, as an alternative to `template`). */
  handle?: string;
  /** Per-publisher slug (with `handle`). */
  slug?: string;
  /** Star rating, integer 1..5. */
  stars: number;
  /** Optional written review body. */
  body?: string;
}

/** A review as returned by the `/v1/reviews` routes. */
export interface CommunityReview {
  id: string;
  template_publisher_human_id: string;
  template_slug: string | null;
  snapshot_id: string;
  install_id: string | null;
  reviewer_human_id: string;
  stars: number;
  body: string | null;
  /** "visible" | "held" | "removed". A body with a link/email lands "held". */
  status: string;
  held_reason: string | null;
  publisher_response: string | null;
  publisher_responded_at: string | null;
  created_at: string;
}

/** Result of `reportReview()`. */
export interface CommunityReviewReportResult {
  report_id: string;
  review_id: string;
}

/** Per-attachment metadata as returned by `POST /v1/attachments` and friends. */
export interface AttachmentRef {
  attachment_id: string;
  scope: "agent" | "app";
  mime: string;
  size: number;
  sha256: string;
  url?: string;
  width?: number | null;
  height?: number | null;
  filename?: string | null;
  status?: string;
  app_id?: string | null;
  created_at?: string;
  confirmed_at?: string | null;
  deleted_at?: string | null;
}

export interface UploadBlobOptions {
  scope?: "agent" | "app";
  appId?: string;
  /** Declared Content-Type. Defaults to `application/octet-stream`. The
   *  relay sniffs leading bytes and may reject with `mime_mismatch`. */
  mime?: string;
  /** Optional display name (the relay records it for UX; never a path component). */
  filename?: string;
}

export interface PresignBlobOptions {
  mime: string;
  size: number;
  sha256: string;
  scope?: "agent" | "app";
  appId?: string;
  filename?: string;
}

export interface AttachmentTokenMintResponse {
  token_id: string;
  token: string;
  token_prefix: string;
  url: string;
  expires_at: string;
  once: boolean;
}

/** Options for `listBlobs()` — opaque cursor + page-size knob. */
export interface ListBlobsOptions {
  /** Opaque pagination cursor from a prior `next_cursor`. */
  cursor?: string;
  /** Page size; relay clamps to 1..100. Defaults to the relay default (50). */
  limit?: number;
}

/** One row in the response from `listBlobTokens()`. */
export interface AttachmentTokenAuditEntry {
  token_id: string;
  token_prefix: string;
  expires_at: string;
  once: boolean;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  /** Non-null when the token has been revoked. Expired-but-unrevoked rows
   *  carry `revoked_at: null` and an `expires_at` in the past — both are
   *  useful for audit. */
  revoked_at: string | null;
}

/** Shape returned by `listBlobTokens()`. */
export interface AttachmentTokenListResponse {
  attachment_id: string;
  items: AttachmentTokenAuditEntry[];
}
