// Shared `<app>` resolution for every v2 CLI noun (`apps`, `data`, `deploy
// --app`): accepts either the App.id (cuid) or its slug, resolving a slug to
// an id via `GET /v1/apps?slug=` — spec-cli §3.2's "the single ergonomic
// concession beyond the raw /v1 shape."

import { HomespunApiError, type HomespunClient } from "@homespunapps/core";
import { fail } from "./output.js";

// cuid2 ids (Prisma's `@default(cuid())`) are lowercase alphanumeric,
// starting with a letter, 24+ chars. A slug is DNS-label-shaped (spec-schema
// §6 ruling 8) and always contains at least one hyphen in practice
// (`<adjective>-<noun>-<suffix>` for generated ones, or a short owner-chosen
// word) — but the deciding heuristic here is simply "looks like a cuid";
// anything else is treated as a slug and resolved via a lookup.
//
// This is a heuristic, NOT a proof: `public`/`private` apps allow any
// DNS-label-shaped owner-chosen slug (app-slug.ts's SLUG_RX), hyphens
// optional, so a 21+-char hyphen-free slug also matches CUID_RX. Rather than
// trust the shape alone, `resolveAppId` below verifies an id-shaped value
// against `GET /v1/apps/:id` and falls back to the slug lookup on a 404 —
// so a legit slug always resolves regardless of how it happens to be shaped.
const CUID_RX = /^[a-z][a-z0-9]{20,}$/;

function looksLikeId(value: string): boolean {
  return CUID_RX.test(value);
}

/**
 * Resolve a CLI-supplied `<app>` positional to an App.id. Values that look
 * like a cuid are tried as-is via `GET /v1/apps/:id` first (the fast, common
 * path); if that 404s — e.g. an owner-chosen slug that happens to be
 * hyphen-free and 21+ chars, matching the cuid heuristic — falls back to
 * `GET /v1/apps?slug=`. Values that don't look like a cuid skip straight to
 * the slug lookup. Fails with `app_not_found` if no app matches either way.
 */
export async function resolveAppId(
  client: HomespunClient,
  value: string,
): Promise<string> {
  if (looksLikeId(value)) {
    try {
      await client.getApp(value);
      return value;
    } catch (e) {
      if (!(e instanceof HomespunApiError && e.code === "app_not_found")) {
        throw e;
      }
      // Fall through: treat it as a slug instead.
    }
  }
  const page = await client.listApps({ status: "all", slug: value, limit: 1 });
  const match = page.items[0];
  if (!match) {
    fail(`no app found with slug '${value}'`, "app_not_found");
  }
  return match!.id;
}
