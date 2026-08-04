// `homespun skill` — fetch the relay's SKILL.md, or just its version.
//
// The relay serves its skill at GET /skills/homespun/SKILL.md and its version
// at GET /skills/homespun/SKILL.md/version (see
// packages/relay/src/http/routes/skill.ts). The skill is auto-updating:
// the relay's deployed image owns both the body and the version, so the
// agent always reads what the relay it's actually talking to wants it
// to read.
//
// Three verbs:
//   `homespun skill show`      print the full markdown to stdout (the
//                            install / refresh path; pipe to a file).
//                            `--section <slug>` prints one reference section
//                            instead, which is how an agent holding the skill
//                            as a fetched blob follows a pointer that a
//                            file-based agent would follow with a plain read.
//   `homespun skill version`   print just the relay's skill version (the
//                            "is my local copy stale?" probe). The agent
//                            compares this to the `<!-- homespun skill v… -->`
//                            comment in its local skill file and re-runs
//                            `homespun skill show > <path>` when they differ.
//   `homespun skill sections`  list the reference sections that exist.
//
// Both are unauthenticated — the skill route is public on the relay and
// an agent on a too-old CLI must be able to read the upgrade instructions
// even before it has registered (or before its key was minted).

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { resolveRelayUrl } from "../config.js";
import { fail } from "../output.js";

import { VERSION } from "../version.js";

// Shared fetch with the consistent x-homespun-cli-version header (the skill
// routes are exempt from the version-skew middleware, but sending it lets
// access logs see which CLI versions are reading the skill).
async function fetchOrFail(url: string): Promise<Response> {
  try {
    return await fetch(url, {
      headers: { "x-homespun-cli-version": VERSION },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`could not reach ${url}: ${msg}`, "fetch_error");
  }
}

async function failOnNon2xx(res: Response, target: string): Promise<void> {
  if (res.ok) return;
  // 404 if the operator stripped the route, 5xx on a static-read failure.
  // Surface the body inline — it may carry a useful message.
  const body = await res.text().catch(() => "");
  fail(
    `relay returned ${res.status} for ${target}${
      body ? ": " + body.slice(0, 200) : ""
    }`,
    "relay_error",
  );
}

// `homespun skill show [--section <slug>]`: print the full skill, or one
// reference section of it.
//
// SKILL.md carries pointers to sections it does not include, so that an agent
// pays for them only when it needs them. An agent holding the skill as files on
// disk follows such a pointer by reading references/<slug>.md; an agent that
// fetched the skill over the wire has no such file, and `--section` is how it
// follows the same pointer. Without it the pointer would dangle for exactly the
// consumers this command exists to serve.
async function runSkillFetch(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("skill", "show"));

  const url = resolveRelayUrl(args);
  const section = args.flags.get("section");
  const target =
    section === undefined
      ? url + "/skills/homespun/SKILL.md"
      : `${url}/skills/homespun/references/${encodeURIComponent(section)}.md`;
  const res = await fetchOrFail(target);
  await failOnNon2xx(res, target);
  const text = await res.text();
  process.stdout.write(text);
  // Ensure the markdown ends with a newline so a pipe-reader (cat | xargs |
  // claude) sees a clean line-terminated boundary even if the relay served
  // a file without a trailing newline.
  if (!text.endsWith("\n")) process.stdout.write("\n");
}

// `homespun skill sections`: list the reference sections available. The index
// an agent needs when it holds SKILL.md as a fetched blob rather than a tree.
async function runSkillSections(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("skill", "sections"));

  const url = resolveRelayUrl(args);
  const target = url + "/skills/homespun/references";
  const res = await fetchOrFail(target);
  await failOnNon2xx(res, target);
  const body = (await res.json()) as { sections?: unknown };
  const sections = Array.isArray(body.sections) ? body.sections : [];
  process.stdout.write(JSON.stringify({ sections }) + "\n");
}

// `homespun skill version [--plain]` — print just the version.
async function runSkillVersion(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("skill", "version"));

  const url = resolveRelayUrl(args);
  const target = url + "/skills/homespun/SKILL.md/version";
  const res = await fetchOrFail(target);
  await failOnNon2xx(res, target);

  // The relay returns { version: "x.y.z" }. We tolerate a missing/
  // malformed body so a misbehaving relay can't crash this probe — fall
  // through to "0.0.0" the same way the relay does when its own SKILL.md
  // lacks a version comment.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const version =
    body !== null &&
    typeof body === "object" &&
    typeof (body as { version?: unknown }).version === "string"
      ? (body as { version: string }).version
      : "0.0.0";

  if (args.bools.has("plain")) {
    process.stdout.write(version + "\n");
  } else {
    process.stdout.write(JSON.stringify({ version }) + "\n");
  }
}

export async function runSkill(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "show":
      await runSkillFetch(args);
      break;
    case "version":
      await runSkillVersion(args);
      break;
    case "sections":
      await runSkillSections(args);
      break;
    case undefined:
      fail(
        "missing verb. Usage: homespun skill <show|version|sections> (run 'homespun skill --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown skill verb '${sub}': expected show|version|sections (run 'homespun skill --help')`,
        "invalid_args",
      );
  }
}
