// `homespun attachment token <mint|revoke|list>` — capability URLs for a attachment.
//
// A capability URL (/b/<token>) is a participant-facing way to fetch a attachment
// without holding the agent's API key. Tokens are minted per-attachment, can be
// time-bound (--ttl) and/or single-use (--once), and are stored hashed on
// the relay — the plaintext token is returned ONCE on 'mint' and cannot be
// recovered.
//
// This file is a sub-noun dispatcher under `homespun attachment`. The attachment dispatcher
// hands us a ParsedArgs whose positionals[0] is "token" (our sub-noun
// marker), so we read the verb from positionals[1] and the args from
// positionals[2..]. Mirrors how participant.ts dispatches under `app
// app participant`.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";

async function runBlobTokenMint(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("attachment", "token mint"));

  const attachmentId = args.positionals[1];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'homespun attachment token mint <attachment-id>'",
      "invalid_args",
    );
  }
  const ttlRaw = args.flags.get("ttl");
  const ttl = ttlRaw === undefined ? undefined : Number(ttlRaw);
  if (ttlRaw !== undefined && (!Number.isInteger(ttl) || ttl! <= 0)) {
    fail("--ttl must be a positive integer (seconds)", "invalid_args");
  }
  const client = makeClient(args);
  try {
    const r = await client.mintBlobToken(attachmentId!, {
      ttlSeconds: ttl,
      once: args.bools.has("once"),
    });
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

async function runBlobTokenRevoke(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("attachment", "token revoke"));

  const attachmentId = args.positionals[1];
  const tokenId = args.positionals[2];
  if (!attachmentId || !tokenId) {
    fail(
      "missing arguments — 'homespun attachment token revoke <attachment-id> <token-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.revokeBlobToken(attachmentId!, tokenId!);
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

async function runBlobTokenList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("attachment", "token list"));

  const attachmentId = args.positionals[1];
  if (!attachmentId) {
    fail(
      "missing <attachment-id> — 'homespun attachment token list <attachment-id>'",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  try {
    const r = await client.listBlobTokens(attachmentId!);
    printJson(r);
  } catch (e) {
    failFromError(e);
  }
}

export async function runBlobToken(args: ParsedArgs): Promise<void> {
  // positionals[0] is the verb (mint | revoke | list), positionals[1..] are
  // the verb's args. (The attachment.ts dispatcher already shifted off the "token"
  // marker before calling us.)
  const verb = args.positionals[0];
  switch (verb) {
    case "mint":
      await runBlobTokenMint(args);
      break;
    case "revoke":
      await runBlobTokenRevoke(args);
      break;
    case "list":
      await runBlobTokenList(args);
      break;
    case undefined:
      fail(
        "missing verb — usage: homespun attachment token <mint|revoke|list> (run 'homespun attachment token --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown token verb '${verb}' — expected mint|revoke|list (run 'homespun attachment token --help')`,
        "invalid_args",
      );
  }
}
