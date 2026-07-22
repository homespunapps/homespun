// `homespun agent register` - provision an agent API key from the relay.
//
// This is the one command that needs no API key: it is the call that obtains
// one. Two paths:
//
//   DEVICE FLOW (default) - RFC 8628 style browser approval. The CLI asks the
//   relay for a device_code + user_code pair, prints a verification URL the
//   human can open on ANY device, and polls until the human approves. The
//   resulting agent is already OWNED by the approving human (no separate
//   `homespun agent claim` step needed).
//
//   DIRECT (fallback) - plain POST /v1/register, the pre-device-flow path.
//   Used when the relay 404s the device endpoints (older relay), when a
//   registration secret is supplied (REGISTRATION_MODE=secret relays), or on
//   --no-device. Direct-registered agents are unowned until claimed.
//
// On success the key (and relay URL) are persisted under a named profile in
// the CLI config file, so every later command works with only HOMESPUN_URL (or
// nothing) set.

import { hostname } from "node:os";
import { registerAgent, HomespunApiError } from "@homespunapps/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { DEFAULT_RELAY_URL } from "../config.js";
import { runDeviceFlow } from "../device-flow.js";
import { printJson, fail, failUpgradeRequired } from "../output.js";
import {
  isValidProfileName,
  DEFAULT_PROFILE_NAME,
  readStore,
  resolveProfile,
  upsertProfile,
} from "../store.js";
import { VERSION } from "../version.js";

/**
 * Default agent name for the device flow: the consent screen must name what
 * the human is approving, so an unnamed agent gets "cli-<hostname>" instead
 * of the relay's unhelpful generic default. Control characters are stripped
 * and the result clamped to the relay's 64-char cap.
 */
export function defaultDeviceAgentName(host: string = hostname()): string {
  let cleaned = "";
  for (const ch of host.trim()) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    cleaned += ch;
  }
  const name = `cli-${cleaned}`.slice(0, 64).trim();
  return name.length > "cli-".length ? name : "cli-agent";
}

/** Compute the display prefix of an API key, mirroring the relay's rule. */
function apiKeyPrefix(key: string): string {
  return key.startsWith("hs_") ? key.slice(0, 9) : key.slice(0, 8);
}

export async function runRegister(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("agent", "register"));

  // Profile selection for the WRITE side: --profile flag → HOMESPUN_PROFILE env
  // → the store's current profile → DEFAULT_PROFILE_NAME ('default') for
  // a fresh install. We deliberately don't fall through to "no profile, use
  // a fresh name" - the agent needs to end up somewhere callable, and
  // 'default' is a stable, predictable home.
  const profileFlag = args.flags.get("profile") ?? process.env.HOMESPUN_PROFILE;
  const store = readStore();
  const profileName =
    profileFlag !== undefined && profileFlag !== ""
      ? profileFlag
      : (store.currentProfile ?? DEFAULT_PROFILE_NAME);

  if (!isValidProfileName(profileName)) {
    fail(
      `invalid profile name '${profileName}' - letters, digits, _ and -, up to 32 chars`,
      "invalid_args",
    );
  }

  // URL precedence for the relay we're registering against:
  //   --url flag > HOMESPUN_URL env > target-profile's existing url > default.
  // The "target profile's url" path means re-running `homespun agent register
  // --profile dev` against a profile that already exists keeps hitting the
  // same dev relay without retyping --url.
  let activeUrl: string | undefined;
  try {
    const active = resolveProfile(store, profileFlag);
    activeUrl = active?.profile.url;
  } catch {
    // Selector didn't resolve - fine on register: we're about to create it.
    activeUrl = undefined;
  }
  const url = (
    args.flags.get("url") ??
    process.env.HOMESPUN_URL ??
    activeUrl ??
    DEFAULT_RELAY_URL
  ).replace(/\/$/, "");

  const name = args.flags.get("name");
  const secret =
    args.flags.get("secret") ??
    process.env.HOMESPUN_REGISTER_SECRET ??
    undefined;

  // The device flow is the default. A registration secret implies a
  // REGISTRATION_MODE=secret relay whose operator hands out direct access,
  // and --no-device is the explicit opt-out (CI, headless-with-no-human).
  const wantDevice =
    !args.bools.has("no-device") && (secret === undefined || secret === "");

  if (wantDevice) {
    try {
      const outcome = await runDeviceFlow({
        url,
        name: name ?? defaultDeviceAgentName(),
        cliVersion: VERSION,
      });
      if (outcome.supported) {
        const savedTo = upsertProfile(
          profileName,
          { url, apiKey: outcome.agent_key },
          true,
        );
        const out: Record<string, unknown> = {
          agent_id: outcome.agent_id,
          key_prefix: apiKeyPrefix(outcome.agent_key),
          profile: profileName,
          saved_to: savedTo,
          registered_via: "device",
        };
        if (args.bools.has("print-key")) {
          out["api_key"] = outcome.agent_key;
        }
        printJson(out);
        return;
      }
      // 404 on /v1/device/code: an older relay. Fall through to the direct
      // path with a note so the behavior change is visible, not silent.
      process.stderr.write(
        "note: this relay does not support browser approval (older relay); " +
          "falling back to direct registration. The agent will need " +
          "'homespun agent claim <code>' to get an owner.\n",
      );
    } catch (e) {
      if (e instanceof HomespunApiError) {
        if (e.status === 426 && e.code === "cli_upgrade_required") {
          failUpgradeRequired(e);
        }
        if (e.status === 429) {
          fail(
            "device authorization rate limit exceeded - try again later",
            "rate_limited",
            undefined,
            { hint: e.hint, retryable: true, docs_url: e.docsUrl },
          );
        }
        fail(e.message, e.code, e.details, {
          hint: e.hint,
          retryable: e.retryable,
          docs_url: e.docsUrl,
        });
      }
      fail(e instanceof Error ? e.message : String(e), "internal");
    }
  }

  let result;
  try {
    result = await registerAgent({
      url,
      ...(name !== undefined ? { name } : {}),
      ...(secret !== undefined && secret !== "" ? { secret } : {}),
      cliVersion: VERSION,
    });
  } catch (e) {
    if (e instanceof HomespunApiError) {
      // 426 cli_upgrade_required goes through the shared upgrade-message
      // path (stderr block + exit 75) so the SKILL.md's instructions to the
      // agent's harness fire on `homespun agent register` too.
      if (e.status === 426 && e.code === "cli_upgrade_required") {
        failUpgradeRequired(e);
      }
      if (e.status === 429) {
        fail(
          "registration rate limit exceeded - try again later",
          "rate_limited",
          undefined,
          { hint: e.hint, retryable: e.retryable, docs_url: e.docsUrl },
        );
      }
      fail(e.message, e.code, e.details, {
        hint: e.hint,
        retryable: e.retryable,
        docs_url: e.docsUrl,
      });
    }
    fail(e instanceof Error ? e.message : String(e), "internal");
  }

  // Save under the chosen profile. We pass setCurrent=true: the user just
  // registered against this relay, so the only sensible follow-up is to
  // start using it. The previous behaviour (one global URL+key) is exactly
  // the single-profile case of this.
  const savedTo = upsertProfile(
    profileName,
    { url, apiKey: result.api_key },
    true,
  );

  const out: Record<string, unknown> = {
    agent_id: result.agent_id,
    key_prefix: result.key_prefix,
    profile: profileName,
    saved_to: savedTo,
    registered_via: "direct",
  };
  if (args.bools.has("print-key")) {
    out["api_key"] = result.api_key;
  }
  printJson(out);
}
