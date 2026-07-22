// `homespun agent logout` — clear one (or all) saved profile(s).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import {
  clearStore,
  readStore,
  removeProfile,
  resolveProfile,
} from "../store.js";
import { printJson, fail } from "../output.js";

export async function runLogout(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("agent", "logout"));

  if (args.bools.has("all")) {
    // Nuke everything — file gone, both legacy and new shape covered.
    const path = clearStore();
    printJson({ cleared: true, profile: null, path });
    return;
  }

  const store = readStore();
  const selector = args.flags.get("profile") ?? process.env.HOMESPUN_PROFILE;
  let target: {
    name: string;
    profile: { url?: string; apiKey?: string };
  } | null;
  try {
    target = resolveProfile(store, selector);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "config_error");
  }

  // Nothing to clear: empty store or legacy file with no migrate yet.
  if (!target) {
    // If there's literally nothing saved, mirror the legacy idempotent
    // behaviour — delete the file (no-op if absent) and report cleared.
    const path = clearStore();
    printJson({ cleared: true, profile: null, path });
    return;
  }

  const { path } = removeProfile(target.name);
  printJson({ cleared: true, profile: target.name, path });
}
