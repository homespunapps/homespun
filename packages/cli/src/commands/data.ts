// `homespun data` — collection row CRUD for a v2 app (spec-cli §3.3). Mirrors
// `homespun records` (v1 app collections) but against `/v1/apps/:id/collections`
// and with a dedicated per-row GET (no client-side scan — spec-cli §8 ruling
// 3 confirms the relay route is real).

import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveJson } from "../input.js";
import { resolveAppId } from "../resolve-app.js";
import type {
  BatchRowInput,
  BatchResult,
  ListWhereCondition,
  ListSortSpec,
} from "@homespunapps/core";

export async function runData(args: ParsedArgs): Promise<void> {
  const appArg = args.positionals[0];
  const collection = args.positionals[1];
  const verb = args.positionals[2];

  if ((appArg === undefined || verb === undefined) && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("data")!) + "\n");
    return;
  }
  if (!appArg || !collection || !verb) {
    fail(
      "usage: homespun data <app> <collection> <list|get|upsert|update|delete|purge|import|retention>",
      "invalid_args",
    );
  }

  const sub: ParsedArgs = {
    positionals: args.positionals.slice(3),
    flags: args.flags,
    bools: args.bools,
    ...(args.danglingValueFlags !== undefined
      ? { danglingValueFlags: args.danglingValueFlags }
      : {}),
  };

  switch (verb) {
    case "list":
      return runList(appArg!, collection!, sub);
    case "get":
      return runGet(appArg!, collection!, sub);
    case "upsert":
      return runUpsert(appArg!, collection!, sub);
    case "update":
      return runUpdate(appArg!, collection!, sub);
    case "delete":
      return runDelete(appArg!, collection!, sub);
    case "purge":
      return runPurge(appArg!, collection!, sub);
    case "import":
      return runImport(appArg!, collection!, sub);
    case "retention":
      return runRetention(appArg!, collection!, sub);
    default:
      fail(
        `unknown verb '${verb}': homespun data <app> <collection> <list|get|upsert|update|delete|purge|import|retention>`,
        "invalid_args",
      );
  }
}

function parseIntFlag(
  args: ParsedArgs,
  name: string,
  defaultValue: number | undefined,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n))
    fail(`--${name} must be an integer`, "invalid_args");
  if (bounds.min !== undefined && n < bounds.min) {
    fail(`--${name} must be >= ${bounds.min}`, "invalid_args");
  }
  if (bounds.max !== undefined && n > bounds.max) {
    fail(`--${name} must be <= ${bounds.max}`, "invalid_args");
  }
  return n;
}

async function runList(
  appArg: string,
  collection: string,
  args: ParsedArgs,
): Promise<void> {
  assertKnownFlags(args, ...specFor("data", "list"));
  const since = args.flags.get("since");
  const limit = parseIntFlag(args, "limit", undefined, { min: 1, max: 1000 });
  const where = parseJsonArrayFlag<ListWhereCondition>(args, "where");
  const sort = parseJsonArrayFlag<ListSortSpec>(args, "sort");
  if (since !== undefined && sort !== undefined) {
    fail(
      "--since (cursor pagination) cannot be combined with --sort",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    printJson(
      await client.listAppRows(appId, collection, {
        since,
        ...(limit !== undefined ? { limit } : {}),
        ...(where !== undefined ? { where } : {}),
        ...(sort !== undefined ? { sort } : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// Parse a `--<name> <json>` flag whose value must be a JSON array. Returns
// undefined when the flag is absent; fails cleanly (invalid_args) when present
// but not a JSON array. Element-level validation is left to the relay, which
// returns a precise 400 the CLI surfaces verbatim.
function parseJsonArrayFlag<T>(
  args: ParsedArgs,
  name: string,
): T[] | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    fail(
      `--${name} must be valid JSON (${e instanceof Error ? e.message : String(e)})`,
      "invalid_args",
    );
  }
  if (!Array.isArray(parsed)) {
    fail(`--${name} must be a JSON array`, "invalid_args");
  }
  return parsed as T[];
}

async function runGet(
  appArg: string,
  collection: string,
  args: ParsedArgs,
): Promise<void> {
  assertKnownFlags(args, ...specFor("data", "get"));
  const key = args.positionals[0];
  if (!key) {
    fail("usage: homespun data <app> <collection> get <key>", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    printJson(await client.getAppRow(appId, collection, key!));
  } catch (e) {
    failFromError(e);
  }
}

async function runUpsert(
  appArg: string,
  collection: string,
  args: ParsedArgs,
): Promise<void> {
  assertKnownFlags(args, ...specFor("data", "upsert"));
  const dataRaw = args.flags.get("data");
  if (dataRaw === undefined) {
    fail(
      "--data is required (path to JSON file, or inline JSON)",
      "invalid_args",
    );
  }
  const data = resolveJson(dataRaw!, "--data");
  const key = args.flags.get("key");
  const on = args.flags.get("on");
  if (key !== undefined && on !== undefined) {
    fail(
      "--key and --on are mutually exclusive (upsert by key, or by a unique field, not both)",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    const body: { key?: string; data: unknown; on?: string } = { data };
    if (key !== undefined) body.key = key;
    if (on !== undefined) body.on = on;
    printJson(await client.upsertAppRow(appId, collection, body));
  } catch (e) {
    failFromError(e);
  }
}

async function runUpdate(
  appArg: string,
  collection: string,
  args: ParsedArgs,
): Promise<void> {
  assertKnownFlags(args, ...specFor("data", "update"));
  const key = args.positionals[0];
  if (!key) {
    fail(
      "usage: homespun data <app> <collection> update <key> --data <path|json>",
      "invalid_args",
    );
  }
  const dataRaw = args.flags.get("data");
  if (dataRaw === undefined) {
    fail(
      "--data is required (path to JSON file, or inline JSON)",
      "invalid_args",
    );
  }
  const data = resolveJson(dataRaw!, "--data");
  const ifMatch = parseIntFlag(args, "if-match", undefined, { min: 0 });
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    const body: { data: unknown; if_match?: number } = { data };
    if (ifMatch !== undefined) body.if_match = ifMatch;
    printJson(await client.updateAppRow(appId, collection, key!, body));
  } catch (e) {
    failFromError(e);
  }
}

async function runDelete(
  appArg: string,
  collection: string,
  args: ParsedArgs,
): Promise<void> {
  assertKnownFlags(args, ...specFor("data", "delete"));
  const key = args.positionals[0];
  if (!key) {
    fail(
      "usage: homespun data <app> <collection> delete <key>",
      "invalid_args",
    );
  }
  const ifMatch = parseIntFlag(args, "if-match", undefined, { min: 0 });
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    await client.deleteAppRow(appId, collection, key!, {
      ...(ifMatch !== undefined ? { ifMatch } : {}),
    });
    printJson({ deleted: true, key });
  } catch (e) {
    failFromError(e);
  }
}

// `homespun data <app> <coll> purge --key <key>`, owner/agent-only removal that
// bypasses an append-only collection (Wave C1). The row key comes from --key
// (not a positional) so a purge reads deliberately, harder to fire by accident.
async function runPurge(
  appArg: string,
  collection: string,
  args: ParsedArgs,
): Promise<void> {
  assertKnownFlags(args, ...specFor("data", "purge"));
  const key = args.flags.get("key");
  if (!key) {
    fail(
      "usage: homespun data <app> <collection> purge --key <key>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    await client.purgeAppRow(appId, collection, key!);
    printJson({ purged: true, key });
  } catch (e) {
    failFromError(e);
  }
}

// Default per-batch chunk size (matches the relay's BATCH_MAX_ROWS default). A
// larger --chunk is capped server-side (a batch over the cap 400s), so the CLI
// keeps a conservative default and lets an operator raise it if their tier does.
const DEFAULT_IMPORT_CHUNK = 100;

/**
 * Parse an import file into an ordered list of raw row objects. Accepts either a
 * single JSON array (the whole file parses as an array) or NDJSON (one JSON
 * object per non-blank line). A malformed line reports its 1-based line number.
 */
function parseImportRows(raw: string): Record<string, unknown>[] {
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
      fail("--file top-level JSON must be an array of objects", "invalid_args");
    }
    return (parsed as unknown[]).map((el, i) => asRowObject(el, i + 1));
  }
  // NDJSON form: one JSON object per non-blank line.
  const out: Record<string, unknown>[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      fail(
        `--file line ${i + 1} is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
        "invalid_args",
      );
    }
    out.push(asRowObject(parsed, i + 1));
  }
  return out;
}

function asRowObject(value: unknown, where: number): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(
      `--file entry ${where} must be a JSON object (got ${Array.isArray(value) ? "array" : typeof value})`,
      "invalid_args",
    );
  }
  return value as Record<string, unknown>;
}

async function runImport(
  appArg: string,
  collection: string,
  args: ParsedArgs,
): Promise<void> {
  assertKnownFlags(args, ...specFor("data", "import"));
  const file = args.flags.get("file");
  if (file === undefined) {
    fail(
      "--file is required (path to an NDJSON or JSON-array file)",
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
  const objects = parseImportRows(raw!);
  if (objects.length === 0) {
    fail("--file contained no rows to import", "invalid_args");
  }

  const chunkSize = parseIntFlag(args, "chunk", DEFAULT_IMPORT_CHUNK, {
    min: 1,
    max: 1000,
  })!;
  const keyField = args.flags.get("key-field");
  const on = args.flags.get("on");
  const emitEffects = args.bools.has("emit-effects");
  if (keyField !== undefined && on !== undefined) {
    fail(
      "--key-field and --on are mutually exclusive (derive the row key from a field, or upsert on a unique field, not both)",
      "invalid_args",
    );
  }

  // Build the batch inputs once: each object is a row's `data`; --key-field pulls
  // the row key from a field (create-or-skip-by-id on re-import), while --on
  // upserts on a declared-unique field (update-in-place on re-import).
  const rows: BatchRowInput[] = objects.map((obj) => {
    if (keyField === undefined) return { data: obj };
    const kv = obj[keyField];
    if (
      kv === undefined ||
      kv === null ||
      (typeof kv !== "string" && typeof kv !== "number")
    ) {
      fail(
        `--key-field '${keyField}' missing or not a string/number in an input row`,
        "invalid_args",
      );
    }
    const key = String(kv);
    if (key.length === 0) {
      fail(
        `--key-field '${keyField}' is empty in an input row`,
        "invalid_args",
      );
    }
    return { key, data: obj };
  });

  const client = makeClient(args);
  // resolveAppId ONCE for the whole import (not per chunk / per row): the app id
  // is stable for the process, so one lookup drives every batch call.
  const appId = await resolveAppId(client, appArg);

  const total = rows.length;
  const chunkCount = Math.ceil(total / chunkSize);
  let imported = 0;
  let failed = 0;
  const failures: Array<{ index: number; key?: string; error: unknown }> = [];

  try {
    for (
      let start = 0, chunkNo = 1;
      start < total;
      start += chunkSize, chunkNo++
    ) {
      const chunk = rows.slice(start, start + chunkSize);
      const res: BatchResult = await client.batchRows(
        appId,
        collection,
        chunk,
        {
          ...(emitEffects ? { emitEffects: true } : {}),
          ...(on !== undefined ? { on } : {}),
        },
      );
      for (const r of res.results) {
        // Translate the per-chunk index back to the GLOBAL row index.
        const globalIndex = start + r.index;
        if (r.ok) {
          imported += 1;
        } else {
          failed += 1;
          failures.push({
            index: globalIndex,
            ...(r.key !== undefined ? { key: r.key } : {}),
            error: r.error,
          });
        }
      }
      // Human-readable progress on stderr so stdout stays a single JSON summary.
      process.stderr.write(
        `imported ${imported}/${total} (chunk ${chunkNo}/${chunkCount}, ${failed} failed)\n`,
      );
    }
  } catch (e) {
    failFromError(e);
  }

  printJson({
    app: appId,
    collection,
    total,
    imported,
    failed,
    chunks: chunkCount,
    silent: !emitEffects,
    failures,
  });
}

// `homespun data <app> <collection> retention` (issue #956): show or change the
// OWNER retention override on a collection. With no set/clear flag (or --show) it
// reads the current effective retention; otherwise it sets an axis
// (--max-rows/--max-age-days) or clears one (--clear-rows/--clear-age, reverting
// that axis to the author default). Effective retention is per-axis
// `override ?? authorDefault`. Prints the effective bounds and the would-prune
// count either way.
async function runRetention(
  appArg: string,
  collection: string,
  args: ParsedArgs,
): Promise<void> {
  assertKnownFlags(args, ...specFor("data", "retention"));
  const clearRows = args.bools.has("clear-rows");
  const clearAge = args.bools.has("clear-age");
  const maxRows = parseIntFlag(args, "max-rows", undefined, { min: 1 });
  const maxAgeDays = parseIntFlag(args, "max-age-days", undefined, { min: 1 });

  if (clearRows && maxRows !== undefined) {
    fail("--clear-rows cannot be combined with --max-rows", "invalid_args");
  }
  if (clearAge && maxAgeDays !== undefined) {
    fail("--clear-age cannot be combined with --max-age-days", "invalid_args");
  }

  // Build the per-axis patch: a number sets the axis, null clears it, an omitted
  // axis is left unchanged. `--show` (or no set/clear flag) reads without writing.
  const patch: { maxRows?: number | null; maxAgeDays?: number | null } = {};
  if (clearRows) patch.maxRows = null;
  else if (maxRows !== undefined) patch.maxRows = maxRows;
  if (clearAge) patch.maxAgeDays = null;
  else if (maxAgeDays !== undefined) patch.maxAgeDays = maxAgeDays;

  const willWrite =
    patch.maxRows !== undefined || patch.maxAgeDays !== undefined;

  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    printJson(
      willWrite
        ? await client.setCollectionRetention(appId, collection, patch)
        : await client.getCollectionRetention(appId, collection),
    );
  } catch (e) {
    failFromError(e);
  }
}
