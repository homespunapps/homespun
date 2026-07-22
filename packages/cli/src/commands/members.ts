// `homespun members` — app membership management for a v2 app (auth spec §6,
// spec-cli §2.5): invite/attach a member by email, list the app's
// owner + members, and remove one. Every verb targets an app via a required
// `--app <idOrSlug>` flag, resolved the same way `homespun apps`/`homespun data` do
// (resolveAppId).
//
// Auth on the relay side is owner-or-agent (the owning agent's API key OR
// the owner human's login cookie) — this CLI always authenticates as the
// agent, so any of these verbs works for an app the calling agent's owning
// human owns.
//
// (The v1 Template marketplace's human-login-only install/uninstall route
// — which was never a sibling verb here, since it isn't agent-key
// authorizable — was removed in PR 2c-1 along with the rest of the v1
// Template subsystem.)

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveAppId } from "../resolve-app.js";

export async function runMembers(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("members")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb — homespun members <add|list|set-role|remove|roles>",
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
    case "add":
      return runAdd(sub);
    case "list":
      return runList(sub);
    case "set-role":
      return runSetRole(sub);
    case "remove":
      return runRemove(sub);
    case "roles":
      return runRoles(sub);
    default:
      fail(
        `unknown verb '${verb}' — homespun members <add|list|set-role|remove|roles>`,
        "invalid_args",
      );
  }
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

async function runAdd(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("members", "add"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail(
      "usage: homespun members add --app <idOrSlug> --email <email> [--role member]",
      "invalid_args",
    );
  }
  const email = args.flags.get("email");
  if (!email) {
    fail("--email is required", "invalid_args");
  }
  const role = args.flags.get("role");
  if (role !== undefined && role !== "member") {
    fail('--role must be "member"', "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(
      await client.addAppMember(appId, {
        email: email!,
        ...(role !== undefined ? { role: role as "member" } : {}),
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
  assertKnownFlags(args, ...specFor("members", "list"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail("usage: homespun members list --app <idOrSlug>", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.listAppMembers(appId));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// set-role
// ---------------------------------------------------------------------------

async function runSetRole(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("members", "set-role"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail(
      "usage: homespun members set-role --app <idOrSlug> --human <humanId> (--custom-role <name> | --clear-role)",
      "invalid_args",
    );
  }
  const humanId = args.flags.get("human");
  if (!humanId) {
    fail("--human is required", "invalid_args");
  }
  // Clearing a role is a real instruction, so it gets its own explicit flag
  // rather than being spelled as an omitted or empty --custom-role: an omitted
  // value must never silently wipe someone's role.
  const customRole = args.flags.get("custom-role");
  const clear = args.bools.has("clear-role");
  if (clear && customRole !== undefined) {
    fail(
      "--custom-role and --clear-role are mutually exclusive",
      "invalid_args",
    );
  }
  if (!clear && customRole === undefined) {
    fail(
      "one of --custom-role <name> or --clear-role is required",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(
      await client.setAppMemberRole(appId, humanId!, {
        customRole: clear ? null : customRole!,
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function runRemove(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("members", "remove"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail(
      "usage: homespun members remove --app <idOrSlug> --human <humanId>",
      "invalid_args",
    );
  }
  const humanId = args.flags.get("human");
  if (!humanId) {
    fail("--human is required", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    await client.removeAppMember(appId, humanId!);
    printJson({ removed: true, app_id: appId, human_id: humanId });
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

async function runRoles(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("members", "roles"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail("usage: homespun members roles --app <idOrSlug>", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.listAppRoles(appId));
  } catch (e) {
    failFromError(e);
  }
}
