#!/usr/bin/env node
// app — command-line client for the Homespun relay.
//
// Shape: uniform `homespun <noun> <verb> [options]`. Every command lives under a
// noun; nothing is a bare top-level verb. See issue #163 for the rationale
// behind the shape and the rename from the older flat layout.
//
// Config: HOMESPUN_URL and HOMESPUN_API_KEY (env), overridable with --url / --api-key.
// Multiple environments live as named profiles in
// $XDG_CONFIG_HOME/homespun/config.json; pick one with --profile or HOMESPUN_PROFILE.
// Output is JSON by default. Every noun self-documents via --help.

import { parseArgs, ArgvError, BOOLEAN_FLAGS } from "./argv.js";
import { nounSpec, renderNounHelp, renderRootHelp } from "./help-catalog.js";

/**
 * Translate an ArgvError into the canonical `invalid_args` envelope and exit
 * non-zero. The parser throws ArgvError up-front; assertKnownFlags throws it
 * from inside a runner. Both paths funnel here so the on-wire shape is one.
 */
function failArgvError(e: ArgvError): never {
  const error: Record<string, unknown> = {
    code: "invalid_args",
    message: e.message,
  };
  if (e.hint !== undefined) error["hint"] = e.hint;
  process.stderr.write(JSON.stringify({ error }) + "\n");
  process.exit(1);
}
import { runAgent } from "./commands/agent.js";
import { runKey } from "./commands/key.js";
import { runTaste } from "./commands/taste.js";
import { runFeedback } from "./commands/feedback.js";
import { runConfig } from "./commands/config.js";
import { runBlob } from "./commands/attachment.js";
import { runSkill } from "./commands/skill.js";
import { runDeploy } from "./commands/deploy.js";
import { runApps } from "./commands/apps.js";
import { runData } from "./commands/data.js";
import { runMembers } from "./commands/members.js";
import { runGrant } from "./commands/grant.js";
import { runIngest } from "./commands/ingest.js";
import { VERSION } from "./version.js";
import { HomespunApiError } from "@homespunapps/core";
import { failUpgradeRequired } from "./output.js";

// BOOLEAN_FLAGS (flags that never take a value) lives in argv.ts next to the
// parser that consumes it, and is exported so tests parse with the real set
// instead of a per-test copy that can drift (#827).

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);

  // Version: handle before anything else.
  if (rawArgv[0] === "-v" || rawArgv[0] === "--version") {
    process.stdout.write(VERSION + "\n");
    return;
  }

  const noun = rawArgv[0];
  const rest = rawArgv.slice(1);

  if (
    noun === undefined ||
    noun === "-h" ||
    noun === "--help" ||
    noun === "help"
  ) {
    process.stdout.write(renderRootHelp() + "\n");
    return;
  }

  let args;
  try {
    args = parseArgs(rest, BOOLEAN_FLAGS);
  } catch (e) {
    if (e instanceof ArgvError) {
      failArgvError(e);
    }
    throw e;
  }

  const spec = nounSpec(noun);
  if (!spec) {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: "unknown_command",
          message: `unknown command '${noun}' — run 'homespun --help'`,
        },
      }) + "\n",
    );
    process.exit(1);
  }

  // `homespun <noun> --help` with no verb prints the noun-level help. A verb-level
  // --help is the responsibility of each runner (e.g. runApp dispatches to
  // the verb runner which reads its own xxxHelp). This pre-empt only fires
  // when --help is the FIRST positional-equivalent — i.e. no verb given.
  if (args.bools.has("help") && args.positionals.length === 0) {
    process.stdout.write(renderNounHelp(spec) + "\n");
    return;
  }

  switch (noun) {
    case "key":
      await runKey(args);
      break;
    case "taste":
      await runTaste(args);
      break;
    case "feedback":
      await runFeedback(args);
      break;
    case "attachment":
      await runBlob(args);
      break;
    case "agent":
      await runAgent(args);
      break;
    case "config":
      await runConfig(args);
      break;
    case "skill":
      await runSkill(args);
      break;
    case "deploy":
      await runDeploy(args);
      break;
    case "apps":
      await runApps(args);
      break;
    case "data":
      await runData(args);
      break;
    case "members":
      await runMembers(args);
      break;
    case "grants":
      await runGrant(args);
      break;
    case "ingest":
      await runIngest(args);
      break;
  }
}

main().catch((err) => {
  // ArgvError thrown from a runner (e.g. assertKnownFlags) reaches here —
  // funnel it through the same invalid_args envelope as the parse-time path
  // so unknown-flag rejection looks identical no matter which layer caught
  // the user error.
  if (err instanceof ArgvError) {
    failArgvError(err);
  }
  // Funnel 426 cli_upgrade_required through the dedicated upgrade-message
  // path so a command that throws raw (instead of going through
  // failFromError) still produces the exact stderr block + exit 75 the
  // SKILL.md tells the agent's harness to expect.
  if (
    err instanceof HomespunApiError &&
    err.code === "cli_upgrade_required" &&
    err.status === 426
  ) {
    failUpgradeRequired(err);
  }
  process.stderr.write(
    JSON.stringify({
      error: {
        code: "internal",
        message: err instanceof Error ? err.message : String(err),
      },
    }) + "\n",
  );
  process.exit(1);
});
