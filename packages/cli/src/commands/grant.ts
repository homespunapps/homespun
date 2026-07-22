// `homespun grants` (M5) grant-link management for a v2 app: mint a
// capability URL that confers a DECLARED custom role on a stable, per-holder
// anonymous identity, list an app's grant links, and revoke one. Every verb
// targets an app via a required `--app <idOrSlug>` flag, resolved the same way
// `homespun members`/`homespun data` do (resolveAppId).
//
// Auth on the relay side is owner-or-agent; this CLI always authenticates as
// the owning agent, so any verb works for an app the calling agent's owning
// human owns.
//
// A grant link NEVER escalates: --role must be a DECLARED custom role
// (x-homespun-manifest.roles), never a built-in role (owner/member/agent). The
// minted grant_url carries the raw token in its #g= fragment and is printed
// ONCE (it is never recoverable afterward).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveAppId } from "../resolve-app.js";
import type { ListWhereCondition } from "@homespunapps/core";

export async function runGrant(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("grants")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail("missing verb: homespun grants <mint|list|revoke>", "invalid_args");
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
    case "mint":
      return runMint(sub);
    case "list":
      return runList(sub);
    case "revoke":
      return runRevoke(sub);
    default:
      fail(
        `unknown verb '${verb}' (homespun grants <mint|list|revoke>)`,
        "invalid_args",
      );
  }
}

function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`${flag} must be a positive integer`, "invalid_args");
  }
  return n;
}

// ---------------------------------------------------------------------------
// mint
// ---------------------------------------------------------------------------

async function runMint(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("grants", "mint"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail(
      "usage: homespun grants mint --app <idOrSlug> --role <customRole>",
      "invalid_args",
    );
  }
  const role = args.flags.get("role");
  if (!role) {
    fail("--role is required", "invalid_args");
  }
  const mode = args.flags.get("mode");
  if (mode !== undefined && mode !== "once" && mode !== "multi") {
    fail('--mode must be "once" or "multi"', "invalid_args");
  }
  const pinRow = args.flags.get("pin-row");
  const pinWhereRaw = args.flags.get("pin-where");
  if (pinRow !== undefined && pinWhereRaw !== undefined) {
    fail("--pin-row and --pin-where are mutually exclusive", "invalid_args");
  }
  let pin: { rowKey: string } | { where: ListWhereCondition[] } | undefined;
  if (pinRow !== undefined) {
    pin = { rowKey: pinRow };
  } else if (pinWhereRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pinWhereRaw);
    } catch {
      fail("--pin-where must be a JSON array of conditions", "invalid_args");
    }
    if (!Array.isArray(parsed)) {
      fail("--pin-where must be a JSON array of conditions", "invalid_args");
    }
    pin = { where: parsed as ListWhereCondition[] };
  }
  const maxUsesRaw = args.flags.get("max-uses");
  const ttlRaw = args.flags.get("ttl");
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(
      await client.mintAppGrant(appId, {
        role: role!,
        ...(mode !== undefined ? { mode: mode as "once" | "multi" } : {}),
        ...(maxUsesRaw !== undefined
          ? { maxUses: parsePositiveInt(maxUsesRaw, "--max-uses") }
          : {}),
        ...(args.flags.get("label") !== undefined
          ? { label: args.flags.get("label")! }
          : {}),
        ...(ttlRaw !== undefined
          ? { ttlSeconds: parsePositiveInt(ttlRaw, "--ttl") }
          : {}),
        ...(pin !== undefined ? { pin } : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("grants", "list"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail("usage: homespun grants list --app <idOrSlug>", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.listAppGrants(appId));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

async function runRevoke(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("grants", "revoke"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail(
      "usage: homespun grants revoke --app <idOrSlug> --grant <grantId>",
      "invalid_args",
    );
  }
  const grantId = args.flags.get("grant");
  if (!grantId) {
    fail("--grant is required", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    await client.revokeAppGrant(appId, grantId!);
    printJson({ revoked: true, app_id: appId, grant_id: grantId });
  } catch (e) {
    failFromError(e);
  }
}
