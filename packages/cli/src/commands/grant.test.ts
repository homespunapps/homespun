// Tests for `homespun grants` (M5): drives real command dispatch
// (mint/list/revoke) against a fake client stubbed via vi.mock on ../config.js,
// mirroring members.test.ts. Covers each verb, app-slug resolution, the pin
// mapping (row / where), the required-flag guards, and a relay error path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HomespunApiError } from "@homespunapps/core";

const fakeClient = {
  getApp: vi.fn(),
  listApps: vi.fn(),
  mintAppGrant: vi.fn(),
  listAppGrants: vi.fn(),
  revokeAppGrant: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import { runGrant } from "./grant.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

const GRANT_TEST_BOOLS = new Set(["help"]);

function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, GRANT_TEST_BOOLS);
}

const CUID = "appabcdefghijklmnopqrstu";

describe("runGrant dispatch", () => {
  let stdout: string;
  let stderr: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = "";
    stderr = "";
    exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      stdout += String(s);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr += String(s);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}__`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function run(tokens: string[]): Promise<void> {
    try {
      await runGrant(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  // ----- mint --------------------------------------------------------------

  it("mint calls mintAppGrant and prints the grant_url", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.mintAppGrant.mockResolvedValue({
      id: "grant_1",
      grant_url: "https://a.homespunapps.com/#g=gl_tok",
      role: "guest",
      mode: "multi",
      max_uses: null,
      expires_at: "2026-08-17T00:00:00.000Z",
    });

    await run(["mint", "--app", CUID, "--role", "guest"]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.mintAppGrant).toHaveBeenCalledWith(CUID, {
      role: "guest",
    });
    expect(JSON.parse(stdout).grant_url).toContain("#g=");
  });

  it("mint forwards mode / max-uses / ttl / label", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.mintAppGrant.mockResolvedValue({ id: "g" });

    await run([
      "mint",
      "--app",
      CUID,
      "--role",
      "guest",
      "--mode",
      "once",
      "--max-uses",
      "5",
      "--ttl",
      "3600",
      "--label",
      "beta",
    ]);

    expect(fakeClient.mintAppGrant).toHaveBeenCalledWith(CUID, {
      role: "guest",
      mode: "once",
      maxUses: 5,
      ttlSeconds: 3600,
      label: "beta",
    });
  });

  it("mint maps --pin-row to a rowKey pin", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.mintAppGrant.mockResolvedValue({ id: "g" });

    await run(["mint", "--app", CUID, "--role", "guest", "--pin-row", "r1"]);

    expect(fakeClient.mintAppGrant).toHaveBeenCalledWith(CUID, {
      role: "guest",
      pin: { rowKey: "r1" },
    });
  });

  it("mint maps --pin-where JSON to a where pin", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.mintAppGrant.mockResolvedValue({ id: "g" });

    await run([
      "mint",
      "--app",
      CUID,
      "--role",
      "guest",
      "--pin-where",
      '[{"field":"status","op":"eq","value":"open"}]',
    ]);

    expect(fakeClient.mintAppGrant).toHaveBeenCalledWith(CUID, {
      role: "guest",
      pin: { where: [{ field: "status", op: "eq", value: "open" }] },
    });
  });

  it("mint rejects --pin-row and --pin-where together", async () => {
    await run([
      "mint",
      "--app",
      CUID,
      "--role",
      "guest",
      "--pin-row",
      "r1",
      "--pin-where",
      "[]",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("mutually exclusive");
    expect(fakeClient.mintAppGrant).not.toHaveBeenCalled();
  });

  it("mint rejects a non-array --pin-where", async () => {
    await run(["mint", "--app", CUID, "--role", "guest", "--pin-where", "{}"]);
    expect(exitCode).toBe(1);
    expect(fakeClient.mintAppGrant).not.toHaveBeenCalled();
  });

  it("mint requires --app and --role", async () => {
    await run(["mint", "--role", "guest"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--app");
    vi.clearAllMocks();
    exitCode = undefined;
    stderr = "";
    await run(["mint", "--app", CUID]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--role");
    expect(fakeClient.mintAppGrant).not.toHaveBeenCalled();
  });

  // ----- list --------------------------------------------------------------

  it("list resolves a slug then prints the grants envelope", async () => {
    fakeClient.listApps.mockResolvedValue({ items: [{ id: "app_resolved" }] });
    fakeClient.listAppGrants.mockResolvedValue({
      grants: [{ id: "g1", role: "guest", active: true }],
    });

    await run(["list", "--app", "my-app"]);

    expect(fakeClient.listApps).toHaveBeenCalledWith({
      status: "all",
      slug: "my-app",
      limit: 1,
    });
    expect(fakeClient.listAppGrants).toHaveBeenCalledWith("app_resolved");
    expect(JSON.parse(stdout).grants[0].id).toBe("g1");
  });

  it("list requires --app", async () => {
    await run(["list"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--app");
    expect(fakeClient.listAppGrants).not.toHaveBeenCalled();
  });

  // ----- revoke ------------------------------------------------------------

  it("revoke calls revokeAppGrant and prints a receipt", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.revokeAppGrant.mockResolvedValue(undefined);

    await run(["revoke", "--app", CUID, "--grant", "g1"]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.revokeAppGrant).toHaveBeenCalledWith(CUID, "g1");
    expect(JSON.parse(stdout)).toEqual({
      revoked: true,
      app_id: CUID,
      grant_id: "g1",
    });
  });

  it("revoke requires --grant", async () => {
    await run(["revoke", "--app", CUID]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--grant");
    expect(fakeClient.revokeAppGrant).not.toHaveBeenCalled();
  });

  it("revoke surfaces a relay error via failFromError", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.revokeAppGrant.mockRejectedValue(
      new HomespunApiError(404, "app_not_found", "no such app"),
    );

    await run(["revoke", "--app", CUID, "--grant", "g1"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("app_not_found");
  });

  // ----- verb guards -------------------------------------------------------

  it("rejects an unknown verb", async () => {
    await run(["frobnicate", "--app", CUID]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown verb");
  });

  it("fails with a missing-verb message when no verb is given", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing verb");
  });
});
