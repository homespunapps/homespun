// Tests for `resolveAppId` — the shared `<app>` (id-or-slug) resolver used
// by every v2 CLI noun. Focus: the cuid-vs-slug heuristic (CUID_RX) is
// best-effort, not a proof — a valid, hyphen-free, 21+-char owner-chosen
// slug (public/private visibility allows any DNS-label-shaped slug, hyphens
// optional) also matches it. `resolveAppId` must still resolve such a slug
// correctly rather than spuriously failing with `app_not_found` (regression
// coverage for the resolve-app cuid-heuristic bug found in PR #633 review).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HomespunApiError } from "@homespunapps/core";
import type { HomespunClient } from "@homespunapps/core";
import { resolveAppId } from "./resolve-app.js";

function fakeClient(overrides: {
  getApp?: (id: string) => Promise<unknown>;
  listApps?: (opts: unknown) => Promise<{ items: Array<{ id: string }> }>;
}): HomespunClient {
  return {
    getApp: overrides.getApp ?? vi.fn(),
    listApps: overrides.listApps ?? vi.fn(),
  } as unknown as HomespunClient;
}

let exitCode: number | undefined;
let stderr: string;

beforeEach(() => {
  exitCode = undefined;
  stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += String(s);
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  // fail() calls process.exit(1); throw instead so the test can catch it.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveAppId", () => {
  it("uses a cuid-shaped value as-is once GET /v1/apps/:id confirms it exists", async () => {
    const getApp = vi.fn().mockResolvedValue({ id: "cabcdefghijklmnopqrstuv" });
    const listApps = vi.fn();
    const client = fakeClient({ getApp, listApps });

    const id = await resolveAppId(client, "cabcdefghijklmnopqrstuv");

    expect(id).toBe("cabcdefghijklmnopqrstuv");
    expect(getApp).toHaveBeenCalledWith("cabcdefghijklmnopqrstuv");
    expect(listApps).not.toHaveBeenCalled();
  });

  it("skips straight to the slug lookup for a value that isn't cuid-shaped", async () => {
    const getApp = vi.fn();
    const listApps = vi.fn().mockResolvedValue({ items: [{ id: "app_1" }] });
    const client = fakeClient({ getApp, listApps });

    const id = await resolveAppId(client, "my-app");

    expect(id).toBe("app_1");
    expect(getApp).not.toHaveBeenCalled();
    expect(listApps).toHaveBeenCalledWith({
      status: "all",
      slug: "my-app",
      limit: 1,
    });
  });

  it("falls back to a slug lookup when a 21+-char hyphen-free slug 404s as an id (regression)", async () => {
    // This slug is hyphen-free and 21+ chars, so it matches the cuid
    // heuristic (CUID_RX) exactly like a real cuid would — the pre-fix bug
    // treated it as an id and gave up with app_not_found instead of ever
    // trying it as a slug.
    const ownerChosenSlug = "abcdefghijklmnopqrstuvwxyz";
    const getApp = vi
      .fn()
      .mockRejectedValue(
        new HomespunApiError(404, "app_not_found", "not found"),
      );
    const listApps = vi
      .fn()
      .mockResolvedValue({ items: [{ id: "app_slug_1" }] });
    const client = fakeClient({ getApp, listApps });

    const id = await resolveAppId(client, ownerChosenSlug);

    expect(id).toBe("app_slug_1");
    expect(getApp).toHaveBeenCalledWith(ownerChosenSlug);
    expect(listApps).toHaveBeenCalledWith({
      status: "all",
      slug: ownerChosenSlug,
      limit: 1,
    });
  });

  it("fails with app_not_found when neither the id lookup nor the slug lookup match", async () => {
    const getApp = vi
      .fn()
      .mockRejectedValue(
        new HomespunApiError(404, "app_not_found", "not found"),
      );
    const listApps = vi.fn().mockResolvedValue({ items: [] });
    const client = fakeClient({ getApp, listApps });

    await expect(
      resolveAppId(client, "abcdefghijklmnopqrstuvwxyz"),
    ).rejects.toThrow("__exit_1__");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("app_not_found");
  });

  it("propagates a non-404 error from the id lookup instead of silently falling back", async () => {
    const getApp = vi
      .fn()
      .mockRejectedValue(new HomespunApiError(500, "internal", "boom"));
    const listApps = vi.fn();
    const client = fakeClient({ getApp, listApps });

    await expect(
      resolveAppId(client, "abcdefghijklmnopqrstuvwxyz"),
    ).rejects.toThrow(HomespunApiError);
    expect(listApps).not.toHaveBeenCalled();
  });
});
