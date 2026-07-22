// `homespun ingest`: inbound catch-hook read surface for an app (inbound-webhooks
// PR 3). List the app's declared hooks with their full secret URL, and rotate a
// hook's secret. Every verb targets an app via a required `--app <idOrSlug>`,
// resolved the same way `homespun members`/`homespun data` do (resolveAppId).
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
    fail("missing verb (homespun ingest <list|rotate>)", "invalid_args");
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
    default:
      fail(
        `unknown verb '${verb}' (homespun ingest <list|rotate>)`,
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
