// `homespun attachment` — manage binary attachments (attachments) on the relay.
//
// A attachment is a typed binary file (image, PDF, audio, video, etc.) owned by an
// agent and optionally bound to an App. Pages reference attachments
// by id with `format: homespun-attachment-id`; participants can fetch a attachment through a
// minted capability URL (/b/<token>) without needing the agent's API key.
//
// This file is a thin dispatcher — each verb's actual logic lives in its own
// file (attachment-upload.ts, attachment-download.ts, attachment-show.ts, attachment-delete.ts) and
// the token sub-noun is dispatched via attachment-token.ts.
//
// Most attachment verbs read their primary positional (the attachment_id) at
// positionals[0]; we slice off our own verb before delegating so each verb
// runner doesn't need to know it was reached through `homespun attachment`.

import type { ParsedArgs } from "../argv.js";
import { nounSpec, renderNounHelp } from "../help-catalog.js";
import { runBlobUpload } from "./attachment-upload.js";
import { runBlobDownload } from "./attachment-download.js";
import { runBlobShow } from "./attachment-show.js";
import { runBlobList } from "./attachment-list.js";
import { runBlobDelete } from "./attachment-delete.js";
import { runBlobToken } from "./attachment-token.js";
import { fail } from "../output.js";

/**
 * Build a new ParsedArgs with the leading positional (the verb) stripped.
 * The downstream verb runners read their primary positional (the attachment_id)
 * at positionals[0], so we hand them an args object that looks exactly like
 * they were called directly — mirrors app.ts's shiftPositionals.
 */
function shiftPositionals(args: ParsedArgs): ParsedArgs {
  // Propagate danglingValueFlags so the leaf runner's assertKnownFlags
  // can still distinguish "unknown flag" from "missing value" — see the
  // matching note in app.ts's shiftPositionals.
  const out: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    bools: args.bools,
  };
  if (args.danglingValueFlags !== undefined) {
    out.danglingValueFlags = args.danglingValueFlags;
  }
  return out;
}

export async function runBlob(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  // `homespun attachment token --help` (verb-level help on the token sub-noun, with no
  // further sub-verb). The general --help pre-empt in index.ts only fires
  // when no positional follows the noun; here a positional ("token") is
  // present, so the sub-noun must own its own --help routing.
  if (
    verb === "token" &&
    args.bools.has("help") &&
    args.positionals.length === 1
  ) {
    process.stdout.write(renderNounHelp(nounSpec("attachment")!) + "\n");
    return;
  }
  // `homespun attachment list --help` — same pattern (list takes no required positional
  // so the general pre-empt would already fire, but for parity with app.ts
  // we route through here when args carry the "list" positional explicitly).
  if (
    verb === "list" &&
    args.bools.has("help") &&
    args.positionals.length === 1
  ) {
    process.stdout.write(renderNounHelp(nounSpec("attachment")!) + "\n");
    return;
  }

  const inner = shiftPositionals(args);
  switch (verb) {
    case "upload":
      await runBlobUpload(inner);
      break;
    case "download":
      await runBlobDownload(inner);
      break;
    case "show":
      await runBlobShow(inner);
      break;
    case "list":
      await runBlobList(inner);
      break;
    case "delete":
      await runBlobDelete(inner);
      break;
    case "token":
      await runBlobToken(inner);
      break;
    case undefined:
      fail(
        "missing verb — usage: homespun attachment <upload|download|show|list|delete|token> (run 'homespun attachment --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown attachment verb '${verb}' — expected upload|download|show|list|delete|token (run 'homespun attachment --help')`,
        "invalid_args",
      );
  }
}
