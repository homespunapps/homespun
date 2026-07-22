// Fetch the relay's auto-updating SKILL.md over plain HTTP.
//
// Mirrors `homespun skill show|version` (packages/cli/src/commands/skill.ts): the
// relay serves its skill at GET /skills/homespun/SKILL.md and the version at GET
// /skills/homespun/SKILL.md/version. Both routes are UNAUTHENTICATED — no API key
// needed — so an MCP client can self-teach the Homespun workflow before (or without)
// provisioning a key. We don't go through HomespunClient here precisely because no
// auth is required and the skill routes are exempt from the version-skew check.

import { VERSION } from "./version.js";

/**
 * GET the relay's full SKILL.md markdown. `version: true` instead fetches just
 * the relay's reported skill version (the "is my local copy stale?" probe).
 * Throws on a non-2xx or network failure with a message the tool layer can
 * surface.
 */
export async function fetchSkill(
  relayUrl: string,
  opts: { version?: boolean } = {},
): Promise<{ markdown?: string; version?: string }> {
  const base = relayUrl.replace(/\/$/, "");
  if (opts.version) {
    const target = base + "/skills/homespun/SKILL.md/version";
    const res = await fetchOrThrow(target);
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
    return { version };
  }
  const target = base + "/skills/homespun/SKILL.md";
  const res = await fetchOrThrow(target);
  const markdown = await res.text();
  return { markdown };
}

/**
 * GET the relay's MCP-flavoured guide (the conceptual core + MCP tool-call
 * invocation grammar) from GET /skills/homespun/MCP.md, or just its version from
 * GET /skills/homespun/MCP.md/version. This is what an MCP consumer should read
 * (not the CLI-grammar SKILL.md). Served unauthenticated, same as the skill.
 */
export async function fetchMcpGuide(
  relayUrl: string,
  opts: { version?: boolean } = {},
): Promise<{ markdown?: string; version?: string }> {
  const base = relayUrl.replace(/\/$/, "");
  if (opts.version) {
    const res = await fetchOrThrow(base + "/skills/homespun/MCP.md/version");
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
    return { version };
  }
  const res = await fetchOrThrow(base + "/skills/homespun/MCP.md");
  const markdown = await res.text();
  return { markdown };
}

async function fetchOrThrow(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "x-homespun-cli-version": VERSION } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`could not reach ${url}: ${msg}`, { cause: e });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `relay returned ${res.status} for ${url}${
        body ? ": " + body.slice(0, 200) : ""
      }`,
    );
  }
  return res;
}
