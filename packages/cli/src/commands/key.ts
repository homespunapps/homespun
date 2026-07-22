// `homespun key` — inspect or revoke the calling agent's API key.
//
// Flat command namespace: `key` is one top-level noun that branches on a
// positional verb (list / revoke). The relay scopes /v1/keys to the
// authenticated agent, so there is exactly one key — the caller's own. Both
// verbs therefore act ONLY on the caller's own key.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

async function runKeyList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("key", "list"));

  const client = makeClient(args);
  try {
    const info = await client.listKeys();
    printJson(info);
  } catch (e) {
    failFromError(e);
  }
}

async function runKeyMint(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("key", "mint"));

  const client = makeClient(args);
  try {
    // The raw key is in this response ONCE and never again, so print it verbatim.
    const minted = await client.mintKey();
    printJson(minted);
  } catch (e) {
    failFromError(e);
  }
}

async function runKeyRevoke(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("key", "revoke"));

  if (!args.bools.has("yes")) {
    fail(
      "'homespun key revoke' revokes YOUR OWN API key — it stops working " +
        "immediately and is irreversible. Pass --yes to confirm.",
      "confirmation_required",
    );
  }

  const client = makeClient(args);
  try {
    // The relay only permits revoking the caller's own key. If a positional id
    // is given, pass it through and let the relay 403 a wrong one; otherwise
    // resolve the caller's own id from GET /v1/keys.
    const id = args.positionals[1] ?? (await client.listKeys()).agent_id;
    await client.revokeKey(id);
    printJson({ revoked: true, agent_id: id });
  } catch (e) {
    failFromError(e);
  }
}

export async function runKey(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "list":
      await runKeyList(args);
      break;
    case "mint":
      await runKeyMint(args);
      break;
    case "revoke":
      await runKeyRevoke(args);
      break;
    case undefined:
      fail(
        "missing verb; usage: homespun key <list|mint|revoke> (run 'homespun key --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown key verb '${sub}', expected list|mint|revoke (run 'homespun key --help')`,
        "invalid_args",
      );
  }
}
