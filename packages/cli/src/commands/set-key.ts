// `homespun agent set-key <key>` — write a fresh API key into the CLI config
// file. The companion to the human-side rotation flow on /my-agents: after
// the human regenerates a key in the browser, this command lands it on
// the agent's machine without making them hand-edit ~/.config/homespun/config.json.
//
// No relay round-trip: we trust the human-supplied key. The relay will
// reject it on the next call if it's wrong (401 invalid_api_key) — better
// than guessing here and adding a network hop for what's a local config
// write.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import {
  isValidProfileName,
  DEFAULT_PROFILE_NAME,
  readStore,
  resolveProfile,
  upsertProfile,
} from "../store.js";
import { printJson, fail } from "../output.js";

function keyPrefixOf(key: string): string {
  // Match the relay's keyPrefix() display width for "hs_" + 6 hex chars
  // (11 total). Falls back to the first 8 chars for any unrecognised shape.
  if (key.startsWith("hs_") && key.length >= 9) return key.slice(0, 9);
  return key.slice(0, 8);
}

export async function runSetKey(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("agent", "set-key"));

  const apiKey = args.positionals[0];
  if (!apiKey) {
    fail(
      "missing api-key — usage: homespun agent set-key <api-key>",
      "invalid_args",
    );
  }
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    fail("api-key must be a non-empty string", "invalid_args");
  }

  // Best-effort shape check. The relay generates `hs_<32 hex>`; we don't
  // reject other shapes outright (a future format change shouldn't strand
  // older CLIs), but we warn on something obviously wrong like leading
  // whitespace.
  const trimmed = apiKey.trim();
  if (trimmed !== apiKey) {
    fail(
      "api-key has surrounding whitespace — copy it without leading/trailing spaces",
      "invalid_args",
    );
  }

  // Profile selection mirrors `homespun agent register`: --profile flag →
  // HOMESPUN_PROFILE env → store's current_profile → 'default'.
  const profileFlag = args.flags.get("profile") ?? process.env.HOMESPUN_PROFILE;
  const store = readStore();
  const profileName =
    profileFlag !== undefined && profileFlag !== ""
      ? profileFlag
      : (store.currentProfile ?? DEFAULT_PROFILE_NAME);

  if (!isValidProfileName(profileName)) {
    fail(
      `invalid profile name '${profileName}' — letters, digits, _ and -, up to 32 chars`,
      "invalid_args",
    );
  }

  const urlFlag = args.flags.get("url");
  const patch: { apiKey: string; url?: string } = { apiKey };
  if (urlFlag !== undefined) patch.url = urlFlag;

  const saved = upsertProfile(profileName, patch);
  // Re-resolve so we report the prefix from the persisted value, not the
  // argument — defensive against future write-side normalisation.
  const after = readStore();
  const reread = resolveProfile(after, profileName);
  printJson({
    saved_to: saved,
    profile: profileName,
    key_prefix: keyPrefixOf(reread?.profile.apiKey ?? apiKey),
  });
}
