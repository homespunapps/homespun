// `homespun ingest`: inbound catch-hook read surface for an app (inbound-webhooks
// PR 3). List the app's declared hooks with their full secret URL, rotate a
// hook's secret, manage its opt-in signing secret, and backfill historical
// payloads through a hook's mapping (issue #966). Every verb targets an app via a
// required `--app <idOrSlug>`, resolved the same way `homespun members`/`homespun
// data` do (resolveAppId).
//
// This is the smallest surface an agent needs during app setup: after deploying
// a manifest that declares an `ingest` hook, the agent runs `homespun ingest list`
// to read back the exact URL and tells its owner to paste it into Stripe/Zapier/
// Home Assistant/etc. Hooks are manifest-declared, so there is no create/delete
// here; `rotate` re-keys a leaked URL without a redeploy.
//
// Auth on the relay side is owner-or-agent (the owning agent's API key OR the
// owner human's login cookie); this CLI always authenticates as the agent, so
// both verbs work for an app the calling agent's owning human owns.

import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveAppId } from "../resolve-app.js";

export async function runIngest(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("ingest")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb (homespun ingest <list|rotate|signing-secret|backfill>)",
      "invalid_args",
    );
  }

  const sub: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    bools: args.bools,
    ...(args.danglingValueFlags !== undefined
      ? { danglingValueFlags: args.danglingValueFlags }
      : {}),
  };

  switch (verb) {
    case "list":
      return runList(sub);
    case "rotate":
      return runRotate(sub);
    case "signing-secret":
      return runSigningSecret(sub);
    case "backfill":
      return runBackfill(sub);
    default:
      fail(
        `unknown verb '${verb}' (homespun ingest <list|rotate|signing-secret|backfill>)`,
        "invalid_args",
      );
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("ingest", "list"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail("usage: homespun ingest list --app <idOrSlug>", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.listIngestHooks(appId));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------

async function runRotate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("ingest", "rotate"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail(
      "usage: homespun ingest rotate --app <idOrSlug> --name <hookName>",
      "invalid_args",
    );
  }
  const name = args.flags.get("name");
  if (!name) {
    fail("--name is required", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.rotateIngestHook(appId, name!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// signing-secret set|clear
// ---------------------------------------------------------------------------
//
// The SIGNING secret is separate from the URL secret above (opt-in webhook
// signature verification, issue #935, shipped dark: nothing verifies a
// signature yet). `set` without --secret MINTS one and prints it ONCE (the
// GitHub path); `set --secret <val>` stores a provider-generated value verbatim
// (the Stripe path) and never echoes it; `clear` removes it.

async function runSigningSecret(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0];
  const sub: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    bools: args.bools,
    ...(args.danglingValueFlags !== undefined
      ? { danglingValueFlags: args.danglingValueFlags }
      : {}),
  };
  switch (action) {
    case "set":
      return runSigningSecretSet(sub);
    case "clear":
      return runSigningSecretClear(sub);
    default:
      fail(
        "usage: homespun ingest signing-secret <set|clear> --app <idOrSlug> --name <hookName>",
        "invalid_args",
      );
  }
}

async function runSigningSecretSet(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("ingest", "signing-secret"));
  const appArg = args.flags.get("app");
  const name = args.flags.get("name");
  if (!appArg || !name) {
    fail(
      "usage: homespun ingest signing-secret set --app <idOrSlug> --name <hookName> [--secret <value>] [--grace-seconds <n>]",
      "invalid_args",
    );
  }
  const secret = args.flags.get("secret");
  const graceRaw = args.flags.get("grace-seconds");
  let graceSeconds: number | undefined;
  if (graceRaw !== undefined) {
    graceSeconds = Number(graceRaw);
    if (!Number.isFinite(graceSeconds)) {
      fail("--grace-seconds must be a number", "invalid_args");
    }
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    const res = await client.setIngestSigningSecret(appId, name!, {
      ...(secret !== undefined ? { secret } : {}),
      ...(graceSeconds !== undefined ? { graceSeconds } : {}),
    });
    printJson(res);
    if (res.secret !== undefined) {
      process.stderr.write(
        "Store this signing secret now: it will not be shown again. Paste it into the provider's webhook settings.\n",
      );
    }
  } catch (e) {
    failFromError(e);
  }
}

async function runSigningSecretClear(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("ingest", "signing-secret"));
  const appArg = args.flags.get("app");
  const name = args.flags.get("name");
  if (!appArg || !name) {
    fail(
      "usage: homespun ingest signing-secret clear --app <idOrSlug> --name <hookName>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.clearIngestSigningSecret(appId, name!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// backfill
// ---------------------------------------------------------------------------
//
// Bulk-load historical raw provider bodies through a hook's mapping (issue
// #966), so a seeded app's rows are byte-identical to live deliveries. Reads a
// JSON-array OR NDJSON file of raw payloads (each a whole provider body, any JSON
// value, not necessarily an object), chunks it into <= --chunk bodies per call,
// and prints aggregate { accepted, dropped_duplicate, failed } counts. Re-running
// the same file is idempotent for a body-path dedupeKey (the relay dedupes).

// The relay's INGEST_BACKFILL_MAX_BODIES default; a larger --chunk is rejected
// server-side (400), so the CLI keeps the conservative default and lets the
// chunker split the whole file across as many calls as needed.
const DEFAULT_BACKFILL_CHUNK = 500;

/**
 * Parse a backfill file into an ordered list of raw provider bodies. Accepts
 * either a single JSON array (the whole file parses as an array) or NDJSON (one
 * JSON value per non-blank line). Unlike a row import, an entry may be ANY JSON
 * value (object, array, string, number): it is a raw provider payload, mapped
 * server-side. A malformed line reports its 1-based line number.
 */
function parseBackfillBodies(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  // JSON array form: the entire file is one array literal.
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      fail(
        `--file is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
        "invalid_args",
      );
    }
    if (!Array.isArray(parsed)) {
      fail(
        "--file top-level JSON must be an array of payloads",
        "invalid_args",
      );
    }
    return parsed as unknown[];
  }
  // NDJSON form: one JSON value per non-blank line.
  const out: unknown[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      fail(
        `--file line ${i + 1} is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
        "invalid_args",
      );
    }
  }
  return out;
}

async function runBackfill(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("ingest", "backfill"));
  const appArg = args.flags.get("app");
  const name = args.flags.get("name");
  const file = args.flags.get("file");
  if (!appArg || !name || !file) {
    fail(
      "usage: homespun ingest backfill --app <idOrSlug> --name <hookName> --file <path> [--chunk <n>]",
      "invalid_args",
    );
  }

  let raw: string;
  try {
    raw = readFileSync(file!, "utf8");
  } catch (e) {
    fail(
      `cannot read --file '${file}': ${e instanceof Error ? e.message : String(e)}`,
      "invalid_args",
    );
  }
  const bodies = parseBackfillBodies(raw!);
  if (bodies.length === 0) {
    fail("--file contained no payloads to backfill", "invalid_args");
  }

  let chunkSize = DEFAULT_BACKFILL_CHUNK;
  const chunkRaw = args.flags.get("chunk");
  if (chunkRaw !== undefined) {
    chunkSize = Number(chunkRaw);
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      fail("--chunk must be a positive integer", "invalid_args");
    }
  }

  const client = makeClient(args);
  // resolveAppId ONCE for the whole backfill (not per chunk): the app id is
  // stable for the process, so one lookup drives every call.
  const appId = await resolveAppId(client, appArg!);

  const total = bodies.length;
  const chunkCount = Math.ceil(total / chunkSize);
  let accepted = 0;
  let droppedDuplicate = 0;
  let failed = 0;

  try {
    for (
      let start = 0, chunkNo = 1;
      start < total;
      start += chunkSize, chunkNo++
    ) {
      const chunk = bodies.slice(start, start + chunkSize);
      const res = await client.backfillIngestHook(appId, name!, chunk);
      accepted += res.accepted;
      droppedDuplicate += res.dropped_duplicate;
      failed += res.failed;
      // Human-readable progress on stderr so stdout stays a single JSON summary.
      process.stderr.write(
        `backfilled ${accepted + droppedDuplicate + failed}/${total} (chunk ${chunkNo}/${chunkCount}, ${accepted} accepted, ${droppedDuplicate} dropped_duplicate, ${failed} failed)\n`,
      );
    }
  } catch (e) {
    failFromError(e);
  }

  printJson({
    app: appId,
    hook: name,
    total,
    accepted,
    dropped_duplicate: droppedDuplicate,
    failed,
    chunks: chunkCount,
  });
}
