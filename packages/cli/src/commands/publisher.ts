// `homespun publisher` (issue #890) community publisher identity: claim the
// one permanent handle, show the caller's own profile, update the mutable
// profile fields, and (operator) set another publisher's trust level. Every
// verb acts AS the calling agent's owning human via the relay /v1/publisher
// routes; set-trust is operator-gated server-side.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export async function runPublisher(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("publisher")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb: homespun publisher <claim|show|update|set-trust>",
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
    case "claim":
      return runClaim(sub);
    case "show":
      return runShow(sub);
    case "update":
      return runUpdate(sub);
    case "set-trust":
      return runSetTrust(sub);
    default:
      fail(
        `unknown verb '${verb}' (homespun publisher <claim|show|update|set-trust>)`,
        "invalid_args",
      );
  }
}

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

async function runClaim(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("publisher", "claim"));
  const handle = args.positionals[0];
  if (!handle) {
    fail("usage: homespun publisher claim <handle>", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(await client.claimPublisherHandle(handle!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function runShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("publisher", "show"));
  const client = makeClient(args);
  try {
    printJson(await client.getPublisher());
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function runUpdate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("publisher", "update"));
  const displayName = args.flags.get("display-name");
  const bio = args.flags.get("bio");
  // The SDK field is `url`, but the CLI flag is --website: --url is the global
  // relay-target override, so the publisher's profile url gets its own name.
  const website = args.flags.get("website");
  if (displayName === undefined && bio === undefined && website === undefined) {
    fail(
      "at least one of --display-name, --bio, or --website is required",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    printJson(
      await client.updatePublisher({
        ...(displayName !== undefined ? { displayName } : {}),
        ...(bio !== undefined ? { bio } : {}),
        ...(website !== undefined ? { url: website } : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// set-trust
// ---------------------------------------------------------------------------

async function runSetTrust(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("publisher", "set-trust"));
  const handle = args.positionals[0];
  const level = args.positionals[1];
  if (!handle || !level) {
    fail(
      "usage: homespun publisher set-trust <handle> <new|established>",
      "invalid_args",
    );
  }
  if (level !== "new" && level !== "established") {
    fail('trust level must be "new" or "established"', "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(await client.setPublisherTrustLevel(handle!, level));
  } catch (e) {
    failFromError(e);
  }
}
