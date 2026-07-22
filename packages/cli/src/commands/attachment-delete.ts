// `homespun attachment delete <attachment-id>` — soft-delete a attachment.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export async function runBlobDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("attachment", "delete"));

  const attachmentId = args.positionals[0];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'homespun attachment delete <attachment-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.deleteBlob(attachmentId!);
    printJson({ attachment_id: attachmentId, ...r });
  } catch (e) {
    failFromError(e);
  }
}
