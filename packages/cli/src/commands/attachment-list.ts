// `homespun attachment list` — enumerate YOUR agent's attachments.
//
// Lists attachments owned by the calling agent, newest first. Soft-deleted attachments
// are excluded; tokens are not enumerated here (use 'homespun attachment token list
// <attachment-id>' for that).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, printJson, failFromError } from "../output.js";

export async function runBlobList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("attachment", "list"));

  const cursor = args.flags.get("cursor");
  const limitRaw = args.flags.get("limit");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      fail("--limit must be an integer in 1..100", "invalid_args");
    }
    limit = n;
  }
  const client = makeClient(args);
  try {
    const r = await client.listBlobs({ cursor, limit });
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}
