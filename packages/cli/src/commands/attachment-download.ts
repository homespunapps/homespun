// `homespun attachment download <attachment-id>` — fetch attachment bytes by id.

import { writeFileSync } from "node:fs";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export async function runBlobDownload(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("attachment", "download"));

  const attachmentId = args.positionals[0];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'homespun attachment download <attachment-id>'",
      "invalid_args",
    );
  }
  const out = args.flags.get("out");

  const client = makeClient(args);
  try {
    const buf = await client.downloadBlob(attachmentId!);
    if (out) {
      writeFileSync(out, Buffer.from(buf));
      printJson({
        attachment_id: attachmentId,
        written: out,
        bytes: buf.byteLength,
      });
    } else {
      // Binary to stdout — useful for piping into another tool.
      process.stdout.write(Buffer.from(buf));
    }
  } catch (e) {
    failFromError(e);
  }
}
