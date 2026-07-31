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
import {
  runDeviceFlow,
  startDeviceFlow,
  pollDeviceToken,
} from "../device-flow.js";
import {
  readPendingDevice,
  writePendingDevice,
  clearPendingDevice,
  isPendingExpired,
} from "../pending-device.js";
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

/**
 * `--start`: ask the relay for a code pair, park it, and get out of the way.
 *
 * Prints the JSON envelope with the link and code ON STDOUT as well as the
 * human block on stderr, because the caller here is usually an agent relaying
 * the link into a conversation, and stdout is the channel it parses.
 */
async function runRegisterStart(opts: {
  url: string;
  name: string | undefined;
  profileName: string;
  printKey: boolean;
}): Promise<void> {
  const agentName = opts.name ?? defaultDeviceAgentName();
  let started;
  try {
    started = await startDeviceFlow({
      url: opts.url,
      name: agentName,
      cliVersion: VERSION,
    });
  } catch (e) {
    failFromDeviceError(e, "device authorization");
  }
  if (!started.supported) {
    fail(
      "this relay does not support browser approval (older relay) - run 'homespun agent register --no-device' and claim the agent afterwards",
      "device_flow_unsupported",
    );
  }
  const code = started.code;
  const expiresAt = new Date(
    Date.now() + (code.expires_in ?? 900) * 1000,
  ).toISOString();
  const savedTo = writePendingDevice({
    device_code: code.device_code,
    user_code: code.user_code,
    verification_uri_complete: code.verification_uri_complete,
    url: opts.url,
    name: agentName,
    profile: opts.profileName,
    expires_at: expiresAt,
  });
  printJson({
    state: "pending_approval",
    verification_uri_complete: code.verification_uri_complete,
    user_code: code.user_code,
    expires_in: code.expires_in ?? 900,
    expires_at: expiresAt,
    name: agentName,
    profile: opts.profileName,
    pending_saved_to: savedTo,
    next: "show the link and code to your human, then run 'homespun agent register --resume' once they say they approved it",
  });
}

/**
 * `--resume`: one poll, then a definite answer.
 *
 * Deliberately does NOT loop. The caller is an agent in a conversation: it
 * should ask the human whether they approved and try again, not hold a tool
 * call open, which is the failure this whole flag pair exists to remove.
 */
async function runRegisterResume(opts: {
  urlFlagGiven: boolean;
  url: string;
  printKey: boolean;
}): Promise<void> {
  const pending = readPendingDevice();
  if (pending === null) {
    fail(
      "no registration is waiting for approval - run 'homespun agent register --start' first",
      "no_pending_registration",
    );
  }
  // An explicit --url pointing somewhere else is a mistake worth naming: the
  // device_code is only valid on the relay that issued it, so polling another
  // would answer expired_token and read as "the code died" instead of "you
  // aimed at the wrong relay".
  if (opts.urlFlagGiven && opts.url !== pending.url) {
    fail(
      `the pending registration belongs to ${pending.url}, not ${opts.url} - drop --url, or run --start against this relay`,
      "invalid_args",
    );
  }
  if (isPendingExpired(pending)) {
    clearPendingDevice();
    fail(
      "the approval link expired before it was approved - run 'homespun agent register --start' again",
      "device_flow_expired",
    );
  }

  let outcome;
  try {
    outcome = await pollDeviceToken({
      url: pending.url,
      deviceCode: pending.device_code,
      cliVersion: VERSION,
    });
  } catch (e) {
    // A denial or expiry is terminal: drop the parked flow so the next
    // --resume says "nothing to resume" rather than re-reporting a dead code.
    if (
      e instanceof HomespunApiError &&
      (e.code === "device_flow_denied" || e.code === "device_flow_expired")
    ) {
      clearPendingDevice();
    }
    failFromDeviceError(e, "device authorization");
  }

  if (outcome.state !== "approved") {
    // Not an error in the flow's terms, but a non-zero exit so a script that
    // ignores the payload does not sail on believing it is registered.
    fail(
      `not approved yet - open ${pending.verification_uri_complete} and confirm the code ${pending.user_code}, then run 'homespun agent register --resume' again`,
      "not_approved_yet",
      undefined,
      { retryable: true },
    );
  }

  const savedTo = upsertProfile(
    pending.profile,
    { url: pending.url, apiKey: outcome.agent_key },
    true,
  );
  clearPendingDevice();
  const out: Record<string, unknown> = {
    agent_id: outcome.agent_id,
    key_prefix: apiKeyPrefix(outcome.agent_key),
    profile: pending.profile,
    saved_to: savedTo,
    registered_via: "device",
  };
  if (opts.printKey) out["api_key"] = outcome.agent_key;
  printJson(out);
}

/** Shared error mapping for both halves: same codes the blocking path uses. */
function failFromDeviceError(e: unknown, what: string): never {
  if (e instanceof HomespunApiError) {
    if (e.status === 426 && e.code === "cli_upgrade_required") {
      failUpgradeRequired(e);
    }
    if (e.status === 429) {
      fail(
        `${what} rate limit exceeded - try again later`,
        "rate_limited",
        undefined,
        {
          hint: e.hint,
          retryable: true,
          docs_url: e.docsUrl,
        },
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

  // ---- Two-phase device flow (--start / --resume) -------------------------
  //
  // For callers that CANNOT hold a blocking command open: a coding agent runs
  // register as one tool call, and the harness kills it long before a human
  // finds their phone. --start prints the link and exits; --resume collects the
  // key afterwards. See pending-device.ts for why this is not merely nicer.
  const wantStart = args.bools.has("start");
  const wantResume = args.bools.has("resume");
  if (wantStart && wantResume) {
    fail(
      "--start and --resume are the two halves of one flow; run --start, get the link approved, then run --resume",
      "invalid_args",
    );
  }
  if ((wantStart || wantResume) && args.bools.has("no-device")) {
    fail(
      "--no-device registers directly and has no approval step, so there is nothing to --start or --resume",
      "invalid_args",
    );
  }
  if ((wantStart || wantResume) && secret !== undefined && secret !== "") {
    fail(
      "a registration secret uses the direct path, which has no approval step to --start or --resume",
      "invalid_args",
    );
  }

  if (wantStart) {
    await runRegisterStart({ url, name, profileName, printKey: false });
    return;
  }
  if (wantResume) {
    await runRegisterResume({
      urlFlagGiven: args.flags.has("url"),
      url,
      printKey: args.bools.has("print-key"),
    });
    return;
  }

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
