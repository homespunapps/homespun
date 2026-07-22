// `homespun attachment show <attachment-id>` — print a attachment's metadata.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export async function runBlobShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("attachment", "show"));

  const attachmentId = args.positionals[0];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'homespun attachment show <attachment-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const ref = await client.getBlob(attachmentId!);
    printJson(ref);
  } catch (e) {
    failFromError(e);
  }
}
