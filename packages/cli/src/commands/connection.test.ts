// Tests for `homespun connections` (#1363): drives real command dispatch
// (create/list/delete/authorize-url) against a fake client stubbed via
// vi.mock on ../config.js, mirroring grant.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HomespunApiError } from "@homespunapps/core";

const fakeClient = {
  getApp: vi.fn(),
  listApps: vi.fn(),
  createConnection: vi.fn(),
  listConnections: vi.fn(),
  deleteConnection: vi.fn(),
  connectionAuthorizeUrl: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import { runConnection } from "./connection.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

const CONNECTION_TEST_BOOLS = new Set(["help"]);

function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, CONNECTION_TEST_BOOLS);
}

const CUID = "appabcdefghijklmnopqrstu";

describe("runConnection dispatch", () => {
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
      await runConnection(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  // ----- create (static) -----------------------------------------------------

  it("create (static, default kind) forwards fields and defaults header-name", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.createConnection.mockResolvedValue({
      connection: { id: "conn_1", name: "hubspot", kind: "static" },
    });

    await run([
      "create",
      "--app",
      CUID,
      "--name",
      "hubspot",
      "--allowed-host",
      "api.hubapi.com",
      "--header-value",
      "Bearer sk_live_x",
    ]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.createConnection).toHaveBeenCalledWith(CUID, {
      name: "hubspot",
      kind: "static",
      allowedHost: "api.hubapi.com",
      headerValue: "Bearer sk_live_x",
      headerName: "Authorization",
    });
    expect(JSON.parse(stdout).connection.id).toBe("conn_1");
  });

  it("create (static) requires --header-value", async () => {
    await run([
      "create",
      "--app",
      CUID,
      "--name",
      "hubspot",
      "--allowed-host",
      "api.hubapi.com",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--header-value");
    expect(fakeClient.createConnection).not.toHaveBeenCalled();
  });

  it("create requires --app, --name and --allowed-host", async () => {
    await run(["create", "--name", "x"]);
    expect(exitCode).toBe(1);
    expect(fakeClient.createConnection).not.toHaveBeenCalled();
  });

  // ----- create (oauth2) ------------------------------------------------------

  it("create (oauth2) requires the four oauth2 fields", async () => {
    await run([
      "create",
      "--app",
      CUID,
      "--name",
      "crm",
      "--kind",
      "oauth2",
      "--allowed-host",
      "api.example.com",
    ]);
    expect(exitCode).toBe(1);
    expect(fakeClient.createConnection).not.toHaveBeenCalled();
  });

  it("create (oauth2) forwards the provider config", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.createConnection.mockResolvedValue({
      connection: { id: "conn_2", name: "crm", kind: "oauth2" },
    });

    await run([
      "create",
      "--app",
      CUID,
      "--name",
      "crm",
      "--kind",
      "oauth2",
      "--allowed-host",
      "api.example.com",
      "--authorize-url",
      "https://accounts.example.com/oauth/authorize",
      "--token-url",
      "https://accounts.example.com/oauth/token",
      "--client-id",
      "abc123",
      "--client-secret",
      "s3cr3t",
      "--scopes",
      "read write",
      "--auth-params",
      '{"access_type":"offline"}',
    ]);

    expect(fakeClient.createConnection).toHaveBeenCalledWith(CUID, {
      name: "crm",
      kind: "oauth2",
      allowedHost: "api.example.com",
      authorizeUrl: "https://accounts.example.com/oauth/authorize",
      tokenEndpoint: "https://accounts.example.com/oauth/token",
      clientId: "abc123",
      clientSecret: "s3cr3t",
      scopes: "read write",
      authParams: { access_type: "offline" },
    });
  });

  it("create (oauth2) rejects malformed --auth-params JSON", async () => {
    await run([
      "create",
      "--app",
      CUID,
      "--name",
      "crm",
      "--kind",
      "oauth2",
      "--allowed-host",
      "api.example.com",
      "--authorize-url",
      "https://a.example.com/authorize",
      "--token-url",
      "https://a.example.com/token",
      "--client-id",
      "abc",
      "--client-secret",
      "s3cr3t",
      "--auth-params",
      "not json",
    ]);
    expect(exitCode).toBe(1);
    expect(fakeClient.createConnection).not.toHaveBeenCalled();
  });

  // ----- list ----------------------------------------------------------------

  it("list resolves a slug then prints the connections envelope", async () => {
    fakeClient.listApps.mockResolvedValue({ items: [{ id: "app_resolved" }] });
    fakeClient.listConnections.mockResolvedValue({
      connections: [{ id: "conn_1", name: "hubspot" }],
    });

    await run(["list", "--app", "my-app"]);

    expect(fakeClient.listApps).toHaveBeenCalledWith({
      status: "all",
      slug: "my-app",
      limit: 1,
    });
    expect(fakeClient.listConnections).toHaveBeenCalledWith("app_resolved");
    expect(JSON.parse(stdout).connections[0].id).toBe("conn_1");
  });

  it("list requires --app", async () => {
    await run(["list"]);
    expect(exitCode).toBe(1);
    expect(fakeClient.listConnections).not.toHaveBeenCalled();
  });

  // ----- delete ------------------------------------------------------------

  it("delete calls deleteConnection and prints a receipt", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.deleteConnection.mockResolvedValue(undefined);

    await run(["delete", "--app", CUID, "--name", "hubspot"]);

    expect(fakeClient.deleteConnection).toHaveBeenCalledWith(CUID, "hubspot");
    expect(JSON.parse(stdout)).toEqual({
      deleted: true,
      app_id: CUID,
      name: "hubspot",
    });
  });

  it("delete requires --name", async () => {
    await run(["delete", "--app", CUID]);
    expect(exitCode).toBe(1);
    expect(fakeClient.deleteConnection).not.toHaveBeenCalled();
  });

  it("delete surfaces a relay error via failFromError", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.deleteConnection.mockRejectedValue(
      new HomespunApiError(404, "app_not_found", "no such app"),
    );

    await run(["delete", "--app", CUID, "--name", "hubspot"]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("app_not_found");
  });

  // ----- authorize-url ---------------------------------------------------------

  it("authorize-url builds the URL without any network call to it", async () => {
    fakeClient.getApp.mockResolvedValue({ id: CUID });
    fakeClient.connectionAuthorizeUrl.mockReturnValue(
      `https://relay.test/v1/apps/${CUID}/connections/crm/authorize`,
    );

    await run(["authorize-url", "--app", CUID, "--name", "crm"]);

    expect(fakeClient.connectionAuthorizeUrl).toHaveBeenCalledWith(CUID, "crm");
    expect(JSON.parse(stdout).authorize_url).toBe(
      `https://relay.test/v1/apps/${CUID}/connections/crm/authorize`,
    );
  });

  it("authorize-url requires --name", async () => {
    await run(["authorize-url", "--app", CUID]);
    expect(exitCode).toBe(1);
    expect(fakeClient.connectionAuthorizeUrl).not.toHaveBeenCalled();
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
