// `homespun taste` — read / write / clear the calling agent's freeform "taste
// notes" markdown attachment.
//
// Taste notes are presentation preferences the agent has learned from human
// feedback ("denser layout", "no rounded corners", "use a dark header") — the
// kind of guidance that should outlive a single app. The intended loop:
//
//   1. Before generating an app template, run `homespun taste get` and feed the
//      `taste` field into the prompt so prior preferences shape the output.
//   2. When the human gives new presentation feedback, run `homespun taste get`,
//      merge the feedback into the existing notes IN THE PROMPT, then call
//      `homespun taste set` with the WHOLE new attachment (the relay does whole-attachment
//      replace, not append — that's deliberate, so the notes can't grow
//      unbounded into noise).
//
// Keep taste notes about *presentation/UI taste only* — colours, density,
// component preferences. Project context, todos, and per-app state belong
// somewhere else. Today the attachment is keyed by the agent's API key (per-agent);
// when app gains first-class humans, this may move to per-human.

import { readFileSync } from "node:fs";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

// Drain process.stdin to a utf8 string. The caller is responsible for
// deciding that stdin should be read (e.g. an explicit `--file -`, or a
// non-TTY stdin where data is actually piped). In a TTY this would block
// waiting for ^D, so the caller MUST gate on `process.stdin.isTTY` first.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runTasteGet(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("taste", "get"));

  const client = makeClient(args);
  try {
    const info = await client.getTaste();
    printJson(info);
  } catch (e) {
    failFromError(e);
  }
}

async function runTasteSet(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("taste", "set"));

  const filePath = args.flags.get("file");

  // Source the attachment deterministically — no isTTY-flag fusing, because
  // `!process.stdin.isTTY` is true under every non-interactive caller
  // (pipes, redirects, closed fd, CI, agent harnesses) and would wrongly
  // reject `--file` for the entire target audience. See issue #148.
  //
  //   --file -        → explicit stdin sentinel
  //   --file <path>   → read that path (works in TTY and non-TTY alike)
  //   (no --file)     → fall back to stdin IF non-TTY; error in a TTY
  let taste: string;
  if (filePath === "-") {
    taste = await readStdin();
  } else if (filePath !== undefined) {
    try {
      taste = readFileSync(filePath, "utf8");
    } catch (e) {
      fail(
        `failed to read --file '${filePath}': ${e instanceof Error ? e.message : String(e)}`,
        "invalid_args",
      );
    }
  } else if (!process.stdin.isTTY) {
    taste = await readStdin();
  } else {
    fail(
      "'homespun taste set' needs input — pass --file <path>, pipe markdown on stdin, or use --file -",
      "invalid_args",
    );
  }

  if (taste.trim().length === 0) {
    fail(
      "'homespun taste set' refuses an empty or whitespace-only attachment — use 'homespun taste clear --yes' to delete the notes",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    const info = await client.setTaste(taste);
    printJson(info);
  } catch (e) {
    failFromError(e);
  }
}

async function runTasteClear(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("taste", "clear"));

  if (!args.bools.has("yes")) {
    fail(
      "'homespun taste clear' deletes YOUR agent's taste notes — it is destructive. Pass --yes to confirm.",
      "confirmation_required",
    );
  }

  const client = makeClient(args);
  try {
    await client.clearTaste();
    printJson({ cleared: true });
  } catch (e) {
    failFromError(e);
  }
}

export async function runTaste(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "get":
      await runTasteGet(args);
      break;
    case "set":
      await runTasteSet(args);
      break;
    case "clear":
      await runTasteClear(args);
      break;
    case undefined:
      fail(
        "missing subcommand — usage: homespun taste <get|set|clear> (run 'homespun taste --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown taste subcommand '${sub}' — expected get|set|clear (run 'homespun taste --help')`,
        "invalid_args",
      );
  }
}
