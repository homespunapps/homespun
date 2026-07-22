// Relay connection config: HOMESPUN_URL / HOMESPUN_API_KEY from the environment,
// overridable per-invocation with --url / --api-key. Profile selection via
// --profile / HOMESPUN_PROFILE picks WHICH (url, api_key) pair to load from
// the saved store. See store.ts for the on-disk layout.

import { HomespunClient } from "@homespunapps/core";
import type { ParsedArgs } from "./argv.js";
import { fail } from "./output.js";
import { readStore, resolveProfile, storePath } from "./store.js";
import { VERSION } from "./version.js";

export interface ResolvedConfig {
  url: string;
  apiKey: string;
}

/**
 * Where a resolved config value came from. `"profile"` means it came from
 * a named profile in the store; `"none"` means nothing was set.
 */
export type ConfigSource = "flag" | "env" | "profile" | "none";

/** A non-failing description of the resolved relay config, for `homespun config`. */
export interface ConfigDescription {
  url: string | null;
  url_source: ConfigSource;
  key_prefix: string | null;
  key_source: ConfigSource;
  /** Profile name actively in use, or null if the resolution skipped the store. */
  profile: string | null;
  /** How `profile` was chosen. */
  profile_source: "flag" | "env" | "store" | "none";
  config_path: string;
}

/**
 * The hosted Homespun relay. Used as the relay-URL fallback so a fresh user only
 * needs an API key — `homespun agent register` against the hosted relay, then go. A
 * self-hoster overrides it with `--url` / `HOMESPUN_URL` / `homespun agent register --url`.
 */
export const DEFAULT_RELAY_URL = "https://homespun.dev";

/**
 * Pick the profile-selector source — explicit flag wins over env, env wins
 * over the store's `current_profile`. Returns both the selector value and
 * where it came from so `describeConfig` can report it.
 */
function pickProfileSelector(args: ParsedArgs): {
  selector: string | undefined;
  source: "flag" | "env" | "store" | "none";
} {
  const flag = args.flags.get("profile");
  if (flag !== undefined && flag !== "") {
    return { selector: flag, source: "flag" };
  }
  const env = process.env.HOMESPUN_PROFILE;
  if (env !== undefined && env !== "") {
    return { selector: env, source: "env" };
  }
  return { selector: undefined, source: "none" };
}

/**
 * Resolve url + apiKey and report the SOURCE of each, WITHOUT making a network
 * call and WITHOUT failing on a missing value (unlike `resolveConfig`). The
 * full API key is never returned — only a short, masked prefix.
 *
 * Resolution model:
 *   - `--url` / `HOMESPUN_URL` and `--api-key` / `HOMESPUN_API_KEY` are DIRECT values:
 *     they override everything, including any active profile. CI scripts that
 *     set those env vars never need to think about profiles.
 *   - Otherwise the profile selector (`--profile` flag → `HOMESPUN_PROFILE` env →
 *     store's `current_profile`) picks one profile out of the store; the
 *     selected profile's `url` and `api_key` are used.
 *   - Final fallback for URL is `DEFAULT_RELAY_URL`.
 */
export function describeConfig(args: ParsedArgs): ConfigDescription {
  const store = readStore();
  const { selector, source: selectorSource } = pickProfileSelector(args);

  // The store gets visited only if --profile flag is set (explicit
  // selector) and the store has a matching profile, OR the store has a
  // current_profile and no explicit selector overrides it. `resolveProfile`
  // throws on a typo'd selector; we swallow that here so describeConfig
  // can't crash a `homespun config show` — resolveConfig() is the one that
  // surfaces the error when the caller actually needs a key.
  let active: {
    name: string;
    profile: { url?: string; apiKey?: string };
  } | null;
  try {
    active = resolveProfile(store, selector);
  } catch {
    active = null;
  }

  // URL precedence: --url flag > HOMESPUN_URL env > active profile's url.
  // The default URL is shown only when nothing else is set.
  let url: string | null = null;
  let urlSource: ConfigSource = "none";
  if (args.flags.get("url")) {
    url = args.flags.get("url")!;
    urlSource = "flag";
  } else if (process.env.HOMESPUN_URL) {
    url = process.env.HOMESPUN_URL;
    urlSource = "env";
  } else if (active && active.profile.url) {
    url = active.profile.url;
    urlSource = "profile";
  }

  // API key precedence: --api-key flag > HOMESPUN_API_KEY env > active profile's api_key.
  let apiKey: string | null = null;
  let keySource: ConfigSource = "none";
  if (args.flags.get("api-key")) {
    apiKey = args.flags.get("api-key")!;
    keySource = "flag";
  } else if (process.env.HOMESPUN_API_KEY) {
    apiKey = process.env.HOMESPUN_API_KEY;
    keySource = "env";
  } else if (active && active.profile.apiKey) {
    apiKey = active.profile.apiKey;
    keySource = "profile";
  }

  return {
    url: url ? url.replace(/\/$/, "") : null,
    url_source: urlSource,
    key_prefix: apiKey ? apiKey.slice(0, 10) + "…" : null,
    key_source: keySource,
    profile: active ? active.name : null,
    profile_source: selectorSource,
    config_path: storePath(),
  };
}

/**
 * Resolve relay URL + API key. Precedence (highest first):
 *   url:    --url flag  → HOMESPUN_URL env  → active profile's url   → DEFAULT_RELAY_URL
 *   apiKey: --api-key   → HOMESPUN_API_KEY  → active profile's api_key
 * "Active profile" is chosen by `--profile` / `HOMESPUN_PROFILE` / the store's
 * `current_profile`. A typo'd `--profile dev` fails fast with `config_error`
 * — we never silently fall back to a different relay.
 */
export function resolveConfig(args: ParsedArgs): ResolvedConfig {
  const store = readStore();
  const { selector } = pickProfileSelector(args);
  let active: {
    name: string;
    profile: { url?: string; apiKey?: string };
  } | null;
  try {
    active = resolveProfile(store, selector);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "config_error");
  }

  const url =
    args.flags.get("url") ??
    process.env.HOMESPUN_URL ??
    active?.profile.url ??
    DEFAULT_RELAY_URL;
  const apiKey =
    args.flags.get("api-key") ??
    process.env.HOMESPUN_API_KEY ??
    active?.profile.apiKey ??
    "";

  if (!apiKey) {
    fail(
      "missing API key: set HOMESPUN_API_KEY, pass --api-key <key>, or run 'homespun agent register'",
      "config_error",
    );
  }
  return { url: url.replace(/\/$/, ""), apiKey };
}

/** Build a HomespunClient from resolved config. */
export function makeClient(args: ParsedArgs): HomespunClient {
  const cfg = resolveConfig(args);
  return new HomespunClient({
    url: cfg.url,
    apiKey: cfg.apiKey,
    // Sent as `x-homespun-cli-version` on every relay request so the relay can
    // return 426 cli_upgrade_required when this CLI is too old. Single
    // source: ./version.ts.
    cliVersion: VERSION,
  });
}

/**
 * Resolve just the relay URL — same precedence as `resolveConfig` but
 * without insisting on an API key. For commands that hit unauthenticated
 * relay routes (e.g. `homespun skill` → GET /skills/homespun/SKILL.md).
 */
export function resolveRelayUrl(args: ParsedArgs): string {
  const store = readStore();
  const { selector } = pickProfileSelector(args);
  let active: { name: string; profile: { url?: string } } | null;
  try {
    active = resolveProfile(store, selector);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "config_error");
  }
  const url =
    args.flags.get("url") ??
    process.env.HOMESPUN_URL ??
    active?.profile.url ??
    DEFAULT_RELAY_URL;
  return url.replace(/\/$/, "");
}
