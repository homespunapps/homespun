// `homespun attachment upload` — POST /v1/attachments (multipart), two scopes.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

export async function runBlobUpload(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("attachment", "upload"));

  const filePath = args.flags.get("file");
  if (!filePath) {
    fail(
      "missing --file <path> — 'homespun attachment upload' requires a local file to upload",
      "invalid_args",
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(filePath);
  } catch (e) {
    fail(
      `failed to read --file '${filePath}': ${e instanceof Error ? e.message : String(e)}`,
      "invalid_args",
    );
  }
  const scopeRaw = args.flags.get("scope") ?? "agent";
  if (scopeRaw !== "agent" && scopeRaw !== "app") {
    fail(
      `unknown --scope '${scopeRaw}', expected one of: agent, app`,
      "invalid_args",
    );
  }
  const scope = scopeRaw as "agent" | "app";
  if (scope === "app" && !args.flags.get("app-id")) {
    fail("--scope=app requires --app-id <id>", "invalid_args");
  }

  const client = makeClient(args);
  try {
    const ref = await client.uploadBlob(bytes, {
      scope,
      appId: args.flags.get("app-id"),
      filename: args.flags.get("filename") ?? basename(filePath),
      mime: args.flags.get("mime"),
    });
    printJson(ref);
  } catch (e) {
    failFromError(e);
  }
}
