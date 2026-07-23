// The single source of truth for the CLI's command surface.
//
// One table describes every noun, verb, and flag. Three consumers read it and
// nothing else:
//
//   1. assertKnownFlags(), via specFor(), so the flags a command ACCEPTS are
//      the flags this table declares. There is no second list to drift from.
//   2. `homespun <noun> --help` and `homespun --help`, rendered by
//      renderNounHelp() / renderRootHelp() below.
//   3. docs-site, which bundles this file with esbuild and generates
//      /agents/cli-reference from it.
//
// Adding a flag is a one-line edit here. Previously it meant editing an inline
// allow-list in the runner AND a usage line in a help template, with nothing
// checking the two against each other, and the published CLI reference was a
// third hand-written copy that matched neither.
//
// This file MUST stay pure: no imports, no I/O, no env. docs-site executes it
// at build time with none of the CLI's runtime available. Keep it a data table
// plus pure string building.
//
// Note on globals: url, api-key and profile (value) and help and json
// (boolean) are added to every command by assertKnownFlags itself, so they are
// deliberately NOT repeated per verb here. Before this table, 25 of 50 call
// sites listed some of them redundantly and the rest did not.
//
// House style: no em or en dashes anywhere in this file. The docs generator
// scans for them and names the offending entry.

/** A value flag (`--flag <value>`) or boolean flag (`--flag`) on one verb. */
export interface FlagSpec {
  /** Flag name without the leading dashes. */
  name: string;
  /** `<value>` placeholder shown in help. Omit for boolean flags. */
  value?: string;
  /** One line, sentence case, no trailing full stop. */
  description: string;
}

export interface VerbSpec {
  /** Verb name, or "" for a noun that is itself the command (deploy). */
  verb: string;
  /** Positional arguments, already bracketed, e.g. "<app>" or "[name]". */
  positionals?: string;
  /** One sentence for the docs table and the noun help summary line. */
  summary: string;
  /** Value flags, beyond the globals. */
  flags?: FlagSpec[];
  /** Boolean flags, beyond the globals. */
  bools?: FlagSpec[];
}

export interface NounSpec {
  /** Noun as typed, e.g. "apps". */
  noun: string;
  /** Short phrase after the noun in help titles, e.g. "app lifecycle management". */
  tagline: string;
  /** Which block of `homespun --help` this noun appears under. */
  group: "app" | "other";
  /** The noun's entry in the root help listing. Plain sentences. */
  rootSummary: string;
  verbs: VerbSpec[];
  /**
   * Verb comes LAST, after the common positionals, e.g. `data`, whose parser
   * reads `homespun data <app> <collection> <verb>`. The default is verb-first
   * (`homespun apps watch <app>`), matching every other noun. When set, a
   * verb's `positionals` holds only what follows the verb, and
   * `commonPositionals` holds what precedes it.
   */
  verbLast?: boolean;
  /**
   * For a verbLast noun, the positionals that come BEFORE the verb and are the
   * same for every verb, e.g. "<app> <collection>". Ignored otherwise.
   */
  commonPositionals?: string;
  /** Paragraphs printed after the usage block. Irreducible prose. */
  notes?: string[];
  /** Overrides the default output note at the foot of the help. */
  outputNote?: string;
}

const DEFAULT_OUTPUT_NOTE =
  'Output is JSON on stdout. Errors go to stderr as {"error":{"code","message"}} with a non-zero exit.';

const APPS: NounSpec = {
  noun: "apps",
  tagline: "app lifecycle management",
  group: "app",
  rootSummary:
    "App lifecycle: list, show, update, delete, wake, watch (stream the app's change feed as JSON-lines).",
  verbs: [
    {
      verb: "list",
      summary: "Lists your apps.",
      flags: [
        {
          name: "status",
          value: "<active|dormant|archived|all>",
          description: "Filter by lifecycle status",
        },
        { name: "limit", value: "<n>", description: "Page size" },
        { name: "cursor", value: "<cursor>", description: "Page cursor" },
        {
          name: "slug",
          value: "<slug>",
          description: "Look up one app by slug",
        },
      ],
    },
    {
      verb: "show",
      positionals: "<app>",
      summary: "Shows one app's detail record.",
    },
    {
      verb: "update",
      positionals: "<app>",
      summary: "Changes an app's visibility or timezone.",
      flags: [
        {
          name: "visibility",
          value: "<private|link|public>",
          description: "Who can open the app",
        },
        {
          name: "timezone",
          value: "<IANA zone>",
          description: "Timezone used for the app's day boundaries",
        },
      ],
    },
    {
      verb: "share-link",
      positionals: "rotate <app>",
      summary:
        "Rotates a link-visibility app's share token, invalidating the old URL.",
    },
    {
      verb: "delete",
      positionals: "<app>",
      summary: "Soft-deletes an app.",
      bools: [{ name: "yes", description: "Skip the confirmation prompt" }],
    },
    {
      verb: "wake",
      positionals: "<app>",
      summary: "Wakes a dormant app.",
    },
    {
      verb: "watch",
      positionals: "<app>",
      summary: "Streams the app's change feed as JSON-lines.",
      flags: [
        {
          name: "since",
          value: "<cursor>",
          description: "Resume from a feed cursor",
        },
        {
          name: "collection",
          value: "<name[,name2,...]>",
          description: "Only stream these collections",
        },
        {
          name: "timeout",
          value: "<secs>",
          description: "Give up after this long",
        },
      ],
      bools: [
        {
          name: "once",
          description: "Print one batch and exit instead of streaming",
        },
      ],
    },
  ],
  notes: [
    "<app> accepts either the app_id or its slug (resolved via GET /v1/apps?slug= when it does not look like a cuid).",
    'watch streams the app\'s change feed as JSON-lines on stdout, one compact SerializedFeedEntry object per line, identical whether served over the live WebSocket (primary) or the long-poll fallback (used automatically when the WS upgrade fails, for example self-host mode has no WS support yet, or a locked-down network blocks outbound WS). A dormancy transition mid-watch emits a single {"type":"_dormant"} line and exits 0.',
  ],
  outputNote:
    'Output is JSON, and JSON-lines for watch. Errors go to stderr as {"error":{"code","message"}} with a non-zero exit.',
};

const DATA: NounSpec = {
  noun: "data",
  tagline: "collection row CRUD for an app",
  group: "app",
  rootSummary:
    "Collection row CRUD for an app: list, get, upsert, update, delete, purge, import, plus retention (owner override).",
  // The data parser is verb-LAST: `homespun data <app> <collection> <verb>`
  // (see commands/data.ts, which reads the verb from positionals[2]). Every
  // other noun is verb-first. Each verb below carries only the positionals that
  // FOLLOW the verb; <app> <collection> come before it, via commonPositionals.
  verbLast: true,
  commonPositionals: "<app> <collection>",
  verbs: [
    {
      verb: "list",
      summary: "Lists rows in a collection.",
      flags: [
        {
          name: "since",
          value: "<cursor>",
          description: "Page from this feed cursor",
        },
        { name: "limit", value: "<n>", description: "Page size, 1 to 1000" },
        {
          name: "where",
          value: "<json>",
          description:
            "JSON array of {field, op, value} conditions, ANDed together",
        },
        {
          name: "sort",
          value: "<json>",
          description: "JSON array of {field, dir} sort specs, dir asc or desc",
        },
      ],
    },
    {
      verb: "get",
      positionals: "<key>",
      summary: "Shows one row by key.",
    },
    {
      verb: "upsert",
      summary: "Creates a row, or ensures one exists at a key or unique field.",
      flags: [
        {
          name: "data",
          value: "<path|json>",
          description:
            "Row data as a path to a JSON file, or inline JSON (required)",
        },
        {
          name: "key",
          value: "<key>",
          description:
            "Ensure a row exists at this key instead of server-generating one",
        },
        {
          name: "on",
          value: "<field>",
          description:
            "Upsert on this manifest-declared UNIQUE field instead of the key",
        },
      ],
    },
    {
      verb: "update",
      positionals: "<key>",
      summary: "Replaces an existing row's data.",
      flags: [
        {
          name: "data",
          value: "<path|json>",
          description:
            "Row data as a path to a JSON file, or inline JSON (required)",
        },
        {
          name: "if-match",
          value: "<version>",
          description: "Only write if the row is still at this version",
        },
      ],
    },
    {
      verb: "delete",
      positionals: "<key>",
      summary: "Deletes one row by key.",
      flags: [
        {
          name: "if-match",
          value: "<version>",
          description: "Only delete if the row is still at this version",
        },
      ],
      bools: [{ name: "yes", description: "Skip the confirmation prompt" }],
    },
    {
      verb: "purge",
      summary: "Removes one row even from an append-only collection.",
      flags: [
        {
          name: "key",
          value: "<key>",
          description: "Key of the row to purge (required)",
        },
      ],
      bools: [{ name: "yes", description: "Skip the confirmation prompt" }],
    },
    {
      verb: "import",
      summary: "Bulk-writes rows from a file in chunks via the batch API.",
      flags: [
        {
          name: "file",
          value: "<path>",
          description: "NDJSON or JSON-array file to import (required)",
        },
        {
          name: "chunk",
          value: "<n>",
          description: "Rows per batch call, default 100",
        },
        {
          name: "key-field",
          value: "<field>",
          description:
            "Derive each row key from this field, create-or-skip by id",
        },
        {
          name: "on",
          value: "<field>",
          description: "Upsert on this manifest-declared UNIQUE field",
        },
      ],
      bools: [
        {
          name: "emit-effects",
          description: "Fire notify and webhooks instead of importing silently",
        },
      ],
    },
    {
      verb: "retention",
      summary:
        "Shows or overrides the owner retention on a collection (owner control).",
      flags: [
        {
          name: "max-rows",
          value: "<n>",
          description: "Override the max live rows kept (per-axis, positive)",
        },
        {
          name: "max-age-days",
          value: "<n>",
          description: "Override the max row age in days (per-axis, positive)",
        },
      ],
      bools: [
        {
          name: "clear-rows",
          description:
            "Clear the rows override, reverting to the author default",
        },
        {
          name: "clear-age",
          description:
            "Clear the age override, reverting to the author default",
        },
        {
          name: "show",
          description:
            "Only read the current effective retention, change nothing",
        },
      ],
    },
  ],
  notes: [
    "<app> accepts either the app_id or its slug. upsert is the ONLY create-shaped verb: omit --key to add a new row (the server generates the key); pass --key to ensure a row exists at that key (returns the existing row with deduped:true on a collision, never errors). Pass --on <field> to upsert on a manifest-declared UNIQUE field instead of the key: the row whose <field> value matches is updated in place (idempotent re-import), else created.",
    "list --where takes a JSON array of {field, op, value} conditions (ANDed), op one of eq, neq, in, notIn, gt, lt, gte, lte (in and notIn take an array value). --sort takes a JSON array of {field, dir} (dir asc or desc). Filtering is applied AFTER the read permission and author scoping, so a filtered list is always a subset of what you could already read. Comparisons are same-type only (no coercion); dates compare as ISO-8601 strings. A custom --sort cannot be combined with --since.",
    "purge removes ONE row by --key even in an append-only collection. Owner and agent only (never members or anyone); it bypasses append-only and the collection delete list on purpose, and writes an audited delete feed entry.",
    "import reads NDJSON (one JSON object per line) OR a JSON array from --file and bulk-writes it in chunks via the batch API, in ONE process. Each object is a row's data. Pass --key-field to derive the row key from a field: an existing row at that key is LEFT UNCHANGED, so this is create-or-skip-by-id, not overwrite, and re-importing changed data for a known key does not update it. Import DEFAULTS TO SILENT (it suppresses notify and webhooks, since a bulk import is a migration); pass --emit-effects to fire them. A per-row failure is listed in the summary WITHOUT aborting the import.",
    "retention is an OWNER control: the author declares default retention in the manifest, and this tightens or loosens it per collection at runtime WITHOUT a redeploy. Effective retention is per-axis override-or-author-default: --max-rows/--max-age-days set an axis override, --clear-rows/--clear-age revert an axis to the author default, and with no flag (or --show) it just reads. The response reports the effective bounds, the author default, the override, and wouldPrune (how many live rows the effective bound would prune on the next sweep). The override survives redeploys and effective maxRows is capped at MAX_ROWS_PER_APP.",
  ],
  outputNote:
    'Output is a single JSON object on stdout, and import additionally writes per-chunk progress lines to stderr. Errors go to stderr as {"error":{"code","message"}} with a non-zero exit.',
};

const MEMBERS: NounSpec = {
  noun: "members",
  tagline: "app membership management",
  group: "app",
  rootSummary:
    "App membership management: add, list, set-role, remove, roles. Invite or attach a member by email, list the app's owner and members, re-role or remove someone, or summarize the app's declared roles.",
  verbs: [
    {
      verb: "add",
      summary: "Invites or attaches a member to the app by email.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App to add the member to (required)",
        },
        {
          name: "email",
          value: "<email>",
          description: "Email address of the human to add (required)",
        },
        {
          name: "role",
          value: "<member>",
          description:
            'Role to grant; only "member" is valid, and it is the default',
        },
      ],
    },
    {
      verb: "list",
      summary: "Lists the app's owner and every attached member.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App to list members of (required)",
        },
      ],
    },
    {
      verb: "set-role",
      summary: "Changes an existing member's custom role in place.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App the member belongs to (required)",
        },
        {
          name: "human",
          value: "<humanId>",
          description: "Human whose role changes (required)",
        },
        {
          name: "custom-role",
          value: "<name>",
          description:
            "Custom role to assign; must be declared in the app's manifest",
        },
      ],
      bools: [
        {
          name: "clear-role",
          description: "Drop the member back to a plain member",
        },
      ],
    },
    {
      verb: "remove",
      summary: "Removes a member from the app and revokes their sessions.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App to remove the member from (required)",
        },
        {
          name: "human",
          value: "<humanId>",
          description: "Human to remove (required)",
        },
      ],
    },
    {
      verb: "roles",
      summary:
        "Summarizes the roles the app declares and their effective access.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App to summarize roles for (required)",
        },
      ],
    },
  ],
  notes: [
    "--app accepts either the app_id or its slug (resolved via GET /v1/apps?slug= when it does not look like a cuid).",
    'add: if a Human already exists for --email, the member row is attached immediately and the response is { member: { humanId, email, role, createdAt } }. Otherwise the relay mints a signed invite and emails a magic link, responding { ok: true, invited, expires_at }. Only "member" is a valid --role (the default); ownership transfer is not available here. Fails with a relay error (503 auth_provider_unavailable) if the relay has no email provider configured.',
    "set-role changes an existing member's custom role in place. --custom-role must name a role the app's manifest declares (a built-in role, or one that is not declared, is rejected); --clear-role drops back to a plain member. This does NOT revoke the member's sessions, so re-roling someone never signs them out, which makes it preferable to remove-then-add. The app owner cannot be re-roled.",
    "remove is idempotent, and also revokes the human's live sessions on this app. The app owner cannot be removed (the relay refuses with a 409 conflict).",
    'roles returns the derived summary { roles: [{ name, label, description, collections, member_count, active_grant_count }] }. Each collection entry reports EFFECTIVE access (what a holder can actually do, floors included) per population: member_access for a signed-in member holding the role, grant_access for a grant-link holder of it (no member floor, so the two can differ). Each of read, update and delete is "all", "own" (only rows the holder authored) or "none"; create is "all" or "none". An app that declares no custom roles returns an empty list.',
  ],
};

const INGEST: NounSpec = {
  noun: "ingest",
  tagline: "inbound catch-hook read surface",
  group: "app",
  rootSummary:
    "Inbound catch-hook management: list, rotate, signing-secret. Read back an app's declared inbound hooks with their full secret URL so you can tell the owner where an external system posts, rotate a leaked URL secret, or manage a hook's opt-in signing secret. Hooks themselves are declared in the app manifest (x-homespun-manifest.ingest).",
  verbs: [
    {
      verb: "list",
      summary:
        "Lists the app's inbound catch-hooks with their full secret URL and delivery counts.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App to list inbound hooks for (required)",
        },
      ],
    },
    {
      verb: "rotate",
      summary:
        "Rotates one inbound catch-hook's secret and returns the new URL.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App the hook belongs to (required)",
        },
        {
          name: "name",
          value: "<hookName>",
          description: "Name of the manifest ingest hook to rotate (required)",
        },
      ],
    },
    {
      verb: "signing-secret",
      positionals: "<set|clear>",
      summary:
        "Sets, rotates, or clears a hook's opt-in signing secret (webhook signature verification).",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App the hook belongs to (required)",
        },
        {
          name: "name",
          value: "<hookName>",
          description: "Name of the manifest ingest hook (required)",
        },
        {
          name: "secret",
          value: "<value>",
          description:
            "set only: a provider-generated signing secret to store verbatim; omit to have the relay mint one (shown once)",
        },
        {
          name: "grace-seconds",
          value: "<n>",
          description:
            "set only: how long the previous secret stays valid on a rotation (default 3600, max 86400)",
        },
      ],
    },
  ],
  notes: [
    "--app accepts either the app_id or its slug (resolved via GET /v1/apps?slug= when it does not look like a cuid).",
    "list returns { hooks: [{ name, url, collection, mode, wake, handshake, disabledAt, createdAt, deliveries: { accepted, failed, dropped_duplicate } }] }. The url is the full secret POST URL an external system posts JSON to; hand it to the app owner to paste into Stripe, Zapier, Make, Home Assistant, or any system that can POST a webhook. A hook whose rule left the manifest has disabledAt set and null rule fields.",
    "rotate mints a fresh secret for the named hook and returns { hook: { name, url } } with the NEW url once. The old url stops working immediately; no redeploy is needed. Use it when a url leaks.",
    "signing-secret manages a hook's OPT-IN signing secret, distinct from the URL secret above: it is what a provider (GitHub, Stripe, ...) HMACs the request body with. `set` without --secret mints one and returns { secret, fingerprint, setAt } with the value shown ONCE; `set --secret <value>` stores a provider-generated value verbatim and returns { fingerprint, setAt } without echoing it; `clear` removes it. A rotation keeps the previous secret valid for --grace-seconds so deliveries verify while you update the provider. A hook that declares `verify` in its manifest rule (GitHub scheme in v1) requires a valid signature over the raw body and stays fail-closed (401) until this secret is set; the fingerprint (a plaintext-derived id) lets you confirm which secret is set without the relay ever showing it.",
    "Hooks are declared in the app manifest (x-homespun-manifest.ingest) and materialized at deploy, so there is no create or delete verb here: add or remove a hook by editing the manifest and redeploying.",
  ],
};

const GRANTS: NounSpec = {
  noun: "grants",
  tagline: "grant-link management",
  group: "app",
  rootSummary:
    "App grant-link management: mint, list, revoke. Mint a capability URL carrying a declared custom role, list an app's links, or revoke one.",
  verbs: [
    {
      verb: "mint",
      summary: "Mints a grant link carrying a declared custom role.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App to mint the link for (required)",
        },
        {
          name: "role",
          value: "<customRole>",
          description: "Declared custom role the link confers (required)",
        },
        {
          name: "mode",
          value: "<once|multi>",
          description: "One-time link, or a shared link (multi is the default)",
        },
        {
          name: "max-uses",
          value: "<n>",
          description: "Cap on how many times a multi link can be claimed",
        },
        {
          name: "label",
          value: "<text>",
          description: "Human-readable label for the link",
        },
        {
          name: "ttl",
          value: "<seconds>",
          description:
            "Lifetime in seconds, default 30 days and clamped to the server max",
        },
        {
          name: "pin-row",
          value: "<rowKey>",
          description: "Narrow the holder to a single row",
        },
        {
          name: "pin-where",
          value: "<json>",
          description: "Narrow the holder to rows matching a JSON where array",
        },
      ],
    },
    {
      verb: "list",
      summary: "Lists the app's grant links.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App to list grant links for (required)",
        },
      ],
    },
    {
      verb: "revoke",
      summary: "Revokes one grant link.",
      flags: [
        {
          name: "app",
          value: "<idOrSlug>",
          description: "App the grant link belongs to (required)",
        },
        {
          name: "grant",
          value: "<grantId>",
          description: "Grant link to revoke (required)",
        },
      ],
    },
  ],
  notes: [
    "--app accepts either the app_id or its slug (resolved via GET /v1/apps?slug= when it does not look like a cuid).",
    "mint creates a grant link carrying a DECLARED custom role (a key under x-homespun-manifest.roles). A built-in role (owner, member, agent, anyone) is rejected. --mode once is a one-time link, claimed by the first browser that opens it, with later opens by others inert; --mode multi (the default) is a shared link, capped by --max-uses within expiry. --ttl sets the lifetime in seconds (default 30 days, clamped to the server max). An optional pin NARROWS the holder to specific rows and can never widen: --pin-row <rowKey> for a single row, or --pin-where with a JSON where array. The response carries a grant_url whose #g= fragment holds the token, shown ONCE.",
    "list returns { grants: [...] }, the app's links, never any token material.",
    "revoke is idempotent; a revoked link is rejected on every subsequent request.",
  ],
};

const KEY: NounSpec = {
  noun: "key",
  tagline: "your agent's API key",
  group: "other",
  rootSummary:
    "Your agent's own API key: list, mint, revoke. The relay scopes keys to the calling agent, so every verb acts on your own key.",
  verbs: [
    {
      verb: "list",
      summary:
        "Shows your agent's key info: agent_id, name, key_prefix, created_at, last_used_at, revoked_at.",
    },
    {
      verb: "mint",
      summary:
        "Mints a new sibling API key for your own agent identity and prints its raw value once.",
    },
    {
      verb: "revoke",
      summary: "Revokes your own API key, which stops working immediately.",
      bools: [
        {
          name: "yes",
          description: "Confirm the revoke, which is irreversible",
        },
      ],
    },
  ],
  notes: [
    "The relay scopes /v1/keys to the authenticated agent, so there is exactly one key per agent, your own. Every verb therefore acts only on the caller's own key: mint only ever mints a sibling of yourself (same scope and ownership), never another agent's key, and the relay only allows revoking your own key.",
    "The raw key printed by mint is never retrievable again, so save it at once. Use it to hand a fresh process a working credential. A revoke is a self-destruct: every subsequent command fails until you run 'homespun agent register' again to provision a new key.",
  ],
};

const TASTE: NounSpec = {
  noun: "taste",
  tagline: "your agent's UI taste notes",
  group: "other",
  rootSummary:
    "Your agent's freeform UI taste notes: get, set, clear. Presentation preferences the agent has learned from human feedback and reads before generating an app.",
  verbs: [
    {
      verb: "get",
      summary:
        "Prints the current notes attachment as { taste, updated_at, bytes }.",
    },
    {
      verb: "set",
      summary: "Replaces the whole notes attachment with new markdown.",
      flags: [
        {
          name: "file",
          value: "<path|->",
          description:
            "Markdown source: a file path, or - to read stdin explicitly",
        },
      ],
    },
    {
      verb: "clear",
      summary: "Deletes the notes and prints { cleared: true }.",
      bools: [{ name: "yes", description: "Confirm deleting the notes" }],
    },
  ],
  notes: [
    'Taste notes are a small markdown attachment storing presentation preferences your agent has picked up from human feedback ("denser table", "no rounded corners", "use a dark header"). Read them before generating an app template so prior feedback shapes the output, and rewrite them whenever the human gives new presentation feedback. Keep entries about UI and presentation taste only, not project context, todos, or homespun state.',
    "set is a whole-attachment replace, not an append, so send the WHOLE new attachment. Source the markdown via --file <path>, --file - to read stdin, or by piping into 'homespun taste set' with no flag. The relay rejects empty or whitespace-only payloads and caps the attachment at MAX_TASTE_BYTES (utf8). To remove the notes use 'homespun taste clear', not set with an empty body.",
    "taste is null and bytes is 0 when notes have never been written.",
  ],
};

const FEEDBACK: NounSpec = {
  noun: "feedback",
  tagline: "feedback to the relay operator",
  group: "other",
  rootSummary:
    "One-shot feedback to the relay operator: create, list. Bug reports, feature requests, and notes.",
  verbs: [
    {
      verb: "create",
      summary: "Submits one feedback row and prints { id, type, created_at }.",
      flags: [
        {
          name: "type",
          value: "<bug|feature|note>",
          description: "Feedback category, required",
        },
        {
          name: "message",
          value: "<text|->",
          description:
            "Message body, 1 to 4000 chars after trim; pass - to read stdin",
        },
        {
          name: "app-id",
          value: "<id>",
          description:
            "Optional app this feedback relates to, owned by your agent's human",
        },
      ],
    },
    {
      verb: "list",
      summary: "Lists your agent's own submissions, newest first.",
      flags: [
        {
          name: "limit",
          value: "<n>",
          description: "Page size (default 50, max 100)",
        },
        {
          name: "before",
          value: "<cursor>",
          description: "Opaque cursor from a previous page's next_before",
        },
      ],
    },
  ],
  notes: [
    "Feedback is a one-shot bug report, feature request, or note from your agent to whoever runs the relay. Submissions are stored in the relay DB and the operator triages them out of band.",
    "create does not echo the message back. list prints { items: [...], next_before } so you can pass --before <cursor> from a previous page to fetch the next one.",
  ],
};

const CONFIG: NounSpec = {
  noun: "config",
  tagline: "CLI config and profile management",
  group: "other",
  rootSummary:
    "CLI config inspection and multi-profile management: show, list, use, add, rm.",
  verbs: [
    {
      verb: "show",
      summary:
        "Shows the resolved relay config and where each value came from (flag, env, profile, or none).",
    },
    {
      verb: "list",
      summary:
        "Lists saved profiles with their URLs and masked key prefixes, marking the active one.",
    },
    {
      verb: "use",
      positionals: "<profile>",
      summary: "Switches the active profile.",
    },
    {
      verb: "add",
      positionals: "<profile>",
      summary:
        "Saves a url and api_key pair under a profile name without contacting the relay.",
      flags: [
        {
          name: "api-key",
          value: "<key>",
          description: "Agent API key to save in the profile, required",
        },
      ],
    },
    {
      verb: "rm",
      positionals: "<profile>",
      summary: "Deletes a profile from the config file.",
    },
  ],
  notes: [
    "A profile is one url and api_key pair under a short name (dev, staging, prod). Switch via 'homespun config use', --profile <name>, or the HOMESPUN_PROFILE env var. The active profile is what every other command sees unless overridden by --url, --api-key, HOMESPUN_URL or HOMESPUN_API_KEY.",
    "Every verb is purely local: it inspects flags, env, and the saved config file and makes no network call. The full API key is never printed, only a short masked prefix. The config file lives at ${XDG_CONFIG_HOME:-~/.config}/homespun/config.json (mode 0600).",
    "add requires both --url and --api-key, and overwrites the existing values if the profile already exists. Use it when an operator handed you an API key out of band, for example a closed-registration relay; for self-register and secret-mode relays prefer 'homespun agent register --profile <name>'. It does not change current_profile unless it is the first profile added, so run 'homespun config use' afterwards to switch. rm clears current_profile when it removes the active profile, and the next command falls back to env or the default URL until another profile is selected.",
  ],
};

const SKILL: NounSpec = {
  noun: "skill",
  tagline: "the relay's SKILL.md",
  group: "other",
  rootSummary:
    "The relay's SKILL.md: show, version. Auto-updating, and no API key is required.",
  verbs: [
    {
      verb: "show",
      summary:
        "Fetches the relay's SKILL.md and writes the raw markdown to stdout.",
    },
    {
      verb: "version",
      summary: "Prints the relay's skill version.",
      bools: [
        {
          name: "plain",
          description:
            "Print the bare version string instead of the JSON envelope",
        },
      ],
    },
  ],
  notes: [
    "The skill is auto-updating: the relay's deployed image owns both the body and the version, so this is always the skill that matches the relay you are talking to.",
    "Both verbs are unauthenticated, so no API key is needed. An agent can call either form before 'homespun agent register' to bootstrap or refresh its local skill copy. Pipe show to your local skill path, and use version as the staleness probe: compare it against the skill-version comment in the local file and re-run show when they differ. --plain makes that comparison easy inline in a shell pipeline.",
  ],
  outputNote:
    'Output on stdout is raw markdown for show, and {"version":"1.0.0"} for version, or a bare version string with --plain. Errors go to stderr as {"error":{"code","message"}} with a non-zero exit.',
};

const DEPLOY: NounSpec = {
  noun: "deploy",
  tagline: "create or redeploy an app",
  group: "app",
  rootSummary:
    "Create or redeploy an app (POST /v1/apps or POST /v1/apps/:id/versions): the create then redeploy loop.",
  verbs: [
    {
      verb: "",
      positionals: "<dir|file>",
      summary:
        "Creates a new app, or redeploys an existing one when --app is given.",
      flags: [
        {
          name: "app",
          value: "<id>",
          description:
            "Redeploy this existing app instead of creating a new one",
        },
        {
          name: "manifest",
          value: "<path|json>",
          description:
            "Manifest file path or inline JSON, for the single-file deploy",
        },
        {
          name: "slug",
          value: "<slug>",
          description:
            "Requested slug when creating an app, rejected with visibility link",
        },
        {
          name: "visibility",
          value: "<private|link|public>",
          description: "Who can open the new app, on create only",
        },
      ],
      bools: [
        { name: "force", description: "Override the redeploy compat gate" },
        {
          name: "check",
          description:
            "Validate only and report what a deploy would do, without creating anything",
        },
      ],
    },
  ],
  notes: [
    "Packaging has one canonical shape and one escape hatch. A directory deploy (homespun deploy ./my-app) reads ./my-app/index.html and ./my-app/manifest.json: fixed filenames, no discovery heuristics, and both files are required. The single-file escape hatch (homespun deploy ./index.html --manifest ./manifest.json) takes the manifest from --manifest, which accepts a file path or inline JSON.",
    "Create versus redeploy is decided by the presence of --app, not by two verbs. With no --app this creates an app (POST /v1/apps); new apps default to private (owner plus invited members, sign-in gated), --slug is accepted with private or public visibility including the default, and an explicit --visibility link always gets a server-generated slug and rejects --slug. With --app <id> this redeploys (POST /v1/apps/:id/versions), where --slug and --visibility are rejected because the slug is immutable and visibility changes go through 'homespun apps update'.",
    "--check is a dry run. It runs the full manifest and asset-shape validation, the redeploy compat gate (with --app), and the schedule-timezone advisory, then prints { ok, warnings, compat, breaks } without creating a version or mutating anything. An invalid manifest fails the same way a real deploy would, and a narrowing redeploy reports the compat break instead of applying it.",
  ],
  outputNote:
    'Output is JSON: { app_id, slug, url, version, visibility, created, share_url, compat, breaks, warnings }. share_url is present only when creating a link-visibility app: it carries the app share token in its #k= fragment and is shown ONCE, it is not recoverable later, and it can be rotated with \'homespun apps share-link rotate <app>\'. warnings flags non-fatal issues, for example an app that declares schedules with no timezone set (reminders fire at 08:00 UTC until one is set). Errors go to stderr as {"error":{"code","message"}} with a non-zero exit.',
};

const ATTACHMENT: NounSpec = {
  noun: "attachment",
  tagline: "binary attachments on the relay",
  group: "other",
  rootSummary:
    "Binary attachments: upload, download, show, list, delete, and token (mint, revoke, list). Attachments are scoped to an agent or an App, and can be referenced from input_data.",
  verbs: [
    {
      verb: "upload",
      summary: "Uploads a local file as an attachment.",
      flags: [
        { name: "file", value: "<path>", description: "Local file to upload" },
        {
          name: "scope",
          value: "<agent|app>",
          description:
            "Attachment scope: agent is reusable and the default, app binds it to one App",
        },
        {
          name: "app-id",
          value: "<id>",
          description:
            "App to bind the attachment to, required when scope is app",
        },
        {
          name: "filename",
          value: "<name>",
          description: "Display filename, defaulting to the basename of --file",
        },
        {
          name: "mime",
          value: "<type>",
          description:
            "Declared Content-Type, advisory only since the relay sniffs the bytes regardless",
        },
      ],
    },
    {
      verb: "download",
      positionals: "<attachment-id>",
      summary: "Downloads an attachment's bytes.",
      flags: [
        {
          name: "out",
          value: "<path>",
          description: "Write the bytes to this path instead of stdout",
        },
      ],
    },
    {
      verb: "show",
      positionals: "<attachment-id>",
      summary: "Prints an attachment's metadata without downloading the bytes.",
    },
    {
      verb: "list",
      summary: "Lists your agent's non-deleted attachments, newest first.",
      flags: [
        {
          name: "cursor",
          value: "<token>",
          description: "Opaque pagination cursor from a prior response",
        },
        {
          name: "limit",
          value: "<n>",
          description:
            "Page size, 1 to 100, defaulting to the relay default of 50",
        },
      ],
    },
    {
      verb: "delete",
      positionals: "<attachment-id>",
      summary: "Soft-deletes an attachment.",
    },
    {
      verb: "token mint",
      positionals: "<attachment-id>",
      summary: "Mints a /b/<token> capability URL for one attachment.",
      flags: [
        {
          name: "ttl",
          value: "<seconds>",
          description:
            "Per-token lifetime in seconds, clamped by the scope default",
        },
      ],
      bools: [
        {
          name: "once",
          description: "Token self-deletes on its first successful GET",
        },
      ],
    },
    {
      verb: "token revoke",
      positionals: "<attachment-id> <token-id>",
      summary: "Revokes one previously minted token by id, idempotently.",
    },
    {
      verb: "token list",
      positionals: "<attachment-id>",
      summary:
        "Lists the tokens minted against one attachment, including revoked rows.",
    },
  ],
  notes: [
    "An attachment is a typed binary file (image, PDF, audio, video, and so on) the agent has uploaded to the relay. Attachments are scoped: agent scope is reusable across the agent's apps and is the default, while app scope binds the attachment to one App and it is deleted with that App.",
    "Pages reference attachments by id, and the relay's schema validates that id with the homespun-attachment-id format. For a participant-facing URL that bypasses the agent's API key, mint a capability token with 'homespun attachment token mint'.",
    "A capability URL (/b/<token>) lets a participant, or any browser holding the URL, fetch an attachment without the agent's API key. Tokens are stored hashed on the relay and the plaintext token is returned only ONCE, from mint, so save the response before delivering the URL. The TTL defaults by scope (30 days for app scope, 24 hours for agent scope) and the caller can only shorten it.",
    "token list is for audit: it returns every token minted against the attachment, revoked rows included, each carrying token_id, token_prefix, expires_at, once, created_at, last_used_at, use_count and revoked_at. The token plaintext is never returned.",
    "delete is a soft delete and is idempotent: deleting an already-deleted attachment still returns success. Tokens minted against a deleted attachment become unusable.",
  ],
  outputNote:
    'Output is JSON on stdout, except attachment download without --out, which writes the raw bytes to stdout for piping. Errors go to stderr as {"error":{"code","message"}} with a non-zero exit.',
};

const AGENT: NounSpec = {
  noun: "agent",
  tagline: "this agent's identity on the relay",
  group: "other",
  rootSummary:
    "Agent identity on this machine: register for an API key, claim the agent for a human, save a rotated key, and clear the saved credentials.",
  verbs: [
    {
      verb: "register",
      summary:
        "Registers this agent with the relay and saves the key to a local profile.",
      flags: [
        {
          name: "name",
          value: "<name>",
          description:
            "Agent display name on the relay, shown on the approval screen",
        },
        {
          name: "secret",
          value: "<secret>",
          description:
            "Registration secret sent as a Bearer token, for relays using REGISTRATION_MODE=secret",
        },
      ],
      bools: [
        {
          name: "print-key",
          description: "Also echo the full api_key in the output",
        },
        {
          name: "no-device",
          description:
            "Skip the browser approval and register directly via POST /v1/register",
        },
      ],
    },
    {
      verb: "claim",
      positionals: "<code>",
      summary:
        "Binds this agent to the human who issued the one-shot claim code.",
    },
    {
      verb: "set-key",
      positionals: "<api-key>",
      summary: "Saves a new API key into the local config file.",
    },
    {
      verb: "logout",
      summary: "Clears a saved profile locally, without revoking anything.",
      bools: [
        {
          name: "all",
          description: "Delete every profile, meaning the whole config file",
        },
      ],
    },
  ],
  notes: [
    "register runs the browser device-authorization flow by default: it prints a link and a short code, the account owner opens the link on any device, signs in and approves, and the agent comes out already linked to that account. Older relays without the flow fall back to plain POST /v1/register automatically, as do --no-device and a supplied registration secret; agents registered that way are unowned until 'homespun agent claim' runs.",
    "The API key and relay URL are saved under a named profile in the CLI config file (mode 0600), so later commands work with only HOMESPUN_URL set, or with nothing set. The key is never printed unless --print-key is passed. Without --profile the key goes under the currently active profile, or under default on a fresh install; use --profile <name> to keep several environments side by side and switch with 'homespun config use <name>'.",
    "claim is one-way. The human generates a one-shot code (it begins with cc_) in their settings UI, hands it to the agent out of band, and the relay binds the agent to that human and migrates app ownership. There is no unclaim in v1: to rotate the owner, revoke the agent with 'homespun key revoke' and register a new one.",
    "set-key makes no relay round-trip. It is the companion to regenerating a key in the relay's my-agents UI: paste the new key here so later commands authenticate as the same agent. Setting HOMESPUN_API_KEY on the agent process instead works just as well.",
    "logout clears the active profile only, leaving the other profiles on disk and unsetting current_profile, while --all deletes the whole config file. It is idempotent, and it touches only LOCAL config: it does NOT revoke the key on the relay, which keeps working until 'homespun key revoke' retires it.",
  ],
};

// Order here is the order in `homespun --help` and in the generated reference
// page: app commands first, then the rest.
const NOUNS: NounSpec[] = [
  DEPLOY,
  APPS,
  DATA,
  MEMBERS,
  GRANTS,
  INGEST,
  KEY,
  TASTE,
  FEEDBACK,
  ATTACHMENT,
  AGENT,
  CONFIG,
  SKILL,
];

/** Every noun, in display order. */
export function allNouns(): NounSpec[] {
  return NOUNS.map((n) => ({ ...n }));
}

/** Look up one noun, or undefined if the name is not a command. */
export function nounSpec(noun: string): NounSpec | undefined {
  return NOUNS.find((n) => n.noun === noun);
}

/**
 * The argument triple for assertKnownFlags(args, ...specFor("apps", "watch")).
 * Throws on an unknown noun or verb, which is a programming error: it means a
 * runner exists that this table does not describe.
 */
export function specFor(noun: string, verb = ""): [string[], string[], string] {
  const n = nounSpec(noun);
  if (!n) throw new Error(`help-catalog: no such noun "${noun}"`);
  const v = n.verbs.find((x) => x.verb === verb);
  if (!v) {
    throw new Error(`help-catalog: noun "${noun}" has no verb "${verb}"`);
  }
  return [
    (v.flags ?? []).map((f) => f.name),
    (v.bools ?? []).map((f) => f.name),
    ["homespun", noun, verb].filter(Boolean).join(" "),
  ];
}

/**
 * "homespun apps watch <app> [--since <cursor>] [--once]", and for a verbLast
 * noun "homespun data <app> <collection> get <key>".
 */
export function usageLine(noun: NounSpec, v: VerbSpec): string {
  const parts = ["homespun", noun.noun];
  if (noun.verbLast) {
    // Common positionals precede the verb, per the parser's grammar; the verb's
    // own positionals (if any) follow it.
    if (noun.commonPositionals) parts.push(noun.commonPositionals);
    if (v.verb) parts.push(v.verb);
    if (v.positionals) parts.push(v.positionals);
  } else {
    if (v.verb) parts.push(v.verb);
    if (v.positionals) parts.push(v.positionals);
  }
  for (const f of v.flags ?? []) {
    parts.push(f.value ? `[--${f.name} ${f.value}]` : `[--${f.name}]`);
  }
  for (const b of v.bools ?? []) parts.push(`[--${b.name}]`);
  return parts.join(" ");
}

/** Wrap a paragraph to `width`, indenting continuation lines by `indent`. */
function wrap(text: string, width: number, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out.map((l, i) => (i === 0 ? l : indent + l));
}

/**
 * Split a usage line into wrappable chunks, treating a bracket group as one
 * atom. Brackets nest, e.g. `[--collection <name[,name2,...]>]`, so this
 * tracks depth rather than matching to the first `]`.
 */
function usageChunks(line: string): string[] {
  const chunks: string[] = [];
  let cur = "";
  let depth = 0;
  for (const ch of line) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (ch === " " && depth === 0) {
      if (cur !== "") chunks.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur !== "") chunks.push(cur);
  return chunks;
}

/** The text printed by `homespun --help`. */
export function renderRootHelp(): string {
  const out: string[] = [
    "homespun: apps your AI builds and hosts for you and people you invite",
    "",
    "Usage:",
    "  homespun <command> [options]",
    "",
  ];
  const blocks: [string, "app" | "other"][] = [
    ["App commands (operate on an App, a persistent deployed web app):", "app"],
    ["Other noun groups:", "other"],
  ];
  for (const [title, group] of blocks) {
    out.push(title);
    for (const n of NOUNS.filter((x) => x.group === group)) {
      const pad = n.noun.padEnd(16);
      const lines = wrap(n.rootSummary, 60, " ".repeat(20));
      out.push(`  ${pad}  ${lines[0]}`);
      for (const l of lines.slice(1)) out.push(l);
    }
    out.push("");
  }
  out.push(
    "Run `homespun <command> --help` for command-specific options.",
    "",
    "Config:",
    "  HOMESPUN_URL          Relay base URL.        Override: --url <url>",
    "  HOMESPUN_API_KEY      Agent API key.         Override: --api-key <key>",
    "  HOMESPUN_PROFILE      Active profile name.   Override: --profile <name>",
    "  'homespun agent register' provisions the API key and saves it (with the URL)",
    "  to ${XDG_CONFIG_HOME:-~/.config}/homespun/config.json under a named profile,",
    "  after which commands need no env vars. Manage multiple environments with",
    "  'homespun config list / use / add / rm'.",
    "",
    "Global flags:",
    "  -h, --help        Show help.",
    "  -v, --version     Print version.",
    "  --profile <name>  Pick a saved profile for this invocation.",
    "  --url <url>       Relay base URL, bypasses profile selection entirely.",
    "  --api-key <key>   Agent API key, bypasses profile selection entirely.",
    "",
    ...wrap(DEFAULT_OUTPUT_NOTE, 78, ""),
  );
  return out.join("\n");
}

/** The text printed by `homespun <noun> --help`. */
export function renderNounHelp(noun: NounSpec): string {
  const WIDTH = 78;
  const out: string[] = [
    `homespun ${noun.noun}: ${noun.tagline}`,
    "",
    "Usage:",
  ];
  for (const v of noun.verbs) {
    // Usage lines are wrapped with a hanging indent so a verb with many flags
    // stays readable in an 80-column terminal. Bracket groups are atomic:
    // breaking "[--timezone <IANA zone>]" across two lines reads as two
    // separate options, which is worse than a slightly long line.
    const chunks = usageChunks(usageLine(noun, v));
    const lines: string[] = [];
    let line = "  ";
    for (const chunk of chunks) {
      const candidate =
        line.trimEnd() === "" ? line + chunk : `${line} ${chunk}`;
      if (candidate.length > WIDTH && line.trim() !== "") {
        lines.push(line);
        line = "    " + chunk;
      } else {
        line = candidate;
      }
    }
    if (line.trim() !== "") lines.push(line);
    out.push(...lines);
  }
  for (const note of noun.notes ?? []) {
    out.push("", ...wrap(note, WIDTH, ""));
  }

  const flagged = noun.verbs.filter(
    (v) => (v.flags ?? []).length > 0 || (v.bools ?? []).length > 0,
  );
  if (flagged.length > 0) {
    out.push("", "Flags:");
    // One description column across the whole noun, so the flags read as a
    // table rather than ragged pairs.
    const spelled = (f: FlagSpec) =>
      f.value ? `--${f.name} ${f.value}` : `--${f.name}`;
    const all = flagged.flatMap((v) => [
      ...(v.flags ?? []),
      ...(v.bools ?? []),
    ]);
    const col = Math.min(
      34,
      all.reduce((w, f) => Math.max(w, spelled(f).length), 0) + 2,
    );
    for (const v of flagged) {
      // Verb-last nouns (data) must show <app> <collection> before the verb
      // here too, matching the Usage block and the parser. A bare
      // "homespun data list" header is the exact verb-first shape #907 fixed.
      const header = noun.verbLast
        ? ["homespun", noun.noun, noun.commonPositionals, v.verb]
            .filter(Boolean)
            .join(" ")
        : ["homespun", noun.noun, v.verb].filter(Boolean).join(" ");
      out.push(`  ${header}`);
      for (const f of [...(v.flags ?? []), ...(v.bools ?? [])]) {
        const left = `    ${spelled(f)}`;
        const pad = Math.max(1, col + 4 - left.length);
        const indent = " ".repeat(col + 5);
        const desc = wrap(f.description, WIDTH - col - 5, indent);
        out.push(left + " ".repeat(pad) + desc[0]);
        for (const l of desc.slice(1)) out.push(l);
      }
    }
  }
  out.push("", ...wrap(noun.outputNote ?? DEFAULT_OUTPUT_NOTE, WIDTH, ""));
  return out.join("\n");
}
