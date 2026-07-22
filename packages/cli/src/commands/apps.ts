// `homespun apps` — v2 app lifecycle management (spec-cli §3.2): list / show /
// update / delete / wake, plus `watch` (spec-cli §3.4).
//
// Naming note (deviation from spec-cli's literal top-level `homespun watch`):
// this branch still carries the UNCHANGED v1 `homespun watch <homespun-id>` command
// (packages/cli/src/commands/watch.ts) — v2's schema/routes are additive
// during this expand/contract migration (spec-schema §6 sequencing note),
// and the v1 command's existing tests must keep passing. Reusing the bare
// `watch` noun for a different resource (App vs. Homespun) would silently break
// it. `homespun apps watch <app>` gets the identical behavior spec-cli §3.4
// describes, nested under the noun that already owns every other v2 app
// lifecycle verb; the noun collision is resolved (not worked around) at the
// v1-removal cutover PR, where `homespun watch`/`homespun share` are freed up for v2
// to reclaim verbatim.

import {
  HomespunApiError,
  appWsUrlFromAppUrl,
  openAppStream,
} from "@homespunapps/core";
import type { AppFeedEntry } from "@homespunapps/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient, resolveConfig } from "../config.js";
import { fail, failFromError, printJson, printJsonLine } from "../output.js";
import { resolveAppId } from "../resolve-app.js";

export async function runApps(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("apps")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb: homespun apps <list|show|update|share-link|delete|wake|watch>",
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
    case "show":
      return runShow(sub);
    case "update":
      return runUpdate(sub);
    case "share-link":
      return runShareLink(sub);
    case "delete":
      return runDelete(sub);
    case "wake":
      return runWake(sub);
    case "watch":
      return runWatch(sub);
    default:
      fail(
        `unknown verb '${verb}': homespun apps <list|show|update|share-link|delete|wake|watch>`,
        "invalid_args",
      );
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("apps", "list"));
  const status = args.flags.get("status") as
    | "active"
    | "dormant"
    | "archived"
    | "all"
    | undefined;
  if (
    status !== undefined &&
    !["active", "dormant", "archived", "all"].includes(status)
  ) {
    fail("--status must be active|dormant|archived|all", "invalid_args");
  }
  const limitRaw = args.flags.get("limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && !Number.isInteger(limit)) {
    fail("--limit must be an integer", "invalid_args");
  }

  const client = makeClient(args);
  try {
    const page = await client.listApps({
      status,
      limit,
      cursor: args.flags.get("cursor"),
      slug: args.flags.get("slug"),
    });
    printJson(page);
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function runShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("apps", "show"));
  const appArg = args.positionals[0];
  if (!appArg) fail("usage: homespun apps show <app>", "invalid_args");
  const client = makeClient(args);
  const id = await resolveAppId(client, appArg!);
  try {
    printJson(await client.getApp(id));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function runUpdate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("apps", "update"));
  const appArg = args.positionals[0];
  if (!appArg) {
    fail(
      "usage: homespun apps update <app> [--visibility <private|link|public>] [--timezone <IANA zone>]",
      "invalid_args",
    );
  }
  const visibility = args.flags.get("visibility");
  const timezone = args.flags.get("timezone");
  if (visibility === undefined && timezone === undefined) {
    fail(
      "nothing to update; pass --visibility and/or --timezone",
      "invalid_args",
    );
  }
  if (
    visibility !== undefined &&
    !["private", "link", "public"].includes(visibility)
  ) {
    fail("--visibility must be private|link|public", "invalid_args");
  }
  if (timezone !== undefined && timezone.trim() === "") {
    fail(
      "--timezone must be an IANA zone name, e.g. Europe/Berlin",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const id = await resolveAppId(client, appArg!);
  try {
    printJson(
      await client.updateApp(id, {
        ...(visibility !== undefined
          ? { visibility: visibility as "private" | "link" | "public" }
          : {}),
        ...(timezone !== undefined ? { timezone } : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// share-link (rotate)
// ---------------------------------------------------------------------------

// `homespun apps share-link rotate <app>` rotates a link app's share token.
// Prints the new { share_url } (its #k= fragment carries the token, shown once).
// Rotating instantly revokes the previous share URL. Also generates a link for a
// link app that has none yet. Only `rotate` is supported (rotate-only, no
// delete): revoking a link IS rotating it.
async function runShareLink(args: ParsedArgs): Promise<void> {
  const action = args.positionals[0];
  if (action !== "rotate") {
    fail("usage: homespun apps share-link rotate <app>", "invalid_args");
  }
  assertKnownFlags(args, ...specFor("apps", "share-link"));
  const appArg = args.positionals[1];
  if (!appArg) {
    fail("usage: homespun apps share-link rotate <app>", "invalid_args");
  }
  const client = makeClient(args);
  const id = await resolveAppId(client, appArg!);
  try {
    printJson(await client.rotateShareLink(id));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function runDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("apps", "delete"));
  const appArg = args.positionals[0];
  if (!appArg)
    fail("usage: homespun apps delete <app> [--yes]", "invalid_args");
  if (!args.bools.has("yes")) {
    fail(
      "'homespun apps delete' permanently removes the app and all its data — it is destructive. Pass --yes to confirm.",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const id = await resolveAppId(client, appArg!);
  try {
    await client.deleteApp(id);
    printJson({ deleted: true, app_id: id });
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// wake
// ---------------------------------------------------------------------------

async function runWake(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("apps", "wake"));
  const appArg = args.positionals[0];
  if (!appArg) fail("usage: homespun apps wake <app>", "invalid_args");
  const client = makeClient(args);
  const id = await resolveAppId(client, appArg!);
  try {
    printJson(await client.wakeApp(id));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// watch — WS primary, long-poll fallback; identical JSON-lines either way
// ---------------------------------------------------------------------------

/**
 * The one function that turns an `AppFeedEntry` into stdout output — called
 * from BOTH the WS entry handler and the long-poll loop below, so the two
 * transports are provably byte-identical in what they print (spec-cli §5).
 * Exported for unit testing.
 */
export function printFeedEntryLine(
  entry: AppFeedEntry,
  collectionFilter: Set<string> | null,
): void {
  if (
    collectionFilter !== null &&
    !collectionFilter.has(entry.collection_name)
  ) {
    return;
  }
  printJsonLine(entry);
}

/** Parse `--collection a,b,c` into a filter set, or null when omitted. */
export function parseCollectionFilter(
  raw: string | undefined,
): Set<string> | null {
  if (raw === undefined) return null;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return new Set(names);
}

/**
 * True iff `err` is the relay's "app is dormant" 409 (assertAppActiveForData
 * on the long-poll route) — the long-poll transport's ONLY signal for the
 * same dormancy transition the WS path gets as an explicit `_dormant` frame.
 * Exported for unit testing.
 */
export function isDormantConflict(err: unknown): boolean {
  return (
    err instanceof HomespunApiError &&
    err.code === "conflict" &&
    err.message === "app is dormant"
  );
}

async function runWatch(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("apps", "watch"));
  const appArg = args.positionals[0];
  if (!appArg) fail("usage: homespun apps watch <app>", "invalid_args");

  const sinceRaw = args.flags.get("since");
  let since = 0;
  if (sinceRaw !== undefined) {
    const n = Number(sinceRaw);
    if (!Number.isInteger(n) || n < 0) {
      fail("--since must be a non-negative integer cursor", "invalid_args");
    }
    since = n;
  }
  const collectionFilter = parseCollectionFilter(args.flags.get("collection"));
  const once = args.bools.has("once");

  let timeoutSec: number | null = null;
  const timeoutRaw = args.flags.get("timeout");
  if (timeoutRaw !== undefined) {
    const t = Number(timeoutRaw);
    if (!Number.isFinite(t) || t <= 0) {
      fail("--timeout must be a positive number", "invalid_args");
    }
    timeoutSec = t;
  }

  const cfg = resolveConfig(args);
  const client = makeClient(args);

  let appId: string;
  let appUrl: string;
  try {
    appId = await resolveAppId(client, appArg!);
    appUrl = (await client.getApp(appId)).url;
  } catch (e) {
    failFromError(e);
  }

  let exited = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    if (timer) clearTimeout(timer);
    process.exit(code);
  };
  if (timeoutSec !== null) {
    timer = setTimeout(() => {
      fail(`no terminal condition met within ${timeoutSec}s`, "ws_timeout");
    }, timeoutSec * 1000);
  }

  const emitDormant = (): void => {
    printJsonLine({ type: "_dormant" });
    finish(0);
  };

  // Long-poll fallback loop (spec-cli §5) — GET /v1/apps/:id/feed?wait=25.
  // Uses the SAME printFeedEntryLine as the WS entry handler below, so a
  // caller piping `homespun apps watch` output can never tell which transport
  // served a given line.
  async function runLongPoll(startSince: number): Promise<void> {
    let cursor = startSince;
    while (!exited) {
      let page;
      try {
        page = await client.getAppFeed(appId, { since: cursor, wait: 25 });
      } catch (e) {
        if (isDormantConflict(e)) {
          emitDormant();
          return;
        }
        failFromError(e);
        return;
      }
      for (const entry of page.entries) {
        printFeedEntryLine(entry, collectionFilter);
        cursor = Math.max(cursor, entry.seq);
        if (once) {
          finish(0);
          return;
        }
      }
      cursor = Math.max(cursor, page.cursor);
    }
  }

  let wsConnected = false;
  let fellBack = false;
  const wsUrl = appWsUrlFromAppUrl(appUrl);
  const handle = openAppStream(
    { wsUrl, apiKey: cfg.apiKey, since },
    {
      onHello: () => {
        wsConnected = true;
      },
      onEntry: (entry) => {
        printFeedEntryLine(entry, collectionFilter);
        if (once) finish(0);
      },
      onDormant: () => {
        emitDormant();
      },
      onResync: () => {
        printJsonLine({ type: "resync" });
      },
      onClose: ({ code, reason }) => {
        if (exited) return;
        // If we've already fallen back (this close is very likely the
        // trailing `close` frame ~50ms behind the `error` event that
        // triggered the fallback), the long-poll loop now OWNS termination —
        // this handler must be a no-op, not call fail() and exit(1) out from
        // under the just-started long-poll (the HIGH bug this guards).
        if (fellBack) return;
        if (!wsConnected) {
          fellBack = true;
          void runLongPoll(since);
          return;
        }
        if (code === 1000 || code === 1001) {
          finish(0);
          return;
        }
        fail(
          `app stream closed abnormally (code ${code})${reason ? ": " + reason : ""}`,
          "ws_closed_abnormally",
          { code, reason },
        );
      },
      onError: () => {
        if (exited) return;
        if (fellBack) return;
        if (!wsConnected) {
          fellBack = true;
          void runLongPoll(since);
          return;
        }
        // A transport error after a successful connect — fall through to
        // the same terminal handling `onClose` would give a non-clean close.
      },
    },
  );

  process.on("SIGINT", () => {
    handle.close();
    finish(0);
  });

  await new Promise<void>(() => {
    /* never resolves — SIGINT or a terminal condition exits */
  });
}
