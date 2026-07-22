// `homespun config <verb>` — inspect and manage the multi-profile CLI config.
//
//   show              describe the resolved (url, api_key) the CLI would use
//   list              list saved profiles (names + URLs + current marker)
//   use <name>        switch the active profile
//   add <name>        manually add a profile (for keys obtained out of band)
//   rm <name>         delete a profile
//
// All four mutating verbs operate on the multi-profile store at
// $XDG_CONFIG_HOME/homespun/config.json. See store.ts for the layout. They make
// NO network calls — purely local config management.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { describeConfig } from "../config.js";
import {
  isValidProfileName,
  readStore,
  removeProfile,
  setCurrentProfile,
  storePath,
  upsertProfile,
} from "../store.js";
import { printJson, fail } from "../output.js";

const showHelp = `homespun config show — show the resolved relay config

Usage:
  homespun config show [options]

Reports the (url, api_key) the CLI would use right now, and where each value
came from (flag / env / profile / none). Purely inspects flags + env + the
saved config file; makes NO network call.

The API key is never printed in full — only a short masked prefix.

Options:
  --url <url>         Relay base URL (overrides HOMESPUN_URL) — affects the report.
  --api-key <key>     Agent API key (overrides HOMESPUN_API_KEY) — affects the report.
  --profile <name>    Profile to resolve against — affects the report.
  -h, --help          Show this help.

Output (stdout, JSON):
  {
    url, url_source,        flag | env | profile | none
    key_prefix, key_source, flag | env | profile | none
    profile, profile_source,  active profile name + how it was chosen
    config_path
  }`;

const listHelp = `homespun config list — list saved profiles

Usage:
  homespun config list [options]

Prints every profile in the local config file, with its URL and a masked
key prefix. The active profile carries 'current: true'.

Options:
  -h, --help          Show this help.

Output (stdout, JSON):
  {
    current: <name|null>,
    profiles: [ { name, url, key_prefix, current }, … ],
    config_path
  }`;

const useHelp = `homespun config use <profile> — switch the active profile

Usage:
  homespun config use <profile>

Sets 'current_profile' in the config file. The named profile must exist
(create it first with 'homespun agent register --profile <name>' or
'homespun config add <name>').

Options:
  -h, --help          Show this help.

Output (stdout, JSON):
  { profile, saved_to }`;

const addHelp = `homespun config add <profile> — add a profile manually

Usage:
  homespun config add <profile> --url <url> --api-key <api-key>

Saves a (url, api_key) pair under <profile> without contacting the relay.
Use this when an operator handed you an API key out of band (e.g. a closed-
registration relay) — for self-register and secret-mode relays, prefer
'homespun agent register --profile <name>'.

If <profile> already exists, the existing values are overwritten.

Options:
  --url <url>         Relay base URL.            REQUIRED.
  --api-key <key>     Agent API key.             REQUIRED.
  -h, --help          Show this help.

Output (stdout, JSON):
  { profile, saved_to }

Does NOT change 'current_profile' unless this is the first profile being
added. Use 'homespun config use' afterwards to switch.`;

const rmHelp = `homespun config rm <profile> — delete a profile

Usage:
  homespun config rm <profile>

Removes the named profile from the config file. If it was the active profile,
'current_profile' is cleared (the next command falls back to env / default
URL until another profile is selected via --profile or 'homespun config use').

Options:
  -h, --help          Show this help.

Output (stdout, JSON):
  { profile, was_current, path }`;

async function runConfigShow(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("config", "show"));
  printJson(describeConfig(args));
}

function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  if (key.startsWith("hs_") && key.length >= 9) return key.slice(0, 9) + "…";
  return key.slice(0, 8) + "…";
}

async function runConfigList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("config", "list"));
  const store = readStore();
  const profiles = Object.entries(store.profiles)
    .map(([name, p]) => ({
      name,
      url: p.url ?? null,
      key_prefix: maskKey(p.apiKey),
      current: name === store.currentProfile,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  printJson({
    current: store.currentProfile ?? null,
    profiles,
    config_path: storePath(),
  });
}

async function runConfigUse(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("config", "use"));
  const name = args.positionals[1];
  if (!name) {
    fail(
      "missing profile name — usage: homespun config use <profile>",
      "invalid_args",
    );
  }
  let savedTo: string;
  try {
    savedTo = setCurrentProfile(name);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "config_error");
  }
  printJson({ profile: name, saved_to: savedTo });
}

async function runConfigAdd(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("config", "add"));
  const name = args.positionals[1];
  if (!name) {
    fail(
      "missing profile name — usage: homespun config add <profile> --url <url> --api-key <key>",
      "invalid_args",
    );
  }
  if (!isValidProfileName(name)) {
    fail(
      `invalid profile name '${name}' — letters, digits, _ and -, up to 32 chars`,
      "invalid_args",
    );
  }
  const url = args.flags.get("url");
  const apiKey = args.flags.get("api-key");
  if (!url) {
    fail(
      "--url is required — usage: homespun config add <profile> --url <url> --api-key <key>",
      "invalid_args",
    );
  }
  if (!apiKey) {
    fail(
      "--api-key is required — usage: homespun config add <profile> --url <url> --api-key <key>",
      "invalid_args",
    );
  }
  // setCurrent=false: adding a profile shouldn't silently switch the user
  // off whatever they were on. They use `homespun config use` after to flip.
  // EXCEPT: if there's no current profile yet (first add), upsertProfile
  // sets it automatically — that's the correct fresh-install behaviour.
  const savedTo = upsertProfile(
    name,
    { url: url.replace(/\/$/, ""), apiKey },
    false,
  );
  printJson({ profile: name, saved_to: savedTo });
}

async function runConfigRm(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("config", "rm"));
  const name = args.positionals[1];
  if (!name) {
    fail(
      "missing profile name — usage: homespun config rm <profile>",
      "invalid_args",
    );
  }
  let result: { path: string; was_current: boolean };
  try {
    result = removeProfile(name);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), "config_error");
  }
  printJson({
    profile: name,
    was_current: result.was_current,
    path: result.path,
  });
}

export async function runConfig(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];

  // Per-verb --help: 'homespun config show --help' etc. Caught before dispatch
  // so each runner doesn't need to repeat the check.
  if (args.bools.has("help") && verb !== undefined) {
    const helps: Record<string, string> = {
      show: showHelp,
      list: listHelp,
      use: useHelp,
      add: addHelp,
      rm: rmHelp,
    };
    if (helps[verb] !== undefined) {
      process.stdout.write(helps[verb] + "\n");
      return;
    }
  }

  switch (verb) {
    case "show":
      await runConfigShow(args);
      break;
    case "list":
      await runConfigList(args);
      break;
    case "use":
      await runConfigUse(args);
      break;
    case "add":
      await runConfigAdd(args);
      break;
    case "rm":
      await runConfigRm(args);
      break;
    case undefined:
      fail(
        "missing verb — usage: homespun config <show|list|use|add|rm> (run 'homespun config --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown config verb '${verb}' — expected show|list|use|add|rm (run 'homespun config --help')`,
        "invalid_args",
      );
  }
}
