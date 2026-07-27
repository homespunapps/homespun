// `homespun review` (issue #890) community marketplace reviews: create a star
// review for a template the caller installed, respond to a review as the
// publisher, report a review for operator attention, and (operator) remove or
// unhold a review. create/respond/report act AS the calling agent's owning
// human; remove/unhold are operator-gated server-side. A template <ref> is a
// namespaced <handle>/<slug>, passed straight to the SDK.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export async function runReview(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("review")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb: homespun review <create|respond|report|remove|unhold>",
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
    case "create":
      return runCreate(sub);
    case "respond":
      return runRespond(sub);
    case "report":
      return runReport(sub);
    case "remove":
      return runRemove(sub);
    case "unhold":
      return runUnhold(sub);
    default:
      fail(
        `unknown verb '${verb}' (homespun review <create|respond|report|remove|unhold>)`,
        "invalid_args",
      );
  }
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runCreate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("review", "create"));
  const ref = args.positionals[0];
  if (!ref) {
    fail(
      "usage: homespun review create <ref> --stars <1-5> [--body <text>]",
      "invalid_args",
    );
  }
  const starsRaw = args.flags.get("stars");
  if (starsRaw === undefined) {
    fail("--stars is required", "invalid_args");
  }
  const stars = Number(starsRaw);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    fail("--stars must be an integer from 1 to 5", "invalid_args");
  }
  const body = args.flags.get("body");
  const client = makeClient(args);
  try {
    printJson(
      await client.createReview({
        template: ref!,
        stars,
        ...(body !== undefined ? { body } : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------

async function runRespond(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("review", "respond"));
  const reviewId = args.positionals[0];
  if (!reviewId) {
    fail(
      "usage: homespun review respond <review-id> (--response <text> | --clear)",
      "invalid_args",
    );
  }
  // Clearing a response is a real instruction, so it gets its own explicit flag
  // rather than being spelled as an omitted or empty --response: an omitted
  // value must never silently wipe a published response.
  const response = args.flags.get("response");
  const clear = args.bools.has("clear");
  if (clear && response !== undefined) {
    fail("--response and --clear are mutually exclusive", "invalid_args");
  }
  if (!clear && response === undefined) {
    fail("one of --response <text> or --clear is required", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(
      await client.respondToReview(reviewId!, clear ? null : response!),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function runReport(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("review", "report"));
  const reviewId = args.positionals[0];
  if (!reviewId) {
    fail(
      "usage: homespun review report <review-id> --reason <reason>",
      "invalid_args",
    );
  }
  const reason = args.flags.get("reason");
  if (!reason) {
    fail("--reason is required", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(await client.reportReview(reviewId!, reason!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

async function runRemove(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("review", "remove"));
  const reviewId = args.positionals[0];
  if (!reviewId) {
    fail("usage: homespun review remove <review-id>", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(await client.removeReview(reviewId!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// unhold
// ---------------------------------------------------------------------------

async function runUnhold(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("review", "unhold"));
  const reviewId = args.positionals[0];
  if (!reviewId) {
    fail("usage: homespun review unhold <review-id>", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(await client.unholdReview(reviewId!));
  } catch (e) {
    failFromError(e);
  }
}
