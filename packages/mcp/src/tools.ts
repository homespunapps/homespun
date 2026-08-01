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
 * Where errorResult()/invalidArgs() stash the STRUCTURED error code they
 * already computed, so a host can report it without re-parsing the serialized
 * JSON text back out of `content[0].text` (issue #1287).
 *
 * A Symbol, set non-enumerable, on purpose: it is invisible to
 * JSON.stringify, to `{...result}`, to Object.keys, and to the MCP SDK's Zod
 * passthrough copy — so tagging cannot change a single byte on the wire. Only
 * runTool() below (and toolErrorCode(), for tests) ever reads it.
 *
 * Tagging the returned OBJECT rather than threading `env` through all 100-odd
 * errorResult()/invalidArgs() call sites keeps this a ~10-line change, and it
 * attributes the code to the result actually returned rather than to whatever
 * an async scope happened to see last.
 */
const TOOL_ERROR_CODE = Symbol("homespun.toolErrorCode");

/** Tag a result with its structured error code and return it unchanged. */
function tagErrorCode(result: ToolResult, code: string): ToolResult {
  Object.defineProperty(result, TOOL_ERROR_CODE, {
    value: code,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return result;
}

/**
 * Read the structured error code off a ToolResult produced by
 * errorResult()/invalidArgs(). Undefined for a success, and for an `isError`
 * result built by hand somewhere else.
 */
export function toolErrorCode(result: ToolResult): string | undefined {
  const code = (result as unknown as Record<symbol, unknown>)[TOOL_ERROR_CODE];
  return typeof code === "string" ? code : undefined;
}

/** Outcome of one tool invocation, as reported to {@link ToolEnv.onToolResult}. */
export interface ToolCallReport {
  /** Registered tool name (a bounded set — safe as a metric label). */
  tool: string;
  /**
   * `ok`        — handler returned without `isError`.
   * `error`     — handler returned a structured `isError` result.
   * `exception` — handler THREW. Always a bug: every handler is meant to
   *               catch and return errorResult().
   */
  outcome: "ok" | "error" | "exception";
  /**
   * Structured code for a failure: the relay's ApiError code for a
   * HomespunApiError, "invalid_args" for a rejected argument, "internal" for a
   * bare throw. Undefined on success, and on an `isError` result that carries
   * no tag.
   */
  errorCode?: string;
  /** Wall-clock milliseconds the handler took. */
  ms: number;
}

/**
 * Invoke a tool handler and report its outcome to `env.onToolResult`.
 *
 * The seam that makes remote MCP calls observable (issue #1287): a tool
 * failure is an `isError` result inside an HTTP 200, so a host that just
 * awaits `tool.handler(...)` cannot tell a failed deploy_app from a successful
 * one. This times the call, catches a throw, and reads the structured error
 * code off the returned result.
 *
 * Transport-agnostic by construction: `onToolResult` is optional, so the stdio
 * CLI server can keep calling `tool.handler` directly (or adopt this and opt
 * in later) with no behaviour change. The handler's result — or its thrown
 * error — is passed through untouched.
 */
export async function runTool(
  tool: ToolDef,
  client: HomespunClient,
  args: Record<string, unknown>,
  env?: ToolEnv,
): Promise<ToolResult> {
  const started = Date.now();
  let result: ToolResult;
  try {
    result = await tool.handler(client, args, env);
  } catch (e) {
    report(env, {
      tool: tool.name,
      outcome: "exception",
      errorCode: "internal",
      ms: Date.now() - started,
    });
    throw e;
  }
  report(env, {
    tool: tool.name,
    outcome: result.isError === true ? "error" : "ok",
    errorCode: result.isError === true ? toolErrorCode(result) : undefined,
    ms: Date.now() - started,
  });
  return result;
}

/** Fire the reporting callback; telemetry must never break a tool call. */
function report(env: ToolEnv | undefined, r: ToolCallReport): void {
  if (!env?.onToolResult) return;
  try {
    env.onToolResult(r);
  } catch {
    // Swallow: a broken observability hook must not fail the tool.
  }
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
  /**
   * Optional per-call observability hook, fired by {@link runTool} once the
   * handler settles (issue #1287). The hosted relay uses it to log the tool
   * name, outcome and structured error code, and to tick its
   * homespun_mcp_tool_calls_total counter — none of which is recoverable from
   * the HTTP 200 the transport returns for a failed call.
   *
   * NEVER hand this the arguments or the result body: they carry user app
   * content. The report is deliberately just (tool, outcome, code, duration).
   */
  onToolResult?: (report: ToolCallReport) => void;
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
    return tagErrorCode(
      {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        isError: true,
      },
      e.code,
    );
  }
  const message = e instanceof Error ? e.message : String(e);
  return tagErrorCode(
    {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "internal", message }, null, 2),
        },
      ],
      isError: true,
    },
    "internal",
  );
}

/**
 * Structured invalid_args error for the per-action validation inside
 * consolidated tools. Mirrors the relay's envelope so the model self-corrects.
 */
function invalidArgs(message: string): ToolResult {
  return tagErrorCode(
    {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: "invalid_args", message }, null, 2),
        },
      ],
      isError: true,
    },
    "invalid_args",
  );
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
      "The app's UI as a complete HTML document (single file, up to the relay's size cap), sent inline. Provide either this or `html_path`. Inline is required for a hosted or remote connector that has no filesystem. If both are given, inline `html` wins. ON REDEPLOY, omit it entirely to keep the live document: a manifest-only change (adding a collection, widening externalHosts) then costs nothing in HTML.",
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
      "Validate only: run the full manifest + asset-shape validation, the compat gate (for a redeploy), and the schedule-timezone advisory, then return { ok, warnings, compat?, breaks? } WITHOUT creating a version or mutating anything. An invalid manifest returns the SAME error a real deploy would; a redeploy the compat gate would refuse reports the break instead of applying it. `check` is an accepted alias.",
    ),
  check: z.boolean().optional().describe("Alias for `dry_run`."),
  // Optional at the SCHEMA level because a redeploy inherits an omitted
  // manifest (#1272); the handler still refuses a create without one.
  //
  // `z.preprocess` rather than `.nullish()` on purpose. MCP clients routinely
  // send `manifest: null` instead of dropping the key, and the SDK validates
  // arguments against this shape before the handler ever runs, so null has to
  // be acceptable here. But `.nullish()` emits `anyOf:[{type:"object"},
  // {type:"null"}]`, which loses the plain top-level `type: "object"` that
  // stops a harness from stringifying the manifest (the reported bug the
  // advertised-schema test guards). Preprocessing keeps the emitted schema
  // exactly `type: "object"` AND turns a null into an omission.
  manifest: z
    .preprocess(
      (v) => (v === null ? undefined : v),
      jsonObjectSchema.optional(),
    )
    .describe(
      "The x-homespun-manifest capability document (a JSON object). REQUIRED to create; ON REDEPLOY, omit it to keep the live manifest, which is what most redeploys want (the manifest was byte-identical to the previous version in 71% of real redeploys). Eight extension keys: app metadata; collections (+ per-collection write/update/read/delete role lists, where write gates creates and also updates unless the optional update list is declared); externalHosts (fetch allowlist); cdn (allow CDN scripts/styles); capabilities (Permissions-Policy opt-ins); embeds (iframe frame-src allowlist); notify (email-on-row rules); webhooks (signed HTTP POST on-row rules). Call get_skill for the full grammar before authoring one from scratch.",
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
      "REDEPLOY only. Bypass the compat gate, whether it fired on a stranded-rows narrowing or on a widening of what the install screen discloses (a removed collection is detached, never deleted).",
    ),
  assets: z
    .array(
      z.union([
        z.object({
          path: z
            .string()
            .describe(
              "App-relative, same-origin reference the HTML uses, for example 'frames/000.jpg' or 'media/intro.mp4'. Must be relative: no leading '/', no '..' segment, no backslash, charset [A-Za-z0-9._/-], and not under a reserved prefix (_hs, b).",
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
        z.object({
          path: z
            .string()
            .describe(
              "App-relative, same-origin reference the HTML uses (same rules as the inline form).",
            ),
          attachment_id: z
            .string()
            .describe(
              "Id of an ALREADY-uploaded attachment to bind at this path, instead of carrying base64. Use with `attachments fetch` (URL, zero model-context cost) or presign + finalize: the attachment must be owned by YOU, app-scoped to THIS app (upload it with scope=app, app_id=this app), and ready. Skips decode/upload; the deploy just maps path -> attachment_id.",
            ),
        }),
      ]),
    )
    .optional()
    .describe(
      'Optional bundle of files shipped WITH the app in ONE deploy: images, fonts, audio/video, data. Each asset either carries its bytes inline as `content_base64` OR references an already-uploaded attachment by `attachment_id` (prefer the reference form for real images/media: upload once via `attachments fetch` or presign, then bind it here with NO base64 in the deploy body). Each asset is validated + stored app-scoped exactly like a normal attachment (byte-sniff, allowlist, size cap, quota, scan) and served at its `path` on the app\'s OWN origin, so the page references it by a stable same-origin path (`<img src="frames/000.jpg">`, `<video src="media/intro.mp4">`; media/font paths support HTTP Range). The whole deploy is rejected atomically if any asset fails validation. ON REDEPLOY, assets you send REPLACE the previous version\'s set, omitting `assets` keeps the live set (no re-upload, no re-encoding), and `assets: []` is the explicit way to clear it. Bounded by the relay\'s per-deploy asset-count cap; total bytes by the per-app blob quota.',
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
      "Optional stable key. Reusing an existing key returns the existing row (deduped:true), or row_not_found when the collection's read list does not reach that row for you.",
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

const restoreRowShape = {
  app_id: z.string().min(1).describe("The app id."),
  collection: z.string().min(1).describe("The collection name."),
  key: z.string().min(1).describe("The key of the deleted row to restore."),
};

const listDeletedRowsShape = {
  app_id: z.string().min(1).describe("The app id."),
  collection: z.string().min(1).describe("The collection name."),
  limit: z
    .number()
    .int()
    .optional()
    .describe("Max rows to return (default 100)."),
  before: z
    .string()
    .optional()
    .describe(
      "Cursor for the next page: pass back the previous page's next_before.",
    ),
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
      "list: YOUR owning human's apps. show/update/delete/wake: act on one app (app_id). share_link_rotate: rotate a 'link' app's share token, returning a new share_url (the old link stops working); also generates one if the app has none yet. domain_set/domain_status/domain_remove: manage the app's custom domains (app_id; domain_set also needs domain).",
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
      "domain_set: the bare custom domain to bind (e.g. app.example.com); the response's dns_records lists the DNS entries the domain owner must publish. domain_remove: OPTIONAL, the one domain to unbind - omit it to unbind them all.",
    ),
};

const membersShape = {
  action: z
    .enum(["add", "list", "set_role", "remove", "roles"])
    .describe(
      "add: invite-or-attach a member by email (app_id+email; optional custom_roles). list: the app's owner + members (app_id). set_role: replace an existing member's declared roles in place without signing them out (app_id+human_id+custom_roles, an empty list to clear). remove: drop a member (app_id+human_id). roles: the app's declared roles with what each one includes and, per collection, the EFFECTIVE access a holder has (separately for members and grant-link holders, whose role floors differ) plus how many members and live grant links hold each role (app_id).",
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
  custom_roles: z
    .array(z.string())
    .optional()
    .describe(
      "add (optional) and set_role (required). The DECLARED roles (x-homespun-manifest.roles keys) attached to the member ALONGSIDE their base member powers. A member may hold several and holds the union of what each grants, plus everything those roles `includes`. A built-in/reserved role or an undeclared role is rejected. Omit on add for an ordinary member; pass [] on set_role to clear the roles back to a plain member.",
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
    .enum(["list", "rotate", "set_signing_secret", "clear_signing_secret"])
    .describe(
      "list: the app's inbound catch-hooks, each with its full secret URL, current rule (collection/mode/wake/handshake), and per-status delivery counts (app_id). rotate: mint a fresh URL secret for one hook and return its new URL once, invalidating the old URL immediately (app_id+name). set_signing_secret: provision or rotate a hook's OPT-IN signing secret, distinct from the URL secret (it is what a provider HMACs the body with); omit `secret` to mint one (returned ONCE) or pass `secret` to store a provider-generated value verbatim (never echoed) (app_id+name). clear_signing_secret: remove a hook's signing secret (app_id+name).",
    ),
  app_id: z.string().min(1).describe("The app id."),
  name: z
    .string()
    .optional()
    .describe(
      "rotate / set_signing_secret / clear_signing_secret. The manifest ingest hook name (an x-homespun-manifest.ingest[].name). See list's `name` field.",
    ),
  secret: z
    .string()
    .optional()
    .describe(
      "set_signing_secret only. A provider-generated signing secret to store verbatim (the Stripe path). Omit to have the relay mint one (the GitHub path), returned ONCE in the response.",
    ),
  grace_seconds: z
    .number()
    .optional()
    .describe(
      "set_signing_secret only. On a rotation, how long the previous secret stays valid so deliveries verify while you update the provider (default 3600, max 86400).",
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
      "fetch",
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
      "Binary attachment operations. The upload path affects token cost: `fetch` and presign plus finalize keep the bytes out of the model context entirely, while upload with `content_base64` carries them in the tool-call arguments at a cost proportional to file size, paid again on every retry. fetch takes { source_url, scope } and the relay downloads the bytes itself (https only, SSRF-guarded), running the same sniff, allowlist, size, quota and scan checks as any upload. upload takes `content_base64` (base64 bytes, no filesystem) or `file_path` (absolute, read on the relay host), scoped agent or app. presign plus finalize is three steps: presign with { mime, size, sha256, scope }, PUT the bytes to put_url out of band, then finalize, which re-sniffs and re-checks them. download fetches bytes by attachment_id to an absolute out_path or returns base64. show returns metadata only. list returns the agent's attachments. delete is a soft-delete. mint_token mints a /b/<token> capability URL, returned once. revoke_token and list_tokens manage those tokens.",
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
  source_url: z
    .string()
    .optional()
    .describe(
      "fetch: an https URL the relay downloads server-side, so the bytes do not enter the model context and cost no tokens. SSRF-guarded: https only, no private, loopback, link-local or metadata hosts, DNS pinned, redirects refused, size-capped and timed out. The downloaded bytes run the same byte-sniff, allowlist, size, quota and scan checks as any upload. This and presign plus finalize are the zero-context paths for real images and media.",
    ),
  content_base64: z
    .string()
    .optional()
    .describe(
      "upload: the file bytes as base64, sent inline with no filesystem access. The base64 rides in the tool-call arguments and enters the model context, costing tokens proportional to file size; a few-hundred-KB image is already expensive, and the cost repeats on every retry. presign plus finalize avoids that for any real image or media whenever the client can do an out-of-band HTTP PUT, which leaves `content_base64` suited to small assets such as a tiny icon, and to clients that cannot PUT out of band. If both `content_base64` and `file_path` are given, `content_base64` wins. The relay sniffs the real type and enforces the same size, allowlist and quota checks as a file upload.",
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
      "unpublish",
      "get_config_contract",
      "install",
      "list_pending",
      "get_submission",
      "approve",
      "reject",
      "set_trust_level",
    ])
    .describe(
      "publish: publish one of YOUR apps as a community template (app_id; optional title/description/category/tags). PRIVACY: publishing makes the template content AND the captured seed rows (the LIVE rows of every seedOnInstall collection, captured at publish time) PUBLIC to every platform user once approved. Do NOT publish an app whose seedOnInstall collections hold real personal data (names, emails, addresses, messages, anything private): seed data must be example-only. Pass attest_example_only:true to attest you have checked this. The capture (html + manifest + seed rows) lands PENDING review, installable by its returned direct link but not listed until approved; an ESTABLISHED publisher is fast-tracked (the response's expedited/auto_approved tell you which). unpublish: take one of YOUR OWN published templates back down (snapshot_id). It removes the listing from the public gallery, from search, and from the direct snapshot install link. Existing installs keep working untouched, because an install is a fresh private copy rather than a live reference. It is idempotent (unpublishing an already-unpublished template is a no-op), and a snapshot that does not exist OR is not yours reads as not found either way. Publish a new version to put the listing back. get_config_contract: read a template's install-time config contract by `ref` (a namespaced '<handle>/<slug>' or a snapshot id): its settings_collection, ordered config_steps (each with key/kind/required/secret/choices/default), and connect_steps (inbound hooks the app receives on). An 'upload' step wants a file; pre-upload it with the attachments tool (scope agent) and pass its attachment id. After installing a template with connect_steps, run the `ingest` tool's list action on the new app_id to read its freshly provisioned hook URLs, and wire each into the external service. install: install a template by `ref` for YOU (your owning human becomes the owner). Pass `config` as { stepKey: value } from the contract: a 'config' step's value is a string, an 'upload' step's value is a pre-uploaded attachment id. A required step you omit is rejected. Returns the new app's id, slug, and url; installs always create a fresh private copy. list_pending / get_submission / approve / reject / set_trust_level are RELAY-OPERATOR-only review actions: list_pending (the review queue, expedited submissions first), get_submission (a submission's full html+manifest+seedRows plus external_destinations, the hosts it can send data to or pull data from, by snapshot_id), approve (snapshot_id, lists it in the gallery + supersedes the app's prior approved version), reject (snapshot_id + a required note that lands in the publisher's app feed), set_trust_level (promote/demote a publisher by handle: handle + trust_level 'new'|'established').",
    ),
  ref: z
    .string()
    .optional()
    .describe(
      "get_config_contract/install only. The template to read or install: a namespaced '<handle>/<slug>' or a community snapshot id.",
    ),
  config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "install only. The install-time answers as { stepKey: value } from the config contract: a 'config' step's value is a string, an 'upload' step's value is a pre-uploaded attachment id. Omit for a template with no config steps.",
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
          .enum(["config", "seed-data", "connect", "note", "upload"])
          .describe(
            "config = set a value; upload = an install-time file/image the app stores as an attachment id; connect = wire up an external data source; seed-data = review/replace captured starter data; note = a plain instruction.",
          ),
        label: z.string().describe("Short step label (<= 80 chars)."),
        key: z
          .string()
          .optional()
          .describe(
            "The settings-collection field this answer is written into (letters, digits, '_', up to 64 chars). Required for an 'upload' step, optional for a 'config' step, not allowed on the others. Must name a declared top-level field of the manifest's x-homespun-manifest.settingsCollection; an 'upload' target must be a string-typed field.",
          ),
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
        ingestRule: z
          .string()
          .optional()
          .describe(
            "The manifest `ingest` rule this step wires up. Allowed only on a 'connect' step, and optional there; publish rejects a name that x-homespun-manifest.ingest does not declare. Each install mints that rule its own hook URL, which the installer pastes into the external service.",
          ),
      }),
    )
    .optional()
    .describe(
      "publish only. Ordered typed setup steps an installing agent follows after install (up to 20). A 'config'/'upload' step may carry a `key` naming a field of the manifest's settingsCollection that its install-time answer is written into; a 'connect' step may carry an `ingestRule` naming a manifest ingest rule it wires up. Read back via get_submission and rendered on the template detail page.",
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
      "Required for get_submission/unpublish/approve/reject. The submission's snapshot id (from publish's response or list_pending).",
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
      "Deploy a v2 app: an HTML document plus a capability manifest, hosted at its own URL.\n\nON REDEPLOY, SEND ONLY WHAT CHANGES. Every content field is optional when `app_id` is given, and an omitted one keeps what is live: omit `manifest` for an HTML-only change, omit `html` for a manifest-only change, omit `assets` to keep the current files. This is the cheap path and it is the one to reach for by default, because the omitted field costs no output tokens at all: a one-line colour change should not resend the whole document, and a manifest edit should not resend it either. Send a field only when its content is different from what is live. `assets: []` is the explicit way to clear the asset set, and omitting all three is refused, since there would be nothing to change.\n\nThe manifest carries eight extension keys: app metadata; collections, with per-collection write, update, read and delete role lists, where write gates creates and also gates updates unless an update list is declared; externalHosts, a fetch allowlist; cdn, to allow CDN scripts and styles; capabilities, for Permissions-Policy opt-ins; embeds, an iframe frame-src allowlist; notify, for email-on-row rules; and webhooks, for signed HTTP POST on-row rules. The manifest grammar is documented in the Homespun guide that get_skill returns.\n\nPass no `app_id` to create, which mints a slug and URL and requires both `html` and `manifest`, or pass `app_id` to redeploy an existing app. Supply the HTML inline as `html`, or as `html_path`, an absolute path read on the MCP-server host, which is the relay for a hosted connector or the CLI host for a locally-run one, and not the remote agent's machine; it avoids retransmitting a large HTML file on every deploy, only a locally-run connector can read it, and inline `html` wins if both are given. `dry_run:true` (alias `check`) validates only: it runs the full manifest and asset validation, the redeploy compat gate and the schedule-timezone advisory, then returns { ok, warnings, compat?, breaks? } without creating a version or mutating anything, and it resolves omitted fields the same way a real deploy would, so it reports on exactly the deploy that would run.\n\nA redeploy is refused with manifest_incompatible_redeploy, unless force:true, when it would strand rows already written (dropping a collection, tightening a schema, flipping appendOnly), or when it would widen what the app's install screen discloses: a collection's read reaching further than the live manifest, a capability added, cdn turned on, or a host added to externalHosts, embeds or a webhook target. The break quotes the sentence a user would now be asked to approve. Taking access away never prompts: dropping a role, dropping a capability, host or webhook, turning cdn off, or adding update:[\\\"creator\\\"] to a write:[\\\"anyone\\\"] collection, all redeploy clean. A removed collection is detached rather than deleted.\n\nImages, fonts, audio, video and data files ship with the app in the same call via `assets[]`. Each is validated and stored app-scoped and served at its `path` on the app's own origin, so the HTML references it by a stable same-origin path such as `<img src=\\\"frames/000.jpg\\\">`; media and font paths support HTTP Range for seeking. A redeploy's assets replace the previous version's set when sent, carry over when omitted, and are cleared by `assets: []`.\n\nReturns { app_id, slug, url, version, visibility, created } on create, or { app_id, version, compat, breaks? } on redeploy.",
    inputSchema: deployAppShape,
    annotations: {
      title: "Deploy App",
      readOnlyHint: false,
      // Additive: publishes a NEW version. The slug is immutable and prior
      // versions are retained, so a deploy removes nothing.
      destructiveHint: false,
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
        // `manifest: null` is how several MCP clients express "not sending
        // this" rather than dropping the key, so it means the same as omitted
        // here (the relay's resolver applies the same rule).
        const manifestValue =
          manifest.value === null ? undefined : manifest.value;

        if (appId === undefined) {
          if (html === undefined) {
            return invalidArgs("create requires `html` or `html_path`");
          }
          if (manifestValue === undefined) {
            return invalidArgs(
              "create requires `manifest` (there is nothing to inherit on a first deploy; inherit-on-omit applies to a redeploy, which passes `app_id`)",
            );
          }
          if (dryRun) {
            return jsonResult(
              await client.checkDeploy({
                html,
                manifest: manifestValue,
                assets,
              }),
            );
          }
          const slug = str(args, "slug");
          const visibility = args["visibility"] as
            "private" | "link" | "public" | undefined;
          if (slug !== undefined && visibility === "link") {
            return invalidArgs(
              "a `slug` is not allowed with visibility 'link' (link slugs are server-generated); drop visibility 'link', or omit slug",
            );
          }
          return jsonResult(
            await client.deployApp({
              html,
              manifest: manifestValue,
              visibility,
              slug,
              assets,
            }),
          );
        }
        // REDEPLOY. Nothing is required individually: an omitted html,
        // manifest or assets keeps what is live (issue #1272). Only the empty
        // body is refused, and locally, so the caller gets the reason rather
        // than a round trip that says the same thing.
        if (html === undefined && manifestValue === undefined && !assets) {
          return invalidArgs(
            "a redeploy must change something: send `html`, `manifest` or `assets` (an omitted field keeps what is live; `assets: []` clears the asset set)",
          );
        }
        if (dryRun) {
          return jsonResult(
            await client.checkDeploy({
              app_id: appId,
              html,
              manifest: manifestValue,
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
          manifest: manifestValue,
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
      "List rows in a v2 app's mutable collection. This is also how a collection's current state is polled, since MCP has no streaming: pass the prior next_cursor as `since` to fetch only rows that are new or changed. Returns { rows, next_cursor, has_more }.",
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
      "Fetch a single row by its key from a v2 app collection, through a dedicated relay route rather than a client-side scan. Returns { row }, or an isError row_not_found.",
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
      "Create a row in a v2 app's collection, or return the existing row when `key` is already present (deduped:true). Row creation goes through this tool; there is no separate strict-create verb. Omit `key` to add a new row with a server-generated key, or pass `key` to ensure a row exists at that key. The collection must be declared in the app's manifest with 'agent' in its `write` list, which is the list that gates creates. When `key` matches a row the collection's `read` list does not reach for this caller, the result is row_not_found rather than the row, matching what get_row would return, so this never reads past `read`. Returns { row, deduped? }.",
    inputSchema: upsertRowShape,
    annotations: {
      title: "Upsert Row",
      readOnlyHint: false,
      // Create-or-return-existing. Removes nothing.
      destructiveHint: false,
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
      "Update an existing row in a v2 app's collection, replacing its data. Gated by the collection's `update` role list when it declares one, and by its `write` list otherwise, so a collection that scopes updates to the row's `creator` refuses an edit on someone else's row. Pass if_match with the row's current version for an optimistic-locked update; on a version mismatch the relay returns the current row, which is what a retry needs. Returns { row }.",
    inputSchema: updateRowShape,
    annotations: {
      title: "Update Row",
      readOnlyHint: false,
      // Replaces a row's data in place. A replaceable write on a row the
      // caller names explicitly, not a removal: the row still exists, and
      // deletion is a separate tool (`delete_row`).
      destructiveHint: false,
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
      "Soft-delete a row from a v2 app's collection. RECOVERABLE: the row is tombstoned, not destroyed, and restore_row brings it back for 30 days (see list_deleted_rows). A watcher sees the deletion live as op:delete on the change feed. Pass if_match for an optimistic-locked delete. Returns { deleted: true }.",
    inputSchema: deleteRowShape,
    annotations: {
      title: "Delete Row",
      readOnlyHint: false,
      // Destructive: Removes the row (soft-delete, and watchers see op:delete).
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
    name: "list_deleted_rows",
    description:
      "List a collection's recently deleted rows: the recovery bin. Deleting a row is a SOFT delete, so it can be restored with restore_row until recoverable_until passes (30 days after deletion by default). Owner or agent only, and deliberately independent of the collection's read permissions. Rows already purged appear with purged:true and cannot be restored. Returns { rows, next_before }.",
    inputSchema: listDeletedRowsShape,
    annotations: {
      title: "List Deleted Rows",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        const opts: { limit?: number; before?: string } = {};
        if (args["limit"] !== undefined) opts.limit = args["limit"] as number;
        if (args["before"] !== undefined) opts.before = String(args["before"]);
        return jsonResult(
          await client.listDeletedAppRows(
            String(args["app_id"]),
            String(args["collection"]),
            opts,
          ),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  },
  {
    name: "restore_row",
    description:
      "Restore a soft-deleted row, undoing delete_row. The row comes back with its original data and creator, its version bumped. Find restorable keys with list_deleted_rows. Owner or agent only. Fails with restore_expired if the row was purged, or restore_conflict if another live row took a unique value this one held while it was deleted. Returns { row }.",
    inputSchema: restoreRowShape,
    annotations: {
      title: "Restore Row",
      readOnlyHint: false,
      // Brings a row BACK. It writes, but it only ever adds; nothing is
      // removed or overwritten, which is the opposite of destructive.
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    handler: async (client, args) => {
      try {
        return jsonResult(
          await client.restoreAppRow(
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
    name: "get_feed_events",
    description:
      "Poll a v2 app's change feed for what has happened: row creates, updates and deletes, from any writer, agent or human. It is the long-poll analogue of `homespun apps watch`, since MCP has no streaming. The loop is: call with no `since` first, process the returned entries, keep the cursor, then call again passing it as `since` to get only newer entries. Passing wait (around 25) holds the request open until an entry arrives or it times out, which is how the feed is waited on rather than busy-polled. A `since` older than the retention floor returns resync_required, and the collections are then re-listed with list_rows. Returns { entries, cursor, truncated }.",
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
      "The v2 app lifecycle apart from creation and redeploy, which deploy_app covers. Actions: list returns the owning human's apps; show returns full detail including manifest, timezone and has_share_token; update changes visibility and timezone, the slug being immutable, and switching to 'link' returns a share_url once; share_link_rotate issues a new share token for a 'link' app, returning a new share_url and revoking the old link, and generates one if the app has none; delete is an idempotent soft-delete; wake wakes a dormant app and is otherwise a no-op that reports the actual status; domain_set binds a custom domain and returns the DNS records the domain owner must publish, where the first domain bound serves the app and every later one redirects to it, which is how apex plus www is configured; domain_status returns the serving domain and its `aliases`, live-refreshed against Cloudflare when that is enabled, with last_error carrying the reason a domain is not activating; domain_remove unbinds one domain, or all of them when no `domain` is given, and is idempotent.",
    inputSchema: appsShape,
    // Consolidated tool: read actions (list/show) + mutating ones (update/
    // delete/wake). Hint reflects delete, the most-privileged action.
    annotations: {
      title: "Manage Apps",
      readOnlyHint: false,
      // Destructive: `delete` removes an app.
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
                        "private" | "link" | "public",
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
            await client.deleteAppDomain(
              String(args["app_id"]),
              str(args, "domain"),
            );
            return jsonResult({
              app_id: args["app_id"],
              domain_removed: str(args, "domain") ?? "all",
            });
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
      "A v2 app's membership (auth spec section 6): who besides the owner can sign in to a private app and write to member-scoped collections. Actions: add invites or attaches a member by email, attaching immediately when the email already has a Human and otherwise sending a magic-link invite; list returns the app's owner and members; set_role changes an existing member's declared custom role in place, or clears it when null, and leaves their sessions intact, which is what makes it the way to re-role someone rather than removing and re-adding them; remove is idempotent and also revokes the human's live sessions on this app, and the app owner cannot be removed; roles returns the derived roles summary, giving the effective access a holder actually has per declared role and collection, reported separately for signed-in members and for grant-link holders because their role floors differ, along with member and active-grant-link counts.",
    inputSchema: membersShape,
    // Consolidated tool: read action (list) + mutating ones (add/remove).
    // Hint reflects remove, the most-privileged action.
    annotations: {
      title: "Manage App Members",
      readOnlyHint: false,
      // Destructive: `remove` revokes a member's access.
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
                ...(args["custom_roles"] !== undefined
                  ? {
                      customRoles: (args["custom_roles"] as unknown[]).map(
                        String,
                      ),
                    }
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
            // The key must be PRESENT: [] means "clear the roles", which is a
            // real instruction, so an omitted key cannot be read as one.
            const roles = args["custom_roles"];
            if (!Array.isArray(roles)) {
              return invalidArgs(
                "set_role requires `custom_roles` (a list of declared role names, or [] to clear them)",
              );
            }
            return jsonResult(
              await client.setAppMemberRole(appId, String(args["human_id"]), {
                customRoles: roles.map(String),
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
      "A v2 app's grant links (M5). A grant link is a capability URL that confers a declared custom role (x-homespun-manifest.roles) on a stable per-holder anonymous identity, so a holder's own rows are isolated by author/:own scoping. A grant does not escalate to owner, member or agent. Actions: mint creates a link and returns a `grant_url` carrying the token in its #g= fragment, shown once and not recoverable afterwards; list returns the app's links and never a token; revoke is idempotent. mode 'once' is one-time, claimed by the first browser to open it; 'multi' is shared, capped by max_uses within expiry. An optional pin (pin_row_key or pin_where) narrows a holder to specific rows and never widens their access. One consequence worth knowing when minting: a write-only grant pinned to a single row key can still read that row's existing data back through create dedup, so such a grant exposes that row's current contents to the holder.",
    inputSchema: grantsShape,
    // Consolidated tool: read action (list) + mutating ones (mint/revoke).
    // Hint reflects revoke, the most-privileged action.
    annotations: {
      title: "Manage App Grant Links",
      readOnlyHint: false,
      // Destructive: `revoke` kills a live capability URL.
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
      "A v2 app's inbound catch-hooks (inbound-webhooks). A catch-hook lets an external system such as Stripe, Zapier, Make, Home Assistant or an email router POST JSON to a secret URL that writes into a declared collection, so the app receives data with no agent online. Hooks are declared in the manifest (x-homespun-manifest.ingest) and materialized at deploy, so this tool has no create or delete: it reads back the URL, rotates a leaked one, and manages the opt-in signing secret. After deploying a manifest that declares a hook, list is what yields the exact URL to paste into the external system. Actions: list returns the app's hooks, each with its full secret URL, current rule collection, mode, wake and handshake settings, per-status delivery counts and signing-secret state; rotate mints a fresh URL secret for one hook by name and returns the new url once, after which the old url stops working immediately with no redeploy needed; set_signing_secret provisions or rotates a hook's signing secret, which is a different secret from the URL and is what a provider HMACs the body with, minting one returned once when `secret` is omitted or storing a provider value verbatim when it is passed, and never echoing it back; clear_signing_secret removes it. Signature verification currently ships dark: nothing verifies a signature yet.",
    inputSchema: ingestShape,
    // Consolidated tool: read action (list) + a mutating one (rotate). Marked
    // destructive (not read-only) because rotate invalidates the old URL, which
    // breaks any external system still using it, following the same "any
    // consolidated tool that can mutate is destructive" convention as members/
    // grants/apps.
    annotations: {
      title: "Manage App Inbound Hooks",
      readOnlyHint: false,
      // Destructive: `rotate` and `clear_signing_secret` invalidate a
      // secret an external system is actively signing with.
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
          case "set_signing_secret": {
            if (str(args, "name") === undefined) {
              return invalidArgs("set_signing_secret requires `name`");
            }
            const secret = str(args, "secret");
            const grace = args["grace_seconds"];
            return jsonResult(
              await client.setIngestSigningSecret(appId, String(args["name"]), {
                ...(secret !== undefined ? { secret } : {}),
                ...(typeof grace === "number" ? { graceSeconds: grace } : {}),
              }),
            );
          }
          case "clear_signing_secret": {
            if (str(args, "name") === undefined) {
              return invalidArgs("clear_signing_secret requires `name`");
            }
            return jsonResult(
              await client.clearIngestSigningSecret(
                appId,
                String(args["name"]),
              ),
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
      "Binary attachments (images, PDFs, audio, video) referenced from event payloads and input_data via `format: homespun-attachment-id`. Actions: upload, fetch, presign, finalize, download, show, list, delete, mint_token, revoke_token, list_tokens.\n\nChoosing an upload path matters for cost. An inline upload with `content_base64` carries the bytes in the tool-call arguments, so they enter the model context at a token cost proportional to file size, paid again on every retry; a few-hundred-KB image is already expensive. Two paths avoid that entirely: fetch, when the bytes are reachable at a URL, and presign plus finalize, when the client can PUT the raw bytes out of band. Inline upload suits small assets and clients that have neither a URL nor an out-of-band PUT.\n\nfetch takes { source_url (https), scope } and the relay downloads the URL itself behind an SSRF guard (https only, no private, loopback or metadata hosts, DNS pinned, redirects refused, size-capped and timed out), then runs the same byte-sniff, allowlist, size, quota and scan checks as any upload. It works on any storage backend. upload takes either `content_base64` (base64 bytes, no filesystem) or `file_path` (an absolute path read on the relay host, so it only applies when the file is local to the relay). presign plus finalize is token-free: presign with { mime, size, sha256, scope } returns { put_url, attachment_id }, the caller PUTs the raw bytes to put_url over plain HTTP out of band, then finalize with the attachment_id. At finalize the relay re-reads the stored bytes, sniffs the real type, and enforces the same allowlist, size, sha256, quota and scan checks, so a presign that misstates its mime is caught and never served inline. The presigned path requires the Azure storage backend; a filesystem self-host returns a clear not-supported error and fetch or inline upload apply there instead. download writes to an absolute out_path or returns base64. An upload is scoped to agent (the default, reusable) or app. mint_token returns a /b/<token> capability URL, shown once, that a browser can GET without the caller's API key.",
    inputSchema: attachmentsShape,
    // Consolidated tool: read actions (download/show/list/list_tokens) +
    // mutating ones (upload/delete/mint_token/revoke_token). openWorld:true
    // because upload pushes bytes into external relay storage + mint_token
    // produces a publicly-fetchable capability URL.
    annotations: {
      title: "Manage Attachments",
      readOnlyHint: false,
      // Destructive: `delete` removes an attachment and `revoke_token`
      // kills a live capability URL.
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
          case "fetch": {
            // Server-side URL ingestion: the relay downloads source_url itself
            // (SSRF-guarded), so no bytes ride in the tool-call arguments and
            // nothing enters the model context.
            const sourceUrl = str(args, "source_url");
            if (sourceUrl === undefined)
              return invalidArgs(
                "fetch requires `source_url` (an https URL the relay downloads server-side)",
              );
            const scope = (str(args, "scope") ?? "agent") as "agent" | "app";
            if (scope === "app" && str(args, "app_id") === undefined)
              return invalidArgs("scope=app requires `app_id`");
            const ref = await client.fetchBlob(sourceUrl, {
              scope,
              appId: str(args, "app_id"),
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
      "The agent's UI taste notes: a short freeform markdown document of presentation preferences gathered from human feedback, such as 'denser layout' or 'no rounded corners'. Reading it before generating or revising an app is what carries earlier feedback into new output. Actions: get returns the current document; set replaces it in whole, so it does not append; clear discards it. Scoped to presentation preferences rather than general storage.",
    inputSchema: tasteShape,
    // Consolidated tool: read action (get) + mutating ones (set replaces the
    // doc, clear deletes it). Hint reflects the destructive action.
    annotations: {
      title: "Manage UI Taste Notes",
      readOnlyHint: false,
      // Destructive: `clear` discards the stored notes.
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
      "The calling agent's API key. Actions: list returns key info (agent_id, key_prefix, timestamps); mint creates a sibling API key for the caller's own agent identity with the same scope and ownership and returns its raw value once, which is how an MCP-driven agent hands a CLI or child process a working credential, and the raw value is not retrievable afterwards, the sibling appears in a later list made with it, and the owner can revoke it; revoke destroys the agent's own key, which stops working immediately and cannot be undone, so it requires confirm:true. The relay derives identity from the caller's token, so every action applies to the caller's own agent and mint cannot target another agent's id.",
    inputSchema: keyShape,
    // Consolidated tool: read action (list) + a mutating one (revoke
    // self-destructs the agent's own key). Hint reflects the destructive
    // action.
    annotations: {
      title: "Manage API Key",
      readOnlyHint: false,
      // Destructive: `revoke` is irreversible and stops the key working
      // immediately (already gated behind confirm:true).
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
      "Feedback to the relay operator. Actions: create records a bug, feature or note with a message and an optional app_id; list returns the agent's own submissions, newest first, paginated by `before`.",
    inputSchema: feedbackShape,
    // Consolidated tool: read action (list) + a side-effecting one (create
    // submits feedback to the relay operator). Hint reflects the write action.
    annotations: {
      title: "Manage Feedback",
      readOnlyHint: false,
      // create + list only. Nothing can be edited or withdrawn.
      destructiveHint: false,
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
      "Agent identity and binding. Actions: whoami returns the resolved relay URL, the active profile and whether a key is configured, with no network call and no secrets; claim binds this agent to a human using a one-shot claim code from their Settings UI, and is one-way; logout clears the locally saved key and profile but does not revoke it on the relay, which is what the `key` tool's revoke action does.",
    inputSchema: agentShape,
    // Consolidated tool: read action (whoami) + mutating ones (claim binds
    // this agent to a human, logout clears the local profile). Hint reflects
    // the state-changing action.
    annotations: {
      title: "Manage Agent Identity",
      readOnlyHint: false,
      // whoami | claim | logout. `logout` ends the local binding and is
      // reversible by claiming again; no stored data is removed.
      destructiveHint: false,
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
      "Publishing an app as a community template, taking your own listing back down, installing a template, and, for relay operators, reviewing submissions. Actions: publish, unpublish, get_config_contract, install, list_pending, get_submission, approve, reject, set_trust_level.\n\npublish captures a live app (html, manifest, the seed rows of its seedOnInstall collections, and listing metadata) into a pending template. It is installable by the returned direct link but is not listed in the public gallery until an operator approves it, and it requires a verified email and no more than a few pending submissions at once. Privacy consequence: an approved template's content and its captured seed rows become public to every platform user, so seed data in a published app must be example-only rather than real personal data. attest_example_only:true records that this was checked. A template may take a per-publisher `slug` (namespaced as <handle>/<slug>) and a semver `version` defaulting to 1.0.0, and a republish under the same slug must bump the version.\n\nunpublish is the publisher's own undo for a live listing, taken down by snapshot_id: it leaves the public gallery, search, and the direct snapshot install link. It works only on your own submissions, and a snapshot that does not exist or belongs to someone else reads as not found either way. Existing installs are unaffected, because an install is a fresh private copy rather than a live reference, so unpublishing never breaks an app someone already installed. It is idempotent, and publishing a new version is the way to put the listing back.\n\nget_config_contract reads what a template needs at install, meaning its settings collection and its ordered config and upload steps, by `ref`. install creates a fresh private copy of a template for the caller's owning human, passing answers as `config`, where a 'config' value is a string and an 'upload' value is a pre-uploaded attachment id from the attachments tool.\n\nThe review actions are limited to the relay's configured community reviewers: list_pending returns the queue; get_submission returns a submission's full content by snapshot_id; approve lists it in the gallery, where a re-publish supersedes the app's prior approved version; reject takes a required note that lands in the publisher's app feed.",
    inputSchema: communityShape,
    // Consolidated tool: read actions (list_pending/get_submission) + mutating
    // ones (publish/unpublish/approve/reject). Hint reflects the
    // most-privileged action.
    annotations: {
      title: "Community Templates",
      readOnlyHint: false,
      // `approve`, `reject` and `set_trust_level` only move a submission
      // between states and the submission itself survives every one of them,
      // but `unpublish` REMOVES a live listing from the public gallery, from
      // search, and from its direct install link. That is existing state
      // going away, so the tool is destructive.
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
          case "unpublish":
            if (str(args, "snapshot_id") === undefined) {
              return invalidArgs("unpublish requires `snapshot_id`");
            }
            return jsonResult(
              await client.unpublishCommunityTemplate(
                String(args["snapshot_id"]),
              ),
            );
          case "get_config_contract": {
            const ref = str(args, "ref");
            if (ref === undefined) {
              return invalidArgs("get_config_contract requires `ref`");
            }
            return jsonResult(await client.getCommunityConfigContract(ref));
          }
          case "install": {
            const ref = str(args, "ref");
            if (ref === undefined) {
              return invalidArgs("install requires `ref`");
            }
            const cfg = args["config"];
            const config =
              cfg !== null && typeof cfg === "object" && !Array.isArray(cfg)
                ? (cfg as Record<string, unknown>)
                : undefined;
            return jsonResult(
              await client.installCommunityTemplate(ref, config),
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
      "The caller's community publisher identity: the @-handle and public profile shown in the template gallery. Actions: get returns the profile, including the handle, whether it has been claimed, tenure, and the rating and template counters; claim sets the handle from a lowercase 3-to-32-character string and may be used only once, after which the handle is permanent, and it refuses a handle that is reserved or already taken; update changes display_name, bio or url at any time. claim and update require a verified email. An existing publisher may hold a provisional `maker-...` handle assigned automatically, which claim renames on its one allowed use.",
    inputSchema: publisherShape,
    // Consolidated tool: a read action (get) plus mutating ones (claim/update).
    // claim is irreversible (the handle is permanent), so the hint reflects the
    // most-privileged action.
    annotations: {
      title: "Publisher Profile",
      readOnlyHint: false,
      // claim | get | update on the caller's own profile. No delete action.
      destructiveHint: false,
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
      "Ratings and reviews of community templates, responses from a template's own publisher, and, for relay operators, moderation. Actions: create leaves a 1-to-5 star rating and an optional written body on a template the caller has installed, identifying it by `template` (\\\"<handle>/<slug>\\\") or by `handle` plus `slug`, and requires a verified email; each install yields exactly one review, and the aggregate carries across template versions. A body containing a link or a contact email is held automatically for a moderator before it appears. respond replies to a review of the caller's own template line (review_id plus response, or null to clear it), with one editable response per review. report flags a review for the relay's moderators (review_id plus reason) and is deduped per account. remove and unhold are limited to the relay's configured community reviewers: remove takes a review down and adjusts the rating aggregate, and unhold publishes a previously held review into the aggregate.",
    inputSchema: reviewShape,
    // Consolidated tool: a write action (create), publisher/reporter actions,
    // and operator moderation (remove/unhold). Hint reflects remove, the most
    // privileged / destructive action.
    annotations: {
      title: "Community Reviews",
      readOnlyHint: false,
      // Destructive: `remove` takes a review down.
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
      "The relay's SKILL.md, a generated guide to the Homespun workflow covering events versus records, the schema grammars and the poll loop. Needs no API key. Useful when working out how the other tools fit together, or to refresh a cached copy. Pass version_only:true to return just the relay's skill version string, which is enough to tell whether a cached copy is current.",
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
