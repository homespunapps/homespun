// Tool definitions for the Homespun MCP server.
//
// Each tool wraps one or more @homespunapps/core HomespunClient operations. The
// descriptions are written for the LLM consumer — they ARE the docs the model
// reads to decide when and how to call each tool. Keep them concrete and
// action-oriented.
//
// Surface design (v2-only — the v1 homespun-lifecycle/events/records/
// participant/share/query tools were removed along with the rest of the v1
// app API, and the v1 Template subsystem's template/template_records/trash
// tools were removed in PR 2c-1; see git history for the prior surfaces):
//   - v2 app lifecycle + data are DISCRETE tools: deploy_app, list_rows,
//     get_row, upsert_row, update_row, delete_row, get_feed_events.
//   - Multi-verb MANAGEMENT nouns each collapse into ONE tool with a required
//     `action` enum and per-action fields: apps, members, attachments, taste,
//     key, feedback, agent.
//   - skill → get_skill (no API key).
//
// MCP is request/response: there is no streaming.
//
// Schema validation uses Zod raw shapes (the shape McpServer.registerTool
// expects); the SDK validates arguments before the handler runs. For
// consolidated tools the per-action required fields are documented in the tool
// description and re-checked in the handler (a Zod raw shape can't express a
// discriminated union across a flat field set, so the handler asserts the
// action-specific requirements and returns a tight invalid_args error).

import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type {
  AppAsset,
  CommunitySetupStep,
  HomespunClient,
  ListWhereCondition,
} from "@homespunapps/core";
import { HomespunApiError } from "@homespunapps/core";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  resolveUrl,
  describeActiveConfig,
  clearActiveProfile,
} from "./config.js";
import { fetchSkill } from "./skill.js";

/**
 * A structured MCP tool result (text content + optional error flag). The
 * index signature keeps it structurally assignable to the SDK's
 * CallToolResult (which carries an open `[x: string]: unknown`).
 */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Host-supplied capabilities for the handful of tools that aren't pure
 * HomespunClient wrappers. The stdio server leaves this undefined and the
 * handlers fall back to the CLI config store + a network skill fetch; the
 * relay's HTTP MCP server injects an `env` so those tools resolve against the
 * relay itself (no CLI config on disk, no self-HTTP loop for the skill).
 *
 * This is the single seam that keeps the TOOLS array transport-agnostic and
 * reusable by BOTH servers — every other tool is already a thin HomespunClient
 * call and needs nothing from the host.
 */
export interface ToolEnv {
  /** `agent` action=whoami — describe the active identity (no secrets). */
  describeConfig?: () => Record<string, unknown>;
  /** `agent` action=logout — clear the locally-saved profile. */
  clearProfile?: () => Record<string, unknown>;
  /**
   * `get_skill` — return the MCP-flavoured skill markdown + its version. The
   * relay passes its in-process renderer; the stdio server fetches it over
   * HTTP from the relay's /skills route.
   */
  getSkill?: (versionOnly: boolean) => Promise<{
    markdown?: string;
    version?: string;
  }>;
  /**
   * Whether tool handlers may touch the HOST filesystem on behalf of the
   * caller (readFileSync for html_path / file_path, writeFileSync for
   * out_path). When absent or true, host filesystem access is allowed: the
   * stdio / local CLI is a trusted local host, so this preserves the existing
   * convenience of passing a local path. When explicitly false, host
   * filesystem access is DENIED. The hosted multi-tenant relay sets this to
   * false so an authenticated remote agent can never read or write the relay
   * container's own files (a local file inclusion / exfiltration vector),
   * e.g. deploy_app html_path=/app/.env.
   */
  hostFsReads?: boolean;
}

/** One registered tool: name, human/LLM description, Zod input shape, handler. */
export interface ToolDef {
  name: string;
  description: string;
  // Zod raw shape — the object passed to z.object(). The MCP SDK accepts this
  // directly in registerTool({ inputSchema }) and validates arguments with it.
  inputSchema: z.ZodRawShape;
  // MCP tool annotations (ToolAnnotations: title + behavioural hints). Both
  // servers thread this straight into registerTool's config so the hints
  // surface in tools/list output for the stdio AND HTTP transports. Hints are
  // advisory metadata for the client/host (Anthropic's connector directory
  // reads them to classify a tool as read-only vs destructive); they do NOT
  // change server behaviour. The hint reflects the MOST-privileged action a
  // tool can take — a consolidated action-enum tool that CAN delete is marked
  // destructive even though it also has read sub-actions.
  annotations: ToolAnnotations;
  // `env` is optional: when omitted (the stdio server + existing tests) the
  // config/skill-coupled tools use their CLI defaults; the relay's HTTP server
  // injects one so the same handlers run server-side.
  handler: (
    client: HomespunClient,
    args: Record<string, unknown>,
    env?: ToolEnv,
  ) => Promise<ToolResult>;
}

/** Wrap a JSON-able value as a single text-content tool result. */
function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/** Plain text result (used by get_skill for raw markdown). */
function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Turn any thrown error into a structured `isError` tool result. HomespunApiError
 * carries the relay's `code`, HTTP `status`, and an optional remediation
 * `hint`; surface all of it so the model can self-correct (e.g. fix an event
 * type the schema rejected) instead of getting an opaque failure.
 */
function errorResult(e: unknown): ToolResult {
  if (e instanceof HomespunApiError) {
    const payload: Record<string, unknown> = {
      error: e.code,
      status: e.status,
      message: e.message,
    };
    if (e.hint) payload["hint"] = e.hint;
    if (e.details !== undefined) payload["details"] = e.details;
    if (e.retryable !== undefined) payload["retryable"] = e.retryable;
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      isError: true,
    };
  }
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "internal", message }, null, 2),
      },
    ],
    isError: true,
  };
}

/**
 * Structured invalid_args error for the per-action validation inside
 * consolidated tools. Mirrors the relay's envelope so the model self-corrects.
 */
function invalidArgs(message: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: "invalid_args", message }, null, 2),
      },
    ],
    isError: true,
  };
}

/** Read a required string arg; returns undefined when absent/empty. */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Read a boolean arg; undefined when absent or not a boolean. */
function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

/** True for a non-null, non-array plain object (`{"type":"object"}` land). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Defense in depth for a client harness that serializes an object-valued
 * argument as a JSON *string* instead of a JSON object (the reported bug). If
 * `value` is a string that JSON-parses to an object, return the parsed object;
 * if it is a string that does NOT parse as JSON at all, return a tight
 * invalid_args error naming the field. Anything else (already an object /
 * array / number / boolean / null, or a string that parses to a non-object
 * JSON value) is passed through unchanged - we never silently coerce.
 */
function parseMaybeStringifiedObject(
  value: unknown,
  field: string,
): { value: unknown } | { error: ToolResult } {
  if (typeof value !== "string") return { value };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {
      error: invalidArgs(
        `\`${field}\` must be a JSON object, not a string; received a string that is not valid JSON`,
      ),
    };
  }
  if (isPlainObject(parsed)) return { value: parsed };
  return { value };
}

/**
 * A JSON object schema (`{"type":"object"}` in the emitted tool schema). Using
 * z.record here - rather than z.unknown, which emits NO type keyword - is what
 * signals harnesses that an OBJECT is expected so they stop stringifying it.
 */
const jsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * A permissive "any JSON value" schema that STILL advertises what is allowed:
 * it serializes to an `anyOf` of typed branches (object|array|string|number|
 * boolean|null) rather than a bare, type-less `{}`. Matches what the relay
 * actually accepts for a row body (any JSON value valid against the
 * collection's row schema, if any).
 */
const jsonValueSchema = z.union([
  jsonObjectSchema,
  z.array(z.unknown()),
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

// ===========================================================================
// v2 app lifecycle + data (discrete, hot-path)
// ===========================================================================

const deployAppShape = {
  app_id: z
    .string()
    .optional()
    .describe(
      "Omit to CREATE a new app; pass an existing app's id to REDEPLOY it (a new version, compat-gated unless force:true).",
    ),
  html: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The app's UI as a complete HTML document (single file, up to the relay's size cap), sent INLINE. Provide EITHER this or `html_path`. Inline is required for a hosted/remote connector that has no filesystem. If both are given, inline `html` wins.",
    ),
  html_path: z
    .string()
    .optional()
    .describe(
      "ABSOLUTE path to the app's HTML document, read on the MCP-SERVER host (the machine running this connector: the relay for a hosted connector, or your CLI host for a locally-run one), NOT on the remote agent's machine. Alternative to inline `html` that avoids retransmitting a large HTML file on every deploy. Only works when the file is local to the MCP server, so it helps a locally-run connector, not a hosted/remote one (where the path will not exist and you get a clean error, so pass inline `html` there). If both `html` and `html_path` are given, inline `html` wins.",
    ),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Validate only: run the full manifest + asset-shape validation, the compat gate (for a redeploy), and the schedule-timezone advisory, then return { ok, warnings, compat?, breaks? } WITHOUT creating a version or mutating anything. An invalid manifest returns the SAME error a real deploy would; a narrowing redeploy reports the compat break instead of applying it. `check` is an accepted alias.",
    ),
  check: z.boolean().optional().describe("Alias for `dry_run`."),
  manifest: jsonObjectSchema.describe(
    "The x-homespun-manifest capability document (a JSON object). Eight extension keys: app metadata; collections (+ per-collection write/read/delete role lists); externalHosts (fetch allowlist); cdn (allow CDN scripts/styles); capabilities (Permissions-Policy opt-ins); embeds (iframe frame-src allowlist); notify (email-on-row rules); webhooks (signed HTTP POST on-row rules). Call get_skill for the full grammar before authoring one from scratch.",
  ),
  visibility: z
    .enum(["private", "link", "public"])
    .optional()
    .describe(
      "CREATE only. Default 'private' (owner plus invited members, sign-in gated). 'link' shares with anyone holding the returned share_url, whose #k= fragment carries a secret key that can be reset (rotate it via the apps tool, action share_link_rotate) to cut off everyone with the old link; a 'link' app always gets a server-generated unguessable slug. 'private' and 'public' accept an owner-chosen `slug`.",
    ),
  slug: z
    .string()
    .optional()
    .describe(
      "CREATE only. Accepted with visibility private or public, including the private default; rejected with explicit visibility 'link', where the slug is always server-generated.",
    ),
  force: z
    .boolean()
    .optional()
    .describe(
      "REDEPLOY only. Bypass the compat gate on a narrowing manifest change (a removed/narrowed collection is detached, never deleted).",
    ),
  assets: z
    .array(
      z.object({
        path: z
          .string()
          .describe(
            "App-relative, same-origin reference the HTML uses, e.g. 'frames/000.jpg' or 'media/intro.mp4'. Relative ONLY: no leading '/', no '..' segment, no backslash, charset [A-Za-z0-9._/-], not under a reserved prefix (_hs, b).",
          ),
        content_base64: z
          .string()
          .describe("Standard base64 of the asset's raw bytes."),
        mime: z
          .string()
          .optional()
          .describe(
            "Advisory content-type. The relay sniffs the REAL type from the bytes and enforces the attachment allowlist; omit it (or set application/octet-stream) for data files like CSV that don't magic-byte-sniff, so they are stored + served as an inert download.",
          ),
      }),
    )
    .optional()
    .describe(
      "Optional bundle of files shipped WITH the app in ONE deploy: images, fonts, audio/video, data. Each asset is validated + stored app-scoped exactly like a normal attachment (byte-sniff, allowlist, size cap, quota, scan) and served at its `path` on the app's OWN origin, so the page references it by a stable same-origin path (`<img src=\"frames/000.jpg\">`, `<video src=\"media/intro.mp4\">`; media/font paths support HTTP Range). The whole deploy is rejected atomically if any asset fails validation. A redeploy's assets REPLACE the previous version's set. Bounded by the relay's per-deploy asset-count cap; total bytes by the per-app blob quota.",
    ),
};

const listRowsShape = {
  app_id: z.string().min(1).describe("The app id."),
  collection: z
    .string()
    .min(1)
    .describe("The collection name declared in the app's manifest."),
  since: z
    .string()
    .optional()
    .describe(
      "Opaque cursor from a previous call's next_cursor. Also the POLL handle: pass it back to fetch only newer/changed rows.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Page size."),
};

const getRowShape = {
  app_id: z.string().min(1).describe("The app id."),
  collection: z.string().min(1).describe("The collection name."),
  key: z.string().min(1).describe("The key of the row to fetch."),
};

const upsertRowShape = {
  app_id: z.string().min(1).describe("The app id."),
  collection: z.string().min(1).describe("The collection name."),
  key: z
    .string()
    .optional()
    .describe(
      "Optional stable key. Reusing an existing key returns the existing row (deduped:true).",
    ),
  data: jsonValueSchema.describe(
    "The row body - any JSON value valid against the collection's row schema (an object, or any JSON value for a schemaless collection).",
  ),
};

const updateRowShape = {
  app_id: z.string().min(1).describe("The app id."),
  collection: z.string().min(1).describe("The collection name."),
  key: z.string().min(1).describe("The key of the row to update."),
  data: jsonValueSchema.describe(
    "The new row body (replaces the row's data) - any JSON value valid against the collection's row schema.",
  ),
  if_match: z
    .number()
    .int()
    .optional()
    .describe(
      "Optional optimistic-lock version. On mismatch the update is rejected with the current row in details.current.",
    ),
};

const deleteRowShape = {
  app_id: z.string().min(1).describe("The app id."),
  collection: z.string().min(1).describe("The collection name."),
  key: z.string().min(1).describe("The key of the row to delete."),
  if_match: z
    .number()
    .int()
    .optional()
    .describe("Optional optimistic-lock version."),
};

const getFeedEventsShape = {
  app_id: z.string().min(1).describe("The app id."),
  since: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Opaque numeric cursor from a previous call's cursor. Omit (or 0) to read from the beginning.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max entries per page (capped server-side by FEED_PAGE_MAX)."),
  wait: z
    .number()
    .int()
    .min(0)
    .max(30)
    .optional()
    .describe(
      "Optional long-poll: how long the relay holds the request open waiting for a new entry (0-30s). Use ~25 when waiting for activity, then call again with the same cursor.",
    ),
};

const appsShape = {
  action: z
    .enum([
      "list",
      "show",
      "update",
      "share_link_rotate",
      "delete",
      "wake",
      "domain_set",
      "domain_status",
      "domain_remove",
    ])
    .describe(
      "list: YOUR owning human's apps. show/update/delete/wake: act on one app (app_id). share_link_rotate: rotate a 'link' app's share token, returning a new share_url (the old link stops working); also generates one if the app has none yet. domain_set/domain_status/domain_remove: manage the app's ONE custom domain (app_id; domain_set also needs domain).",
    ),
  app_id: z
    .string()
    .optional()
    .describe(
      "Required for show/update/share_link_rotate/delete/wake/domain_set/domain_status/domain_remove.",
    ),
  status: z
    .enum(["active", "dormant", "archived", "all"])
    .optional()
    .describe("list only. Default: active."),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("list only. Page size."),
  cursor: z
    .string()
    .optional()
    .describe("list only. Opaque cursor from a previous next_cursor."),
  slug: z.string().optional().describe("list only. Exact-match slug filter."),
  visibility: z
    .enum(["private", "link", "public"])
    .optional()
    .describe("update only. The new visibility (slug is immutable)."),
  timezone: z
    .string()
    .optional()
    .describe(
      "update only. The app's IANA timezone for `schedules` reminders (e.g. Europe/Berlin). An app that declares schedules with no timezone fires reminders at 08:00 UTC.",
    ),
  domain: z
    .string()
    .optional()
    .describe(
      "domain_set only. The bare custom domain to bind (e.g. app.example.com). The response's dns_records lists the DNS entries the domain owner must publish.",
    ),
};

const membersShape = {
  action: z
    .enum(["add", "list", "set_role", "remove", "roles"])
    .describe(
      "add: invite-or-attach a member by email (app_id+email; optional custom_role). list: the app's owner + members (app_id). set_role: change an existing member's custom role in place without signing them out (app_id+human_id+custom_role, null to clear). remove: drop a member (app_id+human_id). roles: the app's declared roles with, per collection, the EFFECTIVE access a holder has (separately for members and grant-link holders, whose role floors differ) plus how many members and live grant links hold each role (app_id).",
    ),
  app_id: z.string().min(1).describe("The app id."),
  email: z
    .string()
    .optional()
    .describe(
      "add only. The email to invite/attach. If a Human already exists for it, the member row is attached immediately; otherwise the relay emails a magic-link invite.",
    ),
  role: z
    .enum(["member"])
    .optional()
    .describe(
      "add only. Defaults to 'member' server-side — no other role is assignable via this API (ownership transfer is not available here).",
    ),
  custom_role: z
    .string()
    .nullable()
    .optional()
    .describe(
      "add (optional) and set_role (required). A DECLARED custom role (an x-homespun-manifest.roles key) attached to the member ALONGSIDE their base member powers. A built-in/reserved role or an undeclared role is rejected. Omit on add for an ordinary member; pass null on set_role to clear the role back to a plain member.",
    ),
  human_id: z
    .string()
    .optional()
    .describe(
      "remove and set_role. The Human id to target — see list's `humanId` field. The app owner can be neither removed nor re-roled.",
    ),
};

const ingestShape = {
  action: z
    .enum(["list", "rotate"])
    .describe(
      "list: the app's inbound catch-hooks, each with its full secret URL, current rule (collection/mode/wake/handshake), and per-status delivery counts (app_id). rotate: mint a fresh secret for one hook and return its new URL once, invalidating the old URL immediately (app_id+name).",
    ),
  app_id: z.string().min(1).describe("The app id."),
  name: z
    .string()
    .optional()
    .describe(
      "rotate only. The manifest ingest hook name to rotate (an x-homespun-manifest.ingest[].name). See list's `name` field.",
    ),
};

// ===========================================================================
// Consolidated management tools
// ===========================================================================

const grantsShape = {
  action: z
    .enum(["mint", "list", "revoke"])
    .describe(
      "mint: create a grant link carrying a declared custom role (app_id+role). list: the app's grant links (app_id). revoke: revoke one link (app_id+grant_id).",
    ),
  app_id: z.string().min(1).describe("The app id."),
  role: z
    .string()
    .optional()
    .describe(
      "mint only. A DECLARED custom role for the app (an x-homespun-manifest.roles key). A built-in role (owner/member/agent/anyone) is rejected: a grant can never escalate.",
    ),
  mode: z
    .enum(["once", "multi"])
    .optional()
    .describe(
      "mint only. once: one-time link, claimed by the first browser that opens it (a real per-person link; later opens by others are inert). multi (default): a shared link, capped by max_uses within expiry.",
    ),
  max_uses: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "mint only (multi mode). Cap total claims; omit for unlimited within expiry. Ignored for once (forced to 1).",
    ),
  label: z
    .string()
    .optional()
    .describe("mint only. Optional owner label shown in the grant list."),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "mint only. Grant lifetime in seconds; defaults to the server default (30 days) and is clamped to the server max.",
    ),
  pin_row_key: z
    .string()
    .optional()
    .describe(
      "mint only. Optional narrowing pin to a single row key. NARROWS within the role (never widens). Mutually exclusive with pin_where.",
    ),
  pin_where: z
    .array(z.unknown())
    .optional()
    .describe(
      "mint only. Optional narrowing pin as Wave C2 where conditions ({field, op, value}[]). NARROWS within the role (never widens). Mutually exclusive with pin_row_key.",
    ),
  grant_id: z
    .string()
    .optional()
    .describe("revoke only. The grant link id (see list's `id` field)."),
};

const attachmentsShape = {
  action: z
    .enum([
      "upload",
      "presign",
      "finalize",
      "download",
      "show",
      "list",
      "delete",
      "mint_token",
      "revoke_token",
      "list_tokens",
    ])
    .describe(
      "Binary attachment operations. PREFER presign + finalize for any real image or media (anything beyond a tiny icon): presign returns a { put_url, attachment_id }, then YOU PUT the raw bytes to put_url over HTTP out-of-band, so the bytes NEVER enter the model context and cost NO tokens. upload with `content_base64` sends the bytes INLINE in the tool-call arguments, which loads them into the model context and costs tokens PROPORTIONAL TO FILE SIZE (even a few-hundred-KB image is very costly); use it only as a fallback for small assets or clients that cannot PUT out-of-band. upload: `content_base64` (base64 bytes, no filesystem) when you have bytes but no local file, or `file_path` (absolute, read on the RELAY host) when the file is local to the relay; scope agent|app. presign + finalize: (1) presign with { mime, size, sha256, scope }, (2) PUT the bytes to put_url out-of-band, (3) finalize confirms it (re-sniffs + re-checks the bytes). download: fetch bytes by attachment_id to out_path (absolute) or return base64. show: metadata only. list: the agent's attachments. delete: soft-delete. mint_token: mint a /b/<token> capability URL (returned ONCE). revoke_token / list_tokens: manage those tokens.",
    ),
  size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "presign: the exact byte length you will PUT. Committed at presign and re-verified against the uploaded bytes at finalize.",
    ),
  sha256: z
    .string()
    .optional()
    .describe(
      "presign: the hex SHA-256 (64 chars) of the exact bytes you will PUT. Committed at presign and re-verified against the uploaded bytes at finalize.",
    ),
  attachment_id: z
    .string()
    .optional()
    .describe(
      "Attachment id. Required for download/show/delete/mint_token/revoke_token/list_tokens.",
    ),
  file_path: z
    .string()
    .optional()
    .describe(
      "upload: ABSOLUTE path to a file read on the SERVER host running this MCP connector (the relay), NOT your machine. Only works when the file is local to the relay (e.g. a locally-run CLI). For a hosted or remote agent, use `content_base64` instead.",
    ),
  content_base64: z
    .string()
    .optional()
    .describe(
      "upload: the file bytes as base64, sent INLINE with no filesystem access. WARNING: the base64 rides in the tool-call arguments and enters the MODEL CONTEXT, costing tokens PROPORTIONAL TO FILE SIZE (a few-hundred-KB image is already very costly, and it compounds on every retry). PREFER presign + finalize for any real image or media whenever the client can do an out-of-band HTTP PUT; reserve `content_base64` for small assets (a tiny icon) or clients that cannot PUT out-of-band. If both `content_base64` and `file_path` are given, `content_base64` wins. The relay sniffs the real type and enforces the same size/allowlist/quota checks as a file upload.",
    ),
  scope: z
    .enum(["agent", "app"])
    .optional()
    .describe("upload scope (default agent)."),
  app_id: z.string().optional().describe("Required when scope=app."),
  filename: z
    .string()
    .optional()
    .describe("upload: display filename (defaults to the file's basename)."),
  mime: z
    .string()
    .optional()
    .describe(
      "upload/presign: advisory Content-Type. The relay BYTE-SNIFFS the actual bytes and stores/serves that sniffed type regardless (a lying mime is caught, never served inline). Required for presign (scopes the upload URL + fails fast against the allowlist).",
    ),
  out_path: z
    .string()
    .optional()
    .describe(
      "download: ABSOLUTE path to write the bytes to. If omitted, the bytes are returned base64-encoded in the result.",
    ),
  cursor: z.string().optional().describe("list pagination cursor."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("list page size (1..100)."),
  ttl_seconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("mint_token: per-token TTL (clamped by scope default)."),
  once: z
    .boolean()
    .optional()
    .describe("mint_token: token self-deletes on first GET."),
  token_id: z
    .string()
    .optional()
    .describe("revoke_token: the token id to revoke."),
};

const tasteShape = {
  action: z
    .enum(["get", "set", "clear"])
    .describe(
      "The agent's freeform UI taste notes (markdown) — presentation preferences learned from human feedback. get: read them before generating an app. set: whole-document replace (taste, non-empty). clear: delete them.",
    ),
  taste: z
    .string()
    .optional()
    .describe(
      "The full markdown notes (required for set; whole-document replace, not append).",
    ),
};

const keyShape = {
  action: z
    .enum(["list", "revoke", "mint"])
    .describe(
      "The calling agent's API key. list: key info (agent_id, key_prefix, timestamps). mint: mint a NEW sibling API key for YOUR OWN agent identity (same scope/ownership) and return its raw value ONCE, so use it to hand a CLI or child process a working credential; the sibling is a distinct key that shows up in a subsequent `list` made WITH it, the owner can revoke it, and the raw value is never retrievable again. mint always acts on the calling agent, never another agent's id. revoke: self-destruct the agent's OWN key, which stops working immediately and is irreversible (requires confirm:true).",
    ),
  confirm: z.boolean().optional().describe("Required (true) for revoke."),
};

const feedbackShape = {
  action: z
    .enum(["create", "list"])
    .describe(
      "Feedback to the relay operator. create: submit a bug|feature|note with a message (optional app_id). list: the agent's own submissions, newest first.",
    ),
  type: z
    .enum(["bug", "feature", "note"])
    .optional()
    .describe("Feedback category (required for create)."),
  message: z
    .string()
    .optional()
    .describe("Message body (required for create)."),
  app_id: z
    .string()
    .optional()
    .describe("Optional app this feedback relates to (create)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe("list page size (default 50, max 100)."),
  before: z
    .string()
    .optional()
    .describe("list cursor from a prior page's next_before."),
};

const agentShape = {
  action: z
    .enum(["whoami", "claim", "logout"])
    .describe(
      "Agent identity. whoami: show the resolved relay URL, active profile, and whether a key is configured (no network, no secrets). claim: bind this agent to a human via a one-shot claim code the human generated in their Settings UI (one-way). logout: clear the locally-saved key/profile (does NOT revoke it on the relay — use the key tool's revoke for that).",
    ),
  code: z
    .string()
    .optional()
    .describe("The one-shot claim code (required for claim)."),
};

const communityShape = {
  action: z
    .enum([
      "publish",
      "list_pending",
      "get_submission",
      "approve",
      "reject",
      "set_trust_level",
    ])
    .describe(
      "publish: publish one of YOUR apps as a community template (app_id; optional title/description/category/tags). PRIVACY: publishing makes the template content AND the captured seed rows (the LIVE rows of every seedOnInstall collection, captured at publish time) PUBLIC to every platform user once approved. Do NOT publish an app whose seedOnInstall collections hold real personal data (names, emails, addresses, messages, anything private): seed data must be example-only. Pass attest_example_only:true to attest you have checked this. The capture (html + manifest + seed rows) lands PENDING review, installable by its returned direct link but not listed until approved; an ESTABLISHED publisher is fast-tracked (the response's expedited/auto_approved tell you which). list_pending / get_submission / approve / reject / set_trust_level are RELAY-OPERATOR-only review actions: list_pending (the review queue, expedited submissions first), get_submission (a submission's full html+manifest+seedRows, by snapshot_id), approve (snapshot_id, lists it in the gallery + supersedes the app's prior approved version), reject (snapshot_id + a required note that lands in the publisher's app feed), set_trust_level (promote/demote a publisher by handle: handle + trust_level 'new'|'established').",
    ),
  app_id: z
    .string()
    .optional()
    .describe("publish only. The id of an app YOU own to publish."),
  title: z
    .string()
    .optional()
    .describe(
      "publish only. Listing title (1 to 80 chars). Defaults to the app's manifest name.",
    ),
  description: z
    .string()
    .optional()
    .describe(
      "publish only. Listing blurb (up to 200 chars). Defaults to the manifest description.",
    ),
  long_description: z
    .string()
    .optional()
    .describe(
      "publish only. Optional long-form description (up to 4000 chars) shown on the template detail page below the short blurb, for readers and search ranking. Plain text: blank lines become paragraphs, and it is escaped (never rendered as raw HTML), so write prose, not markup.",
    ),
  category: z
    .string()
    .optional()
    .describe(
      "publish only. Optional single-word category (e.g. 'household').",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("publish only. Up to 6 curation tags."),
  slug: z
    .string()
    .optional()
    .describe(
      "publish only. Optional per-publisher slug (lowercase, 3 to 48 chars, hyphens). Gives the template a namespaced id <your-handle>/<slug>; a republish reuses the slug and must bump the version.",
    ),
  version: z
    .string()
    .optional()
    .describe(
      "publish only. Semver MAJOR.MINOR.PATCH (default '1.0.0'). A republish under the same slug must be strictly greater than the current version.",
    ),
  changelog_note: z
    .string()
    .optional()
    .describe(
      "publish only. A short note recorded in this version's changelog.",
    ),
  setup_steps: z
    .array(
      z.object({
        kind: z
          .enum(["config", "seed-data", "connect", "note"])
          .describe(
            "config = set a value; connect = wire up an external data source; seed-data = review/replace captured starter data; note = a plain instruction.",
          ),
        label: z.string().describe("Short step label (<= 80 chars)."),
        description: z
          .string()
          .optional()
          .describe("Optional longer instruction (<= 300 chars)."),
        required: z
          .boolean()
          .optional()
          .describe("Whether this step is required (default false)."),
        secret: z
          .boolean()
          .optional()
          .describe(
            "Mark a step whose value is sensitive (an API key/token). Its default is MASKED on the public detail page; publish only your own example default, never a real secret.",
          ),
        default: z
          .string()
          .optional()
          .describe("Optional example/default value (<= 200 chars)."),
        choices: z
          .array(z.string())
          .optional()
          .describe("Optional list of allowed values (up to 12)."),
        valueHint: z
          .string()
          .optional()
          .describe("Optional format hint (<= 120 chars)."),
      }),
    )
    .optional()
    .describe(
      "publish only. Ordered typed setup steps an installing agent follows after install (up to 20). Read back via get_submission and rendered on the template detail page.",
    ),
  derived_from_snapshot_id: z
    .string()
    .optional()
    .describe(
      "publish only. Optional remix/fork lineage: the snapshot id this template was derived from.",
    ),
  attest_example_only: z
    .boolean()
    .optional()
    .describe(
      "publish only. Set true to attest that the template content AND the captured seed rows contain NO real personal data. Publishing makes both PUBLIC to every platform user, so seed data (the live rows of your seedOnInstall collections) must be example-only, never real names/emails/addresses/private messages. Recorded and shown to the reviewer; omitting it still publishes but is flagged to the operator as not attested.",
    ),
  snapshot_id: z
    .string()
    .optional()
    .describe(
      "Required for get_submission/approve/reject. The submission's snapshot id (from publish's response or list_pending).",
    ),
  note: z
    .string()
    .optional()
    .describe(
      "reject only. The required rejection note shown to the publisher (delivered to their app feed).",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe("list_pending only. Page size (1..200)."),
  cursor: z
    .string()
    .optional()
    .describe("list_pending only. Opaque cursor from a prior next_cursor."),
  handle: z
    .string()
    .optional()
    .describe(
      "set_trust_level only. The @-handle of the publisher to promote or demote.",
    ),
  trust_level: z
    .enum(["new", "established"])
    .optional()
    .describe(
      "set_trust_level only. 'established' fast-tracks the publisher's future submissions through review; 'new' reverts to full review.",
    ),
};

const publisherShape = {
  action: z
    .enum(["claim", "get", "update"])
    .describe(
      "get: return YOUR publisher profile (handle, tenure, counters). claim: set your @-handle ONCE (handle arg; lowercase, 3 to 32 chars, permanent after claiming; needs a verified email). update: change your public display_name/bio/url (any of them; needs a verified email).",
    ),
  handle: z
    .string()
    .optional()
    .describe(
      "claim only. The lowercase @-handle to claim (^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$). Permanent once claimed.",
    ),
  display_name: z
    .string()
    .nullable()
    .optional()
    .describe(
      "update only. Public display name (up to 80 chars); null clears it.",
    ),
  bio: z
    .string()
    .nullable()
    .optional()
    .describe(
      "update only. Short public bio (up to 500 chars); null clears it.",
    ),
  url: z
    .string()
    .nullable()
    .optional()
    .describe(
      "update only. Public http(s) URL (up to 200 chars); null clears it.",
    ),
};

const reviewShape = {
  action: z
    .enum(["create", "respond", "report", "remove", "unhold"])
    .describe(
      'create: leave a star rating (1..5) and optional body on a community template YOU have installed (identify it by `template` "<handle>/<slug>" or by `handle`+`slug`); requires a verified email, and one review per install. A body containing a link or contact email is auto-held for a moderator before it shows. respond: reply to a review of one of YOUR OWN templates (review_id + response; null clears it). report: flag a review for the relay\'s moderators (review_id + reason; one report per account). remove / unhold are RELAY-OPERATOR-only moderation actions on a review_id: remove takes a review down (adjusting the aggregate), unhold publishes a previously auto-held review.',
    ),
  template: z
    .string()
    .optional()
    .describe(
      "create only. The namespaced template id <handle>/<slug> to review.",
    ),
  handle: z
    .string()
    .optional()
    .describe(
      "create only. Publisher handle (with `slug`), an alternative to `template`.",
    ),
  slug: z
    .string()
    .optional()
    .describe("create only. Per-publisher slug (with `handle`)."),
  stars: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe("create only. Star rating, an integer 1 to 5."),
  body: z
    .string()
    .optional()
    .describe("create only. Optional written review (up to 2000 chars)."),
  review_id: z
    .string()
    .optional()
    .describe("Required for respond/report/remove/unhold. The review's id."),
  response: z
    .string()
    .nullable()
    .optional()
    .describe(
      "respond only. The publisher's public response (up to 2000 chars); null clears it.",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "report only. Why you are reporting this review (up to 500 chars).",
    ),
};

const getSkillShape = {
  version_only: z
    .boolean()
    .optional()
    .describe(
      "If true, return only the relay's current skill version string instead of the full SKILL.md markdown.",
    ),
};

// ===========================================================================
// Tool definitions
// ===========================================================================

export const TOOLS: ToolDef[] = [
  // ----- v2 app lifecycle + data (discrete, hot-path) -----------------------
  {
    name: "deploy_app",
    description:
      "Deploy a v2 app: an HTML document + a capability manifest, hosted at its own URL. The manifest has eight extension keys: app metadata; collections (+ per-collection write/read/delete role lists); externalHosts (fetch allowlist); cdn (allow CDN scripts/styles); capabilities (Permissions-Policy opt-ins); embeds (iframe frame-src allowlist); notify (email-on-row rules); webhooks (signed HTTP POST on-row rules). Pass EITHER no `app_id` (create, mints a slug + URL) OR `app_id` (redeploy an existing app with new content). Supply the HTML as INLINE `html` OR as `html_path` (an absolute path read on the MCP-SERVER host, which is the relay for a hosted connector or your CLI host for a locally-run one, NOT the remote agent's machine; use it to avoid retransmitting a large HTML file every deploy, but only a locally-run connector can read it, and if both are given inline `html` wins). Pass `dry_run:true` (alias `check`) to VALIDATE ONLY: it runs the full manifest + asset-shape validation, the redeploy compat gate, and the schedule-timezone advisory, then returns { ok, warnings, compat?, breaks? } WITHOUT creating a version or mutating anything. A redeploy that NARROWS the manifest (drops a collection, tightens a schema, revokes a role) is refused with manifest_incompatible_redeploy unless force:true; a narrowed collection is then detached, never deleted. Ship images/fonts/audio/video/data FILES with the app in the SAME call via `assets[]`: each is validated + stored app-scoped and served at its `path` on the app's own origin, so the HTML references it by a stable same-origin path (`<img src=\"frames/000.jpg\">`, `<video src=\"media/clip.mp4\">`), media and font paths support HTTP Range for seeking. A redeploy's assets replace the previous version's set. BEFORE authoring: call get_skill for the manifest grammar. Returns { app_id, slug, url, version, visibility, created } (create) or { app_id, version, compat, breaks? } (redeploy).",
    inputSchema: deployAppShape,
    annotations: {
      title: "Deploy App",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args, env) => {
      try {
        const manifest = parseMaybeStringifiedObject(
          args["manifest"],
          "manifest",
        );
        if ("error" in manifest) return manifest.error;

        // Resolve the HTML from INLINE `html` or from `html_path` (read on the
        // MCP-server host). Inline wins when both are given: an explicit `html`
        // is a deliberate inline deploy, so never read a file the caller also
        // happened to name. `html_path` is read here (on the MCP server / relay
        // host), NOT on the calling agent's machine; a hosted connector's host
        // is Homespun's infra, so a remote agent's path ENOENTs; say so.
        const inlineHtml = str(args, "html");
        const htmlPath = str(args, "html_path");
        let html = inlineHtml;
        if (html === undefined && htmlPath !== undefined) {
          if (env?.hostFsReads === false) {
            return invalidArgs(
              "html_path is not available on this connection: the hosted relay does not read files from its own host on your behalf. Pass the HTML inline as `html` instead.",
            );
          }
          try {
            html = readFileSync(htmlPath, "utf8");
          } catch (e) {
            return invalidArgs(
              `failed to read html_path '${htmlPath}' (${e instanceof Error ? e.message : String(e)}). Note: html_path is read on the MCP server / relay host, not on your machine, so it only works when the file is local to the connector (e.g. a locally-run CLI). For a hosted or remote agent, pass the HTML inline as \`html\` instead.`,
            );
          }
        }
        const dryRun = args["dry_run"] === true || args["check"] === true;
        const assets = args["assets"] as AppAsset[] | undefined;
        const appId = str(args, "app_id");

        if (appId === undefined) {
          if (html === undefined) {
            return invalidArgs("create requires `html` or `html_path`");
          }
          if (dryRun) {
            return jsonResult(
              await client.checkDeploy({
                html,
                manifest: manifest.value,
                assets,
              }),
            );
          }
          const slug = str(args, "slug");
          const visibility = args["visibility"] as
            | "private"
            | "link"
            | "public"
            | undefined;
          if (slug !== undefined && visibility === "link") {
            return invalidArgs(
              "a `slug` is not allowed with visibility 'link' (link slugs are server-generated); drop visibility 'link', or omit slug",
            );
          }
          return jsonResult(
            await client.deployApp({
              html,
              manifest: manifest.value,
              visibility,
              slug,
              assets,
            }),
          );
        }
        if (html === undefined) {
          return invalidArgs("redeploy requires `html` or `html_path`");
        }
        if (dryRun) {
          return jsonResult(
            await client.checkDeploy({
              app_id: appId,
              html,
              manifest: manifest.value,
              force: args["force"] as boolean | undefined,
              assets,
            }),
          );
        }
        if (args["slug"] !== undefined || args["visibility"] !== undefined) {
          return invalidArgs(
            "slug/visibility cannot change on redeploy — slug is immutable, visibility changes via the `apps` tool (action: update)",
          );
        }
        const redeployed = await client.redeployApp(appId, {
          html,
          manifest: manifest.value,
          force: args["force"] as boolean | undefined,
          assets,
        });
        return jsonResult(redeployed);
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "list_rows",
    description:
      "List rows in a v2 app's mutable collection. This also doubles as the POLL for a collection's current state (no streaming in MCP): pass the prior next_cursor as `since` to fetch only newer/changed rows. Returns { rows, next_cursor, has_more }.",
    inputSchema: listRowsShape,
    annotations: {
      title: "List Rows",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        return jsonResult(
          await client.listAppRows(
            String(args["app_id"]),
            String(args["collection"]),
            {
              since: args["since"] as string | undefined,
              limit: args["limit"] as number | undefined,
            },
          ),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "get_row",
    description:
      "Fetch a single row by its key from a v2 app collection (a dedicated relay route — not a client-side scan). Returns { row } or an isError row_not_found.",
    inputSchema: getRowShape,
    annotations: {
      title: "Get Row",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        return jsonResult(
          await client.getAppRow(
            String(args["app_id"]),
            String(args["collection"]),
            String(args["key"]),
          ),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "upsert_row",
    description:
      "Create a row in a v2 app's collection, or return the existing row if `key` is already present (deduped:true) — the ONLY create-shaped verb for app rows (no separate strict create). Omit `key` to add a new row (server-generates one); pass `key` to ensure a row exists at that key. The collection must be declared in the app's manifest with 'agent' allowed to write. Returns { row, deduped? }.",
    inputSchema: upsertRowShape,
    annotations: {
      title: "Upsert Row",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const data = parseMaybeStringifiedObject(args["data"], "data");
        if ("error" in data) return data.error;
        const body: { key?: string; data: unknown } = { data: data.value };
        if (args["key"] !== undefined) body.key = String(args["key"]);
        return jsonResult(
          await client.upsertAppRow(
            String(args["app_id"]),
            String(args["collection"]),
            body,
          ),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "update_row",
    description:
      "Update an existing row in a v2 app's collection (replaces its data). Pass if_match with the row's current version for an optimistic-locked update — on a version mismatch the relay returns the current row so you can retry. Returns { row }.",
    inputSchema: updateRowShape,
    annotations: {
      title: "Update Row",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const data = parseMaybeStringifiedObject(args["data"], "data");
        if ("error" in data) return data.error;
        const body: { data: unknown; if_match?: number } = {
          data: data.value,
        };
        if (args["if_match"] !== undefined)
          body.if_match = args["if_match"] as number;
        return jsonResult(
          await client.updateAppRow(
            String(args["app_id"]),
            String(args["collection"]),
            String(args["key"]),
            body,
          ),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "delete_row",
    description:
      "Soft-delete a row from a v2 app's collection. A watcher sees the deletion live (op:delete on the change feed). Pass if_match for an optimistic-locked delete. Returns { deleted: true }.",
    inputSchema: deleteRowShape,
    annotations: {
      title: "Delete Row",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        await client.deleteAppRow(
          String(args["app_id"]),
          String(args["collection"]),
          String(args["key"]),
          args["if_match"] !== undefined
            ? { ifMatch: args["if_match"] as number }
            : {},
        );
        return jsonResult({ deleted: true, key: args["key"] });
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "get_feed_events",
    description:
      "Poll a v2 app's change feed for what happened (row creates/updates/deletes, from any writer — agent or human). This is the long-poll analogue of `homespun apps watch` — there is no streaming in MCP. Poll loop: call with no `since` first; process the returned entries; remember cursor; call again passing it as `since` to get only newer entries. To WAIT for activity, pass wait (~25) so the relay holds the request open until an entry arrives or it times out. A `since` older than the retention floor returns resync_required — re-list the collection(s) with list_rows instead. Returns { entries, cursor, truncated }.",
    inputSchema: getFeedEventsShape,
    annotations: {
      title: "Get App Feed Events",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        return jsonResult(
          await client.getAppFeed(String(args["app_id"]), {
            since: (args["since"] as number | undefined) ?? 0,
            limit: args["limit"] as number | undefined,
            wait: args["wait"] as number | undefined,
          }),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "apps",
    description:
      "Manage v2 app lifecycle (deploy_app creates/redeploys; this tool covers the rest). ONE tool with an `action` enum: list (YOUR owning human's apps) | show (full detail incl. manifest, timezone, has_share_token) | update (visibility and/or timezone - slug is immutable; switching TO 'link' returns a share_url once) | share_link_rotate (rotate a 'link' app's share token, returning a new share_url and revoking the old link; also generates one if the app has none) | delete (soft-delete, idempotent) | wake (a dormant app; a no-op reporting the actual status otherwise) | domain_set (bind ONE custom domain; returns the DNS records the domain owner must publish) | domain_status (the domain record, live-refreshed against Cloudflare when enabled; inspect last_error when it is not activating) | domain_remove (unbind the domain, idempotent).",
    inputSchema: appsShape,
    // Consolidated tool: read actions (list/show) + mutating ones (update/
    // delete/wake). Hint reflects delete, the most-privileged action.
    annotations: {
      title: "Manage Apps",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "list": {
            const opts: Record<string, unknown> = {};
            if (args["status"] !== undefined) opts["status"] = args["status"];
            if (args["limit"] !== undefined) opts["limit"] = args["limit"];
            if (args["cursor"] !== undefined) opts["cursor"] = args["cursor"];
            if (args["slug"] !== undefined) opts["slug"] = args["slug"];
            return jsonResult(
              await client.listApps(
                opts as Parameters<HomespunClient["listApps"]>[0],
              ),
            );
          }
          case "show":
            if (str(args, "app_id") === undefined) {
              return invalidArgs("show requires `app_id`");
            }
            return jsonResult(await client.getApp(String(args["app_id"])));
          case "update": {
            if (str(args, "app_id") === undefined) {
              return invalidArgs("update requires `app_id`");
            }
            if (
              str(args, "visibility") === undefined &&
              str(args, "timezone") === undefined
            ) {
              return invalidArgs(
                "update requires `visibility` and/or `timezone`",
              );
            }
            return jsonResult(
              await client.updateApp(String(args["app_id"]), {
                ...(args["visibility"] !== undefined
                  ? {
                      visibility: args["visibility"] as
                        | "private"
                        | "link"
                        | "public",
                    }
                  : {}),
                ...(args["timezone"] !== undefined
                  ? { timezone: String(args["timezone"]) }
                  : {}),
              }),
            );
          }
          case "delete":
            if (str(args, "app_id") === undefined) {
              return invalidArgs("delete requires `app_id`");
            }
            await client.deleteApp(String(args["app_id"]));
            return jsonResult({ app_id: args["app_id"], deleted: true });
          case "share_link_rotate":
            if (str(args, "app_id") === undefined) {
              return invalidArgs("share_link_rotate requires `app_id`");
            }
            return jsonResult(
              await client.rotateShareLink(String(args["app_id"])),
            );
          case "wake":
            if (str(args, "app_id") === undefined) {
              return invalidArgs("wake requires `app_id`");
            }
            return jsonResult(await client.wakeApp(String(args["app_id"])));
          case "domain_set":
            if (str(args, "app_id") === undefined) {
              return invalidArgs("domain_set requires `app_id`");
            }
            if (str(args, "domain") === undefined) {
              return invalidArgs("domain_set requires `domain`");
            }
            return jsonResult(
              await client.setAppDomain(
                String(args["app_id"]),
                String(args["domain"]),
              ),
            );
          case "domain_status":
            if (str(args, "app_id") === undefined) {
              return invalidArgs("domain_status requires `app_id`");
            }
            return jsonResult(
              await client.getAppDomain(String(args["app_id"])),
            );
          case "domain_remove":
            if (str(args, "app_id") === undefined) {
              return invalidArgs("domain_remove requires `app_id`");
            }
            await client.deleteAppDomain(String(args["app_id"]));
            return jsonResult({ app_id: args["app_id"], domain_removed: true });
          default:
            return invalidArgs(`unknown apps action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "members",
    description:
      "Manage a v2 app's membership (auth spec §6) — who besides the app's owner can sign in to a private app / write to member-scoped collections. ONE tool with an `action` enum: add (invite-or-attach a member by email — attaches immediately if the email already has a Human, otherwise the relay emails a magic-link invite) | list (the app's owner + members) | set_role (change an existing member's declared custom role in place, or null to clear it — does NOT revoke their sessions, so use this rather than remove-then-add to re-role someone) | remove (idempotent; also revokes the human's live sessions on this app — the app owner cannot be removed) | roles (the derived roles summary: per declared role and collection, the EFFECTIVE access a holder actually has, reported separately for signed-in members and for grant-link holders since their role floors differ, plus member and active-grant-link counts).",
    inputSchema: membersShape,
    // Consolidated tool: read action (list) + mutating ones (add/remove).
    // Hint reflects remove, the most-privileged action.
    annotations: {
      title: "Manage App Members",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      if (str(args, "app_id") === undefined) {
        return invalidArgs(`${action} requires \`app_id\``);
      }
      const appId = String(args["app_id"]);
      try {
        switch (action) {
          case "add": {
            if (str(args, "email") === undefined) {
              return invalidArgs("add requires `email`");
            }
            return jsonResult(
              await client.addAppMember(appId, {
                email: String(args["email"]),
                ...(args["role"] !== undefined
                  ? { role: args["role"] as "member" }
                  : {}),
                ...(args["custom_role"] !== undefined
                  ? { customRole: String(args["custom_role"]) }
                  : {}),
              }),
            );
          }
          case "list":
            return jsonResult(await client.listAppMembers(appId));
          case "roles":
            return jsonResult(await client.listAppRoles(appId));
          case "set_role": {
            if (str(args, "human_id") === undefined) {
              return invalidArgs("set_role requires `human_id`");
            }
            // The key must be PRESENT: null means "clear the role", which is a
            // real instruction, so an omitted key cannot be read as one.
            const role = args["custom_role"];
            if (role === undefined) {
              return invalidArgs(
                "set_role requires `custom_role` (a declared role name, or null to clear it)",
              );
            }
            return jsonResult(
              await client.setAppMemberRole(appId, String(args["human_id"]), {
                customRole: role === null ? null : String(role),
              }),
            );
          }
          case "remove": {
            if (str(args, "human_id") === undefined) {
              return invalidArgs("remove requires `human_id`");
            }
            await client.removeAppMember(appId, String(args["human_id"]));
            return jsonResult({
              app_id: appId,
              human_id: args["human_id"],
              removed: true,
            });
          }
          default:
            return invalidArgs(`unknown members action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  // ----- consolidated management tools --------------------------------------
  {
    name: "grants",
    description:
      "Manage a v2 app's grant links (M5). A grant link is a capability URL that confers a DECLARED custom role (x-homespun-manifest.roles) on a stable, per-holder anonymous identity, so the holder's own rows are isolated by author/:own scoping. A grant NEVER escalates to owner/member/agent. ONE tool with an `action` enum: mint (create a link; returns a `grant_url` carrying the token in its #g= fragment, shown ONCE, never recoverable) | list (the app's links, never any token) | revoke (idempotent). mode once = one-time (first-browser-claims), multi = shared (capped by max_uses within expiry). An optional pin (pin_row_key OR pin_where) NARROWS the holder to specific rows, never widens. Note: a write-only grant pinned to a single row key can still read that row's existing data back via create dedup, so a 'write-only to slot X' grant exposes slot X's current contents to the holder.",
    inputSchema: grantsShape,
    // Consolidated tool: read action (list) + mutating ones (mint/revoke).
    // Hint reflects revoke, the most-privileged action.
    annotations: {
      title: "Manage App Grant Links",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      if (str(args, "app_id") === undefined) {
        return invalidArgs(`${action} requires \`app_id\``);
      }
      const appId = String(args["app_id"]);
      try {
        switch (action) {
          case "mint": {
            if (str(args, "role") === undefined) {
              return invalidArgs("mint requires `role`");
            }
            const pinRowKey = str(args, "pin_row_key");
            const pinWhere = Array.isArray(args["pin_where"])
              ? (args["pin_where"] as ListWhereCondition[])
              : undefined;
            if (pinRowKey !== undefined && pinWhere !== undefined) {
              return invalidArgs(
                "mint accepts either `pin_row_key` or `pin_where`, not both",
              );
            }
            const pin =
              pinRowKey !== undefined
                ? { rowKey: pinRowKey }
                : pinWhere !== undefined
                  ? { where: pinWhere }
                  : undefined;
            return jsonResult(
              await client.mintAppGrant(appId, {
                role: String(args["role"]),
                ...(args["mode"] !== undefined
                  ? { mode: args["mode"] as "once" | "multi" }
                  : {}),
                ...(typeof args["max_uses"] === "number"
                  ? { maxUses: args["max_uses"] }
                  : {}),
                ...(str(args, "label") !== undefined
                  ? { label: String(args["label"]) }
                  : {}),
                ...(typeof args["ttl_seconds"] === "number"
                  ? { ttlSeconds: args["ttl_seconds"] }
                  : {}),
                ...(pin !== undefined ? { pin } : {}),
              }),
            );
          }
          case "list":
            return jsonResult(await client.listAppGrants(appId));
          case "revoke": {
            if (str(args, "grant_id") === undefined) {
              return invalidArgs("revoke requires `grant_id`");
            }
            await client.revokeAppGrant(appId, String(args["grant_id"]));
            return jsonResult({
              app_id: appId,
              grant_id: args["grant_id"],
              revoked: true,
            });
          }
          default:
            return invalidArgs(`unknown grants action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  // ----- consolidated management tools --------------------------------------
  {
    name: "ingest",
    description:
      "Manage a v2 app's inbound catch-hooks (inbound-webhooks). A catch-hook lets an EXTERNAL system (Stripe, Zapier, Make, Home Assistant, an email router) POST JSON to a secret URL that writes into a declared collection, so the app receives data even with no agent online. Hooks are DECLARED IN THE MANIFEST (x-homespun-manifest.ingest) and materialized at deploy, so this tool has no create/delete: use it to READ BACK the URL and rotate a leaked one. ONE tool with an `action` enum: list (the app's hooks, each with its full secret URL, current rule collection/mode/wake/handshake, and per-status delivery counts) | rotate (mint a fresh secret for one hook by name and return its NEW url once; the old url stops working immediately, no redeploy needed). After deploying a manifest that declares a hook, run list and tell the owner the exact url to paste into the external system.",
    inputSchema: ingestShape,
    // Consolidated tool: read action (list) + a mutating one (rotate). Marked
    // destructive (not read-only) because rotate invalidates the old URL, which
    // breaks any external system still using it, following the same "any
    // consolidated tool that can mutate is destructive" convention as members/
    // grants/apps.
    annotations: {
      title: "Manage App Inbound Hooks",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      if (str(args, "app_id") === undefined) {
        return invalidArgs(`${action} requires \`app_id\``);
      }
      const appId = String(args["app_id"]);
      try {
        switch (action) {
          case "list":
            return jsonResult(await client.listIngestHooks(appId));
          case "rotate": {
            if (str(args, "name") === undefined) {
              return invalidArgs("rotate requires `name`");
            }
            return jsonResult(
              await client.rotateIngestHook(appId, String(args["name"])),
            );
          }
          default:
            return invalidArgs(`unknown ingest action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  // ----- consolidated management tools --------------------------------------
  {
    name: "attachments",
    description:
      "Binary attachments (images, PDFs, audio, video) referenced from event payloads / input_data via `format: homespun-attachment-id`. ONE tool with an `action` enum: upload | presign | finalize | download | show | list | delete | mint_token | revoke_token | list_tokens. TOKEN COST, READ FIRST: an inline `upload` with `content_base64` carries the bytes in the tool-call arguments, so they enter the MODEL CONTEXT and cost tokens PROPORTIONAL TO FILE SIZE (a few-hundred-KB image is already very costly, worse on every retry). PREFER presign + finalize for ANY real image or media (anything beyond a tiny icon) whenever the client can do an out-of-band HTTP PUT, because the bytes then never touch the model context. upload (inline) takes EITHER `content_base64` (base64 bytes, no filesystem; use for SMALL assets or clients that cannot PUT out-of-band) OR `file_path` (ABSOLUTE path read on the RELAY host, only usable when the file is local to the relay). presign + finalize (the token-free path, for images/video/big audio): (1) presign with { mime, size, sha256, scope } returns { put_url, attachment_id }; (2) YOU PUT the raw bytes to put_url over plain HTTP out-of-band, so the bytes never route through this tool or the model context; (3) finalize with the attachment_id. At finalize the relay re-reads the stored bytes, BYTE-SNIFFS the real type, and enforces the same allowlist + size + sha256 + quota + scan checks as any upload, so a presign that lies about its mime is caught and never served inline. The presigned path requires the Azure storage backend; a filesystem self-host returns a clear not-supported error (use inline upload there). download writes to an ABSOLUTE out_path (or returns base64). Scope an upload to agent (default, reusable) or app. mint_token returns a /b/<token> capability URL (ONCE) a browser can GET without your API key.",
    inputSchema: attachmentsShape,
    // Consolidated tool: read actions (download/show/list/list_tokens) +
    // mutating ones (upload/delete/mint_token/revoke_token). openWorld:true
    // because upload pushes bytes into external relay storage + mint_token
    // produces a publicly-fetchable capability URL.
    annotations: {
      title: "Manage Attachments",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args, env) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "upload": {
            // `content_base64` is the documented field; `content` is a silent
            // alias for callers that used the earlier name.
            const contentBase64 =
              str(args, "content_base64") ?? str(args, "content");
            const filePath = str(args, "file_path");
            if (contentBase64 === undefined && filePath === undefined)
              return invalidArgs(
                "upload requires `content_base64` (base64 bytes) or `file_path` (a path local to the relay host)",
              );
            const scope = (str(args, "scope") ?? "agent") as "agent" | "app";
            if (scope === "app" && str(args, "app_id") === undefined)
              return invalidArgs("scope=app requires `app_id`");

            // Inline bytes win when both are given: an explicit `content_base64`
            // is a deliberate no-filesystem upload, so never fall back to reading
            // a file the caller also happened to name. No readFileSync on this
            // path; the base64 is sent straight to the relay's inline route.
            if (contentBase64 !== undefined) {
              const ref = await client.uploadBlobInline(contentBase64, {
                scope,
                appId: str(args, "app_id"),
                filename: str(args, "filename"),
                mime: str(args, "mime"),
              });
              return jsonResult(ref);
            }

            let bytes: Buffer;
            if (env?.hostFsReads === false) {
              return invalidArgs(
                "file_path is not available on this connection: the hosted relay does not read files from its own host on your behalf. Pass `content_base64` with the file bytes instead.",
              );
            }
            try {
              bytes = readFileSync(filePath!);
            } catch (e) {
              // `file_path` is read on the MCP server / relay host, NOT the
              // calling agent's machine. For a hosted connector that host is
              // Homespun's infra, so a remote agent's path always ENOENTs even
              // when the file exists on its side. Say so, and point at the fix.
              return invalidArgs(
                `failed to read file_path '${filePath}' (${e instanceof Error ? e.message : String(e)}). Note: file_path is read on the MCP server / relay host, not on your machine, so it only works when the file is local to the relay (e.g. a locally-run CLI). For a hosted or remote agent, pass content_base64 with the file bytes instead.`,
              );
            }
            const ref = await client.uploadBlob(bytes, {
              scope,
              appId: str(args, "app_id"),
              filename: str(args, "filename") ?? basename(filePath!),
              mime: str(args, "mime"),
            });
            return jsonResult(ref);
          }
          case "presign": {
            // Large-file direct-to-storage: reserve a pending attachment + get a
            // PUT URL. The caller PUTs the bytes to put_url over HTTP, then calls
            // finalize. `mime` is advisory (re-sniffed at finalize); size +
            // sha256 are the commitment the finalize re-verifies against the
            // uploaded bytes.
            const mime = str(args, "mime");
            const size = args["size"];
            const sha256 = str(args, "sha256");
            if (
              mime === undefined ||
              typeof size !== "number" ||
              sha256 === undefined
            )
              return invalidArgs(
                "presign requires `mime`, `size` (positive integer byte length), and `sha256` (hex sha-256 of the exact bytes you will PUT)",
              );
            const scope = (str(args, "scope") ?? "agent") as "agent" | "app";
            if (scope === "app" && str(args, "app_id") === undefined)
              return invalidArgs("scope=app requires `app_id`");
            const res = await client.presignBlob({
              mime,
              size,
              sha256,
              scope,
              appId: str(args, "app_id"),
              filename: str(args, "filename"),
            });
            // Surface it as { put_url, attachment_id, expires_at }; `put_url`
            // is the name the flow docs use for the out-of-band PUT target.
            return jsonResult({
              put_url: res.upload_url,
              attachment_id: res.attachment_id,
              expires_at: res.expires_at,
            });
          }
          case "finalize": {
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("finalize requires `attachment_id`");
            return jsonResult(
              await client.finalizeBlob(String(args["attachment_id"])),
            );
          }
          case "download": {
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("download requires `attachment_id`");
            const buf = await client.downloadBlob(
              String(args["attachment_id"]),
            );
            const outPath = str(args, "out_path");
            if (outPath !== undefined) {
              if (env?.hostFsReads === false) {
                return invalidArgs(
                  "out_path is not available on this connection: the hosted relay does not write files to its own host on your behalf. Omit out_path to receive the bytes as base64 instead.",
                );
              }
              try {
                writeFileSync(outPath, Buffer.from(buf));
              } catch (e) {
                return invalidArgs(
                  `failed to write out_path '${outPath}': ${e instanceof Error ? e.message : String(e)}`,
                );
              }
              return jsonResult({
                attachment_id: args["attachment_id"],
                written: outPath,
                bytes: buf.byteLength,
              });
            }
            return jsonResult({
              attachment_id: args["attachment_id"],
              bytes: buf.byteLength,
              base64: Buffer.from(buf).toString("base64"),
            });
          }
          case "show":
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("show requires `attachment_id`");
            return jsonResult(
              await client.getBlob(String(args["attachment_id"])),
            );
          case "list": {
            const opts: { cursor?: string; limit?: number } = {};
            if (str(args, "cursor") !== undefined)
              opts.cursor = String(args["cursor"]);
            if (args["limit"] !== undefined)
              opts.limit = args["limit"] as number;
            return jsonResult(await client.listBlobs(opts));
          }
          case "delete":
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("delete requires `attachment_id`");
            return jsonResult(
              await client.deleteBlob(String(args["attachment_id"])),
            );
          case "mint_token": {
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("mint_token requires `attachment_id`");
            return jsonResult(
              await client.mintBlobToken(String(args["attachment_id"]), {
                ttlSeconds: args["ttl_seconds"] as number | undefined,
                once: args["once"] === true,
              }),
            );
          }
          case "revoke_token":
            if (
              str(args, "attachment_id") === undefined ||
              str(args, "token_id") === undefined
            )
              return invalidArgs(
                "revoke_token requires `attachment_id` and `token_id`",
              );
            return jsonResult(
              await client.revokeBlobToken(
                String(args["attachment_id"]),
                String(args["token_id"]),
              ),
            );
          case "list_tokens":
            if (str(args, "attachment_id") === undefined)
              return invalidArgs("list_tokens requires `attachment_id`");
            return jsonResult(
              await client.listBlobTokens(String(args["attachment_id"])),
            );
          default:
            return invalidArgs(`unknown attachments action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "taste",
    description:
      "Read / write / clear the agent's freeform UI taste notes (a small markdown document of presentation preferences learned from human feedback — 'denser layout', 'no rounded corners'). ONE tool with an `action` enum: get | set | clear. Call `get` BEFORE generating an app so prior feedback shapes the output; `set` does a whole-document replace (not append). Keep entries about UI/presentation only.",
    inputSchema: tasteShape,
    // Consolidated tool: read action (get) + mutating ones (set replaces the
    // doc, clear deletes it). Hint reflects the destructive action.
    annotations: {
      title: "Manage UI Taste Notes",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "get":
            return jsonResult(await client.getTaste());
          case "set": {
            const taste = str(args, "taste");
            if (taste === undefined || taste.trim() === "")
              return invalidArgs(
                "set requires non-empty `taste` (use clear to delete the notes)",
              );
            return jsonResult(await client.setTaste(taste));
          }
          case "clear":
            await client.clearTaste();
            return jsonResult({ cleared: true });
          default:
            return invalidArgs(`unknown taste action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "key",
    description:
      "Inspect, mint, or revoke the calling agent's API key. ONE tool with an `action` enum: list (key info: agent_id, key_prefix, timestamps) | mint (mint a NEW sibling API key for YOUR OWN agent identity, same scope/ownership, and return its raw value ONCE, the way an MCP-driven agent bootstraps a CLI/child-process credential; the raw key is never retrievable again, the sibling appears in a `list` made WITH it, and the owner can revoke it) | revoke (self-destruct the agent's OWN key; it stops working immediately and is irreversible, so pass confirm:true). The relay derives identity from the caller's token, so every action acts only on the caller's own agent, and mint can never target another agent's id.",
    inputSchema: keyShape,
    // Consolidated tool: read action (list) + a mutating one (revoke
    // self-destructs the agent's own key). Hint reflects the destructive
    // action.
    annotations: {
      title: "Manage API Key",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "list":
            return jsonResult(await client.listKeys());
          case "mint":
            // Mints a sibling key for the CALLER's own identity (the relay
            // derives it from the bearer token, and no target field exists, so it
            // can never target another agent). The raw key is in this response
            // ONCE and never again.
            return jsonResult(await client.mintKey());
          case "revoke": {
            if (args["confirm"] !== true) {
              return invalidArgs(
                "revoke is irreversible and stops your key working immediately — pass confirm:true",
              );
            }
            const id = (await client.listKeys()).agent_id;
            await client.revokeKey(id);
            return jsonResult({ revoked: true, agent_id: id });
          }
          default:
            return invalidArgs(`unknown key action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "feedback",
    description:
      "Send or list feedback to the relay operator. ONE tool with an `action` enum: create (a bug|feature|note with a message, optional app_id) | list (the agent's own submissions, newest first, paginated by before).",
    inputSchema: feedbackShape,
    // Consolidated tool: read action (list) + a side-effecting one (create
    // submits feedback to the relay operator). Hint reflects the write action.
    annotations: {
      title: "Manage Feedback",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "create": {
            if (
              str(args, "type") === undefined ||
              str(args, "message") === undefined
            )
              return invalidArgs("create requires `type` and `message`");
            return jsonResult(
              await client.submitFeedback({
                type: args["type"] as "bug" | "feature" | "note",
                message: String(args["message"]),
                ...(str(args, "app_id") !== undefined
                  ? { appId: String(args["app_id"]) }
                  : {}),
              }),
            );
          }
          case "list": {
            const opts: { limit?: number; before?: string } = {};
            if (args["limit"] !== undefined)
              opts.limit = args["limit"] as number;
            if (str(args, "before") !== undefined)
              opts.before = String(args["before"]);
            return jsonResult(await client.listFeedback(opts));
          }
          default:
            return invalidArgs(`unknown feedback action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "agent",
    description:
      "Agent identity + binding. ONE tool with an `action` enum: whoami (the resolved relay URL, active profile, whether a key is configured — no network, no secrets) | claim (bind this agent to a human via a one-shot claim code from their Settings UI; one-way) | logout (clear the locally-saved key/profile; does NOT revoke it on the relay — use the `key` tool's revoke for that).",
    inputSchema: agentShape,
    // Consolidated tool: read action (whoami) + mutating ones (claim binds
    // this agent to a human, logout clears the local profile). Hint reflects
    // the state-changing action.
    annotations: {
      title: "Manage Agent Identity",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args, env) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "whoami":
            // No network — pure local config introspection. The relay's HTTP
            // server injects describeConfig (active token's agent identity);
            // the stdio server reads the CLI config store.
            return jsonResult((env?.describeConfig ?? describeActiveConfig)());
          case "claim":
            if (str(args, "code") === undefined)
              return invalidArgs("claim requires `code`");
            return jsonResult(await client.claimAgent(String(args["code"])));
          case "logout":
            return jsonResult((env?.clearProfile ?? clearActiveProfile)());
          default:
            return invalidArgs(`unknown agent action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "community",
    description:
      "Publish an app you own as a COMMUNITY TEMPLATE, and (relay operators only) review submissions. ONE tool with an `action` enum: publish | list_pending | get_submission | approve | reject. publish captures your live app (html + manifest + the seed rows of its seedOnInstall collections + listing metadata) into a PENDING template - installable by the returned direct link but NOT listed in the public gallery until an operator approves it; you must have a verified email and at most a few pending submissions at once. PRIVACY: an approved template's content AND its captured seed rows become PUBLIC to every platform user, so never publish an app whose seedOnInstall collections hold real personal data - seed data must be example-only. Pass attest_example_only:true to attest you checked this. Optionally give the template a per-publisher `slug` (namespaced id <your-handle>/<slug>) and a semver `version` (default 1.0.0): a republish under the same slug must bump the version. The review actions are limited to the relay's configured community reviewers: list_pending (the queue), get_submission (a submission's full content by snapshot_id), approve (list it in the gallery; a re-publish supersedes your app's prior approved version), reject (with a required note that lands in the publisher's app feed).",
    inputSchema: communityShape,
    // Consolidated tool: read actions (list_pending/get_submission) + mutating
    // ones (publish/approve/reject). Hint reflects the most-privileged action.
    annotations: {
      title: "Community Templates",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "publish": {
            if (str(args, "app_id") === undefined) {
              return invalidArgs("publish requires `app_id`");
            }
            return jsonResult(
              await client.publishCommunityTemplate({
                appId: String(args["app_id"]),
                title: str(args, "title"),
                description: str(args, "description"),
                longDescription: str(args, "long_description"),
                category: str(args, "category"),
                tags: Array.isArray(args["tags"])
                  ? (args["tags"] as string[])
                  : undefined,
                slug: str(args, "slug"),
                version: str(args, "version"),
                changelogNote: str(args, "changelog_note"),
                setupSteps: Array.isArray(args["setup_steps"])
                  ? (args["setup_steps"] as CommunitySetupStep[])
                  : undefined,
                derivedFromSnapshotId: str(args, "derived_from_snapshot_id"),
                attestExampleOnly: bool(args, "attest_example_only"),
              }),
            );
          }
          case "list_pending": {
            const opts: { limit?: number; cursor?: string } = {};
            if (args["limit"] !== undefined)
              opts.limit = args["limit"] as number;
            if (str(args, "cursor") !== undefined)
              opts.cursor = String(args["cursor"]);
            return jsonResult(await client.listCommunitySubmissions(opts));
          }
          case "get_submission":
            if (str(args, "snapshot_id") === undefined) {
              return invalidArgs("get_submission requires `snapshot_id`");
            }
            return jsonResult(
              await client.getCommunitySubmission(String(args["snapshot_id"])),
            );
          case "approve":
            if (str(args, "snapshot_id") === undefined) {
              return invalidArgs("approve requires `snapshot_id`");
            }
            return jsonResult(
              await client.reviewCommunitySubmission(
                String(args["snapshot_id"]),
                { decision: "approve" },
              ),
            );
          case "reject": {
            if (str(args, "snapshot_id") === undefined) {
              return invalidArgs("reject requires `snapshot_id`");
            }
            const note = str(args, "note");
            if (note === undefined) {
              return invalidArgs("reject requires a non-empty `note`");
            }
            return jsonResult(
              await client.reviewCommunitySubmission(
                String(args["snapshot_id"]),
                { decision: "reject", note },
              ),
            );
          }
          case "set_trust_level": {
            const handle = str(args, "handle");
            if (handle === undefined) {
              return invalidArgs("set_trust_level requires `handle`");
            }
            const trustLevel = str(args, "trust_level");
            if (trustLevel !== "new" && trustLevel !== "established") {
              return invalidArgs(
                "set_trust_level requires `trust_level` of 'new' or 'established'",
              );
            }
            return jsonResult(
              await client.setPublisherTrustLevel(handle, trustLevel),
            );
          }
          default:
            return invalidArgs(`unknown community action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "publisher",
    description:
      "Manage YOUR community publisher identity: the @-handle and public profile you present in the template gallery. ONE tool with an `action` enum: claim | get | update. get returns your profile (handle, whether it is claimed yet, tenure, and the rating/template counters). claim sets your handle exactly ONCE (it is permanent afterwards) from a lowercase 3-to-32-char string; a handle that is reserved (platform or role words) or already taken is refused. update changes your public display_name, bio, or url at any time. claim and update require a verified email; an existing publisher may already have a provisional `maker-...` handle (auto-assigned) that claim renames the one allowed time.",
    inputSchema: publisherShape,
    // Consolidated tool: a read action (get) plus mutating ones (claim/update).
    // claim is irreversible (the handle is permanent), so the hint reflects the
    // most-privileged action.
    annotations: {
      title: "Publisher Profile",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "get":
            return jsonResult(await client.getPublisher());
          case "claim": {
            const handle = str(args, "handle");
            if (handle === undefined) {
              return invalidArgs("claim requires `handle`");
            }
            return jsonResult(await client.claimPublisherHandle(handle));
          }
          case "update": {
            const update: {
              displayName?: string | null;
              bio?: string | null;
              url?: string | null;
            } = {};
            if ("display_name" in args)
              update.displayName = args["display_name"] as string | null;
            if ("bio" in args) update.bio = args["bio"] as string | null;
            if ("url" in args) update.url = args["url"] as string | null;
            if (Object.keys(update).length === 0) {
              return invalidArgs(
                "update requires at least one of `display_name`, `bio`, `url`",
              );
            }
            return jsonResult(await client.updatePublisher(update));
          }
          default:
            return invalidArgs(`unknown publisher action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "review",
    description:
      "Rate and review community templates you have USED, respond to reviews of your own templates, and (relay operators only) moderate. ONE tool with an `action` enum: create | respond | report | remove | unhold. create leaves a 1-to-5 star rating plus an optional written body on a template you have installed - identify the template by `template` (\"<handle>/<slug>\") or by `handle`+`slug`; you need a verified email, and each install yields exactly one review (the aggregate carries across template versions). A body that contains a link or a contact email is AUTO-HELD for a moderator before it appears. respond replies to a review of YOUR OWN template line (review_id + response; null clears it), one editable response per review. report flags a review for the relay's moderators (review_id + reason), deduped per account. remove and unhold are limited to the relay's configured community reviewers: remove takes a review down and adjusts the rating aggregate; unhold publishes a previously auto-held review into the aggregate.",
    inputSchema: reviewShape,
    // Consolidated tool: a write action (create), publisher/reporter actions,
    // and operator moderation (remove/unhold). Hint reflects remove, the most
    // privileged / destructive action.
    annotations: {
      title: "Community Reviews",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    handler: async (client, args) => {
      const action = String(args["action"]);
      try {
        switch (action) {
          case "create": {
            if (args["stars"] === undefined) {
              return invalidArgs("create requires `stars`");
            }
            const template = str(args, "template");
            const handle = str(args, "handle");
            const slug = str(args, "slug");
            if (
              template === undefined &&
              (handle === undefined || slug === undefined)
            ) {
              return invalidArgs(
                'create requires `template` ("<handle>/<slug>") or both `handle` and `slug`',
              );
            }
            return jsonResult(
              await client.createReview({
                template,
                handle,
                slug,
                stars: args["stars"] as number,
                body: str(args, "body"),
              }),
            );
          }
          case "respond": {
            const reviewId = str(args, "review_id");
            if (reviewId === undefined) {
              return invalidArgs("respond requires `review_id`");
            }
            const response =
              "response" in args ? (args["response"] as string | null) : null;
            return jsonResult(await client.respondToReview(reviewId, response));
          }
          case "report": {
            const reviewId = str(args, "review_id");
            if (reviewId === undefined) {
              return invalidArgs("report requires `review_id`");
            }
            const reason = str(args, "reason");
            if (reason === undefined) {
              return invalidArgs("report requires `reason`");
            }
            return jsonResult(await client.reportReview(reviewId, reason));
          }
          case "remove": {
            const reviewId = str(args, "review_id");
            if (reviewId === undefined) {
              return invalidArgs("remove requires `review_id`");
            }
            return jsonResult(await client.removeReview(reviewId));
          }
          case "unhold": {
            const reviewId = str(args, "review_id");
            if (reviewId === undefined) {
              return invalidArgs("unhold requires `review_id`");
            }
            return jsonResult(await client.unholdReview(reviewId));
          }
          default:
            return invalidArgs(`unknown review action '${action}'`);
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "get_skill",
    description:
      "Fetch the relay's auto-updating SKILL.md (the full Homespun usage guide) — UNAUTHENTICATED, needs no API key. Call this to self-teach the Homespun workflow (events vs records, schema grammars, the poll loop) before driving the other tools. Pass version_only:true to get just the relay's skill version string (to check if a cached copy is stale).",
    inputSchema: getSkillShape,
    annotations: {
      title: "Get Skill Guide",
      readOnlyHint: true,
      openWorldHint: false,
    },
    handler: async (_client, args, env) => {
      try {
        const versionOnly = args["version_only"] === true;
        // The relay's HTTP server injects getSkill so MCP consumers receive
        // the MCP-invocation rendering of the skill (tool-call grammar, not
        // `homespun ...` commands) straight from the relay image. The stdio server
        // falls back to fetching SKILL.md over HTTP from its configured relay.
        if (env?.getSkill) {
          const { markdown, version } = await env.getSkill(versionOnly);
          if (versionOnly) return jsonResult({ version });
          return textResult(markdown ?? "");
        }
        const url = resolveUrl();
        if (versionOnly) {
          const { version } = await fetchSkill(url, { version: true });
          return jsonResult({ version });
        }
        const { markdown } = await fetchSkill(url);
        return textResult(markdown ?? "");
      } catch (e) {
        return errorResult(e);
      }
    },
  },
];
