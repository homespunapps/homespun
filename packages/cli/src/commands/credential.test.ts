// Tests for `homespun credentials` (#1354, #1355, #1363): drives real command
// dispatch (mint/list/pause/resume/rotate/revoke) against a fake client
// stubbed via vi.mock on ../config.js, mirroring grant.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HomespunApiError } from "@homespunapps/core";

const fakeClient = {
  getApp: vi.fn(),
  listApps: vi.fn(),
  mintAppCredential: vi.fn(),
  listAppCredentials: vi.fn(),
  pauseAppCredential: vi.fn(),
  resumeAppCredential: vi.fn(),
  rotateAppCredential: vi.fn(),
  revokeAppCredential: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import { runCredential } from "./credential.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

const CREDENTIAL_TEST_BOOLS = new Set(["help", "members", "no-expiry"]);

function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, CREDENTIAL_TEST_BOOLS);
}

const CUID = "appabcdefghijklmnopqrstu";

describe("runCredential dispatch", () => {
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
      await runCredential(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  // ----- mint --------------------------------------------------------------

  it("mint calls mintAppCredential and prints the raw token", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.mintAppCredential.mockResolvedValue({
      id: "cred_1",
      token: "hsc_rawtoken",
      token_prefix: "hsc_rawtoke",
      mode: "explicit",
      grants: [],
      members: false,
      label: null,
      expires_at: "2027-08-01T00:00:00.000Z",
    });

    await run(["mint", "--app", CUID]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.mintAppCredential).toHaveBeenCalledWith(CUID, {});
    expect(JSON.parse(stdout).token).toBe("hsc_rawtoken");
  });

  it("mint forwards mode / grants / members / label / ttl", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.mintAppCredential.mockResolvedValue({ id: "c" });

    await run([
      "mint",
      "--app",
      CUID,
      "--mode",
      "following",
      "--grants",
      '[{"collection":"orders","ops":["read","create"],"scope":"own"}]',
      "--members",
      "--label",
      "backend",
      "--ttl",
      "3600",
    ]);

    expect(fakeClient.mintAppCredential).toHaveBeenCalledWith(CUID, {
      mode: "following",
      grants: [{ collection: "orders", ops: ["read", "create"], scope: "own" }],
      members: true,
      label: "backend",
      ttlSeconds: 3600,
    });
  });

  it("mint --no-expiry sends ttlSeconds: null", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.mintAppCredential.mockResolvedValue({ id: "c" });

    await run(["mint", "--app", CUID, "--no-expiry"]);

    expect(fakeClient.mintAppCredential).toHaveBeenCalledWith(CUID, {
      ttlSeconds: null,
    });
  });

  it("mint rejects --ttl and --no-expiry together", async () => {
    await run(["mint", "--app", CUID, "--ttl", "10", "--no-expiry"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("mutually exclusive");
    expect(fakeClient.mintAppCredential).not.toHaveBeenCalled();
  });

  it("mint rejects an invalid --mode", async () => {
    await run(["mint", "--app", CUID, "--mode", "bogus"]);
    expect(exitCode).toBe(1);
    expect(fakeClient.mintAppCredential).not.toHaveBeenCalled();
  });

  it("mint rejects malformed --grants JSON", async () => {
    await run(["mint", "--app", CUID, "--grants", "not json"]);
    expect(exitCode).toBe(1);
    expect(fakeClient.mintAppCredential).not.toHaveBeenCalled();
  });

  it("mint rejects a non-array --grants", async () => {
    await run(["mint", "--app", CUID, "--grants", "{}"]);
    expect(exitCode).toBe(1);
    expect(fakeClient.mintAppCredential).not.toHaveBeenCalled();
  });

  it("mint requires --app", async () => {
    await run(["mint"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--app");
    expect(fakeClient.mintAppCredential).not.toHaveBeenCalled();
  });

  // ----- list ----------------------------------------------------------------

  it("list resolves a slug then prints the credentials envelope", async () => {
    fakeClient.listApps.mockResolvedValue({ items: [{ id: "app_resolved" }] });
    fakeClient.listAppCredentials.mockResolvedValue({
      credentials: [{ id: "c1", active: true }],
    });

    await run(["list", "--app", "my-app"]);

    expect(fakeClient.listApps).toHaveBeenCalledWith({
      status: "all",
      slug: "my-app",
      limit: 1,
    });
    expect(fakeClient.listAppCredentials).toHaveBeenCalledWith("app_resolved");
    expect(JSON.parse(stdout).credentials[0].id).toBe("c1");
  });

  it("list requires --app", async () => {
    await run(["list"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--app");
    expect(fakeClient.listAppCredentials).not.toHaveBeenCalled();
  });

  // ----- pause / resume --------------------------------------------------------

  it("pause calls pauseAppCredential and prints a receipt", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.pauseAppCredential.mockResolvedValue(undefined);

    await run(["pause", "--app", CUID, "--credential", "c1"]);

    expect(fakeClient.pauseAppCredential).toHaveBeenCalledWith(CUID, "c1");
    expect(JSON.parse(stdout)).toEqual({
      paused: true,
      app_id: CUID,
      credential_id: "c1",
    });
  });

  it("pause requires --credential", async () => {
    await run(["pause", "--app", CUID]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--credential");
    expect(fakeClient.pauseAppCredential).not.toHaveBeenCalled();
  });

  it("resume calls resumeAppCredential and prints a receipt", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.resumeAppCredential.mockResolvedValue(undefined);

    await run(["resume", "--app", CUID, "--credential", "c1"]);

    expect(fakeClient.resumeAppCredential).toHaveBeenCalledWith(CUID, "c1");
    expect(JSON.parse(stdout)).toEqual({
      resumed: true,
      app_id: CUID,
      credential_id: "c1",
    });
  });

  // ----- rotate ----------------------------------------------------------------

  it("rotate calls rotateAppCredential and prints the new token once", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.rotateAppCredential.mockResolvedValue({
      id: "c1",
      token: "hsc_newtoken",
      token_prefix: "hsc_newtoke",
      previous_expires_at: "2026-01-02T00:00:00.000Z",
    });

    await run(["rotate", "--app", CUID, "--credential", "c1"]);

    expect(fakeClient.rotateAppCredential).toHaveBeenCalledWith(CUID, "c1", {});
    expect(JSON.parse(stdout).token).toBe("hsc_newtoken");
  });

  it("rotate forwards --overlap", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.rotateAppCredential.mockResolvedValue({ id: "c1" });

    await run([
      "rotate",
      "--app",
      CUID,
      "--credential",
      "c1",
      "--overlap",
      "0",
    ]);

    expect(fakeClient.rotateAppCredential).toHaveBeenCalledWith(CUID, "c1", {
      overlapSeconds: 0,
    });
  });

  it("rotate requires --credential", async () => {
    await run(["rotate", "--app", CUID]);
    expect(exitCode).toBe(1);
    expect(fakeClient.rotateAppCredential).not.toHaveBeenCalled();
  });

  // ----- revoke ------------------------------------------------------------

  it("revoke calls revokeAppCredential and prints a receipt", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.revokeAppCredential.mockResolvedValue(undefined);

    await run(["revoke", "--app", CUID, "--credential", "c1"]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.revokeAppCredential).toHaveBeenCalledWith(CUID, "c1");
    expect(JSON.parse(stdout)).toEqual({
      revoked: true,
      app_id: CUID,
      credential_id: "c1",
    });
  });

  it("revoke requires --credential", async () => {
    await run(["revoke", "--app", CUID]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--credential");
    expect(fakeClient.revokeAppCredential).not.toHaveBeenCalled();
  });

  it("revoke surfaces a relay error via failFromError", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.revokeAppCredential.mockRejectedValue(
      new HomespunApiError(404, "app_not_found", "no such app"),
    );

    await run(["revoke", "--app", CUID, "--credential", "c1"]);

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
