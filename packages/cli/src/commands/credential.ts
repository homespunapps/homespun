// `homespun credentials` (#1354, #1355, #1363) scoped-service-credential
// management for a v2 app: mint the bearer token an owner points a backend
// they host themselves at, list an app's credentials, pause/resume one
// reversibly, rotate one with an overlap window, and revoke one permanently.
// Every verb targets an app via a required `--app <idOrSlug>` flag, resolved
// the same way `homespun grants`/`homespun members`/`homespun data` do
// (resolveAppId).
//
// Auth on the relay side is owner-or-owning-agent; this CLI always
// authenticates as the owning agent, so any verb works for an app the calling
// agent's owning human owns. A service credential itself can reach none of
// these routes (the relay's owner-or-agent gate rejects it at the door), so
// there is no separate authorization check to add here.
//
// mint's raw `token` is printed exactly ONCE (only its sha256 is stored, so
// it is never recoverable afterward); rotate's new token is printed once the
// same way.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveAppId } from "../resolve-app.js";
import type { ServiceCredentialGrant } from "@homespunapps/core";

export async function runCredential(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("credentials")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb: homespun credentials <mint|list|pause|resume|rotate|revoke>",
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
    case "mint":
      return runMint(sub);
    case "list":
      return runList(sub);
    case "pause":
      return runPause(sub);
    case "resume":
      return runResume(sub);
    case "rotate":
      return runRotate(sub);
    case "revoke":
      return runRevoke(sub);
    default:
      fail(
        `unknown verb '${verb}' (homespun credentials <mint|list|pause|resume|rotate|revoke>)`,
        "invalid_args",
      );
  }
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    fail(`${flag} must be a non-negative integer`, "invalid_args");
  }
  return n;
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
  assertKnownFlags(args, ...specFor("credentials", "mint"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail("usage: homespun credentials mint --app <idOrSlug>", "invalid_args");
  }
  const mode = args.flags.get("mode");
  if (mode !== undefined && mode !== "explicit" && mode !== "following") {
    fail('--mode must be "explicit" or "following"', "invalid_args");
  }
  const grantsRaw = args.flags.get("grants");
  let grants: ServiceCredentialGrant[] | undefined;
  if (grantsRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(grantsRaw);
    } catch {
      fail(
        '--grants must be a JSON array, e.g. \'[{"collection":"orders","ops":["read","create"]}]\'',
        "invalid_args",
      );
    }
    if (!Array.isArray(parsed)) {
      fail(
        "--grants must be a JSON array of allowlist entries",
        "invalid_args",
      );
    }
    grants = parsed as ServiceCredentialGrant[];
  }
  const ttlRaw = args.flags.get("ttl");
  const noExpiry = args.bools.has("no-expiry");
  if (ttlRaw !== undefined && noExpiry) {
    fail("--ttl and --no-expiry are mutually exclusive", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(
      await client.mintAppCredential(appId, {
        ...(mode !== undefined
          ? { mode: mode as "explicit" | "following" }
          : {}),
        ...(grants !== undefined ? { grants } : {}),
        ...(args.bools.has("members") ? { members: true } : {}),
        ...(args.flags.get("label") !== undefined
          ? { label: args.flags.get("label")! }
          : {}),
        ...(noExpiry
          ? { ttlSeconds: null }
          : ttlRaw !== undefined
            ? { ttlSeconds: parsePositiveInt(ttlRaw, "--ttl") }
            : {}),
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
  assertKnownFlags(args, ...specFor("credentials", "list"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail("usage: homespun credentials list --app <idOrSlug>", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.listAppCredentials(appId));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// pause / resume
// ---------------------------------------------------------------------------

function requireCredentialFlags(
  args: ParsedArgs,
  verb: string,
): { appArg: string; credentialId: string } {
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail(
      `usage: homespun credentials ${verb} --app <idOrSlug> --credential <credentialId>`,
      "invalid_args",
    );
  }
  const credentialId = args.flags.get("credential");
  if (!credentialId) {
    fail("--credential is required", "invalid_args");
  }
  return { appArg: appArg!, credentialId: credentialId! };
}

async function runPause(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("credentials", "pause"));
  const { appArg, credentialId } = requireCredentialFlags(args, "pause");
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    await client.pauseAppCredential(appId, credentialId);
    printJson({ paused: true, app_id: appId, credential_id: credentialId });
  } catch (e) {
    failFromError(e);
  }
}

async function runResume(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("credentials", "resume"));
  const { appArg, credentialId } = requireCredentialFlags(args, "resume");
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    await client.resumeAppCredential(appId, credentialId);
    printJson({ resumed: true, app_id: appId, credential_id: credentialId });
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// rotate
// ---------------------------------------------------------------------------

async function runRotate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("credentials", "rotate"));
  const { appArg, credentialId } = requireCredentialFlags(args, "rotate");
  const overlapRaw = args.flags.get("overlap");
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    printJson(
      await client.rotateAppCredential(appId, credentialId, {
        ...(overlapRaw !== undefined
          ? { overlapSeconds: parseNonNegativeInt(overlapRaw, "--overlap") }
          : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// revoke
// ---------------------------------------------------------------------------

async function runRevoke(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("credentials", "revoke"));
  const { appArg, credentialId } = requireCredentialFlags(args, "revoke");
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg);
  try {
    await client.revokeAppCredential(appId, credentialId);
    printJson({ revoked: true, app_id: appId, credential_id: credentialId });
  } catch (e) {
    failFromError(e);
  }
}
