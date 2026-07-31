// `homespun template` (issue #890) community marketplace templates: publish an
// owned app as a pending template, unpublish your own live listing (#1299),
// read a template's install-time config contract, install a template for the
// caller, and (operator) list/show/approve/reject pending submissions.
// Publish/unpublish/config-contract/install act AS the calling agent's owning
// human; list-pending/show/approve/reject are operator-gated server-side. A
// template <ref> is a namespaced <handle>/<slug> or a snapshot id, passed
// straight to the SDK.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveJson } from "../input.js";
import { resolveAppId } from "../resolve-app.js";
import type { CommunitySetupStep } from "@homespunapps/core";

export async function runTemplate(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("template")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb: homespun template <publish|unpublish|config-contract|install|list-pending|show|approve|reject>",
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
    case "publish":
      return runPublish(sub);
    case "unpublish":
      return runUnpublish(sub);
    case "config-contract":
      return runConfigContract(sub);
    case "install":
      return runInstall(sub);
    case "list-pending":
      return runListPending(sub);
    case "show":
      return runShow(sub);
    case "approve":
      return runApprove(sub);
    case "reject":
      return runReject(sub);
    default:
      fail(
        `unknown verb '${verb}' (homespun template <publish|unpublish|config-contract|install|list-pending|show|approve|reject>)`,
        "invalid_args",
      );
  }
}

function parseIntFlag(
  args: ParsedArgs,
  name: string,
  bounds: { min?: number; max?: number } = {},
): number | undefined {
  const raw = args.flags.get(name);
  if (raw === undefined) return undefined;
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

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function runPublish(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("template", "publish"));
  const appArg = args.positionals[0];
  if (!appArg) {
    fail("usage: homespun template publish <app>", "invalid_args");
  }
  const title = args.flags.get("title");
  const description = args.flags.get("description");
  const longDescription = args.flags.get("long-description");
  const category = args.flags.get("category");
  const slug = args.flags.get("slug");
  const version = args.flags.get("version");
  const changelogNote = args.flags.get("changelog-note");
  const attestExampleOnly = args.bools.has("attest-example-only");

  const tagsRaw = args.flags.get("tags");
  const tags =
    tagsRaw !== undefined
      ? (resolveJson(tagsRaw, "--tags") as string[])
      : undefined;
  const setupStepsRaw = args.flags.get("setup-steps");
  const setupSteps =
    setupStepsRaw !== undefined
      ? (resolveJson(setupStepsRaw, "--setup-steps") as CommunitySetupStep[])
      : undefined;

  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(
      await client.publishCommunityTemplate({
        appId,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(longDescription !== undefined ? { longDescription } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(slug !== undefined ? { slug } : {}),
        ...(version !== undefined ? { version } : {}),
        ...(changelogNote !== undefined ? { changelogNote } : {}),
        ...(setupSteps !== undefined ? { setupSteps } : {}),
        ...(attestExampleOnly ? { attestExampleOnly: true } : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// unpublish
// ---------------------------------------------------------------------------

async function runUnpublish(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("template", "unpublish"));
  const snapshotId = args.positionals[0];
  if (!snapshotId) {
    fail("usage: homespun template unpublish <snapshot-id>", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(await client.unpublishCommunityTemplate(snapshotId!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// config-contract
// ---------------------------------------------------------------------------

async function runConfigContract(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("template", "config-contract"));
  const ref = args.positionals[0];
  if (!ref) {
    fail("usage: homespun template config-contract <ref>", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(await client.getCommunityConfigContract(ref!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function runInstall(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("template", "install"));
  const ref = args.positionals[0];
  if (!ref) {
    fail("usage: homespun template install <ref>", "invalid_args");
  }
  const configRaw = args.flags.get("config");
  const config =
    configRaw !== undefined
      ? (resolveJson(configRaw, "--config") as Record<string, unknown>)
      : undefined;
  const client = makeClient(args);
  try {
    printJson(await client.installCommunityTemplate(ref!, config));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// list-pending
// ---------------------------------------------------------------------------

async function runListPending(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("template", "list-pending"));
  const limit = parseIntFlag(args, "limit", { min: 1 });
  const cursor = args.flags.get("cursor");
  const client = makeClient(args);
  try {
    printJson(
      await client.listCommunitySubmissions({
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

async function runShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("template", "show"));
  const snapshotId = args.positionals[0];
  if (!snapshotId) {
    fail("usage: homespun template show <snapshot-id>", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(await client.getCommunitySubmission(snapshotId!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// approve
// ---------------------------------------------------------------------------

async function runApprove(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("template", "approve"));
  const snapshotId = args.positionals[0];
  if (!snapshotId) {
    fail("usage: homespun template approve <snapshot-id>", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(
      await client.reviewCommunitySubmission(snapshotId!, {
        decision: "approve",
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

async function runReject(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("template", "reject"));
  const snapshotId = args.positionals[0];
  if (!snapshotId) {
    fail(
      "usage: homespun template reject <snapshot-id> --note <note>",
      "invalid_args",
    );
  }
  const note = args.flags.get("note");
  if (!note) {
    fail("--note is required", "invalid_args");
  }
  const client = makeClient(args);
  try {
    printJson(
      await client.reviewCommunitySubmission(snapshotId!, {
        decision: "reject",
        note: note!,
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}
