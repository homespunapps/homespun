// `homespun agent` — agent-lifecycle operations: register a new API key, or
// clear the locally-saved one.
//
// Both verbs are about the calling agent's identity on this machine:
//   register   provision an API key from the relay (one-shot bootstrap)
//   logout     clear the locally-saved relay URL + API key
//
// This file is a thin dispatcher — actual logic lives in register.ts and
// logout.ts.

import type { ParsedArgs } from "../argv.js";
import { runRegister } from "./register.js";
import { runLogout } from "./logout.js";
import { runClaim } from "./claim.js";
import { runSetKey } from "./set-key.js";
import { fail } from "../output.js";

export async function runAgent(args: ParsedArgs): Promise<void> {
  // Strip the first positional (the verb) so each verb runner sees its
  // own arguments at positionals[0..n].
  const verbArgs = {
    ...args,
    positionals: args.positionals.slice(1),
  };
  const verb = args.positionals[0];
  switch (verb) {
    case "register":
      await runRegister(verbArgs);
      break;
    case "claim":
      await runClaim(verbArgs);
      break;
    case "set-key":
      await runSetKey(verbArgs);
      break;
    case "logout":
      await runLogout(verbArgs);
      break;
    case undefined:
      fail(
        "missing verb — usage: homespun agent <register|claim|set-key|logout> (run 'homespun agent --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown agent verb '${verb}' — expected register|claim|set-key|logout (run 'homespun agent --help')`,
        "invalid_args",
      );
  }
}
