// `homespun agent claim <code>` — bind this agent to a human via a one-shot
// claim code the human generated in their settings UI.
//
// Flow (§6.1):
//   1. Alice opens Settings → "Claim an agent" → relay mints a one-shot code,
//      shows it to her once, 15-min TTL.
//   2. Alice hands the code to the agent out-of-band (this CLI invocation
//      is exactly that handoff).
//   3. CLI calls POST /v1/agents/claim with the calling agent's API key.
//   4. Relay binds Agent.ownerHumanId = alice.id, migrates app ownership.
//
// The CLI does NOT print the human's email or id — only the relay's response,
// which is { ok, owner_human_id, claimed_at }. The agent's existing API key
// keeps working.

import { HomespunClient, HomespunApiError } from "@homespunapps/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { resolveConfig } from "../config.js";
import { printJson, fail } from "../output.js";

export async function runClaim(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("agent", "claim"));

  const code = args.positionals[0];
  if (!code) {
    fail(
      "missing required argument: <code> — run 'homespun agent claim --help'",
      "invalid_args",
    );
    return;
  }

  const creds = resolveConfig(args);
  const client = new HomespunClient({ url: creds.url, apiKey: creds.apiKey });

  try {
    const result = await client.claimAgent(code);
    printJson(result);
  } catch (err) {
    if (err instanceof HomespunApiError) {
      fail(err.message, err.code);
      return;
    }
    throw err;
  }
}
