// Tests for `homespun members` — drives real command dispatch
// (add/list/remove/roles) against a fake client stubbed via vi.mock on
// ../config.js, mirroring the "runApps dispatch" style in apps.test.ts.
// Covers: both add response shapes, list, remove, the roles summary, app-slug
// resolution (resolveAppId via listApps), the required-flag guards, and the
// 503 / owner-cannot-be-removed error paths (relay errors surfaced through
// failFromError).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HomespunApiError } from "@homespunapps/core";

// A recording fake of the HomespunClient bits runMembers uses. resolveAppId calls
// getApp (for cuid-shaped values) or listApps (for slugs); the member verbs
// call add/list/removeAppMember.
const fakeClient = {
  getApp: vi.fn(),
  listApps: vi.fn(),
  addAppMember: vi.fn(),
  listAppMembers: vi.fn(),
  removeAppMember: vi.fn(),
  listAppRoles: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import { runMembers } from "./members.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

const MEMBERS_TEST_BOOLS = new Set(["help"]);

function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, MEMBERS_TEST_BOOLS);
}

describe("runMembers dispatch", () => {
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
      await runMembers(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  // ----- add ---------------------------------------------------------------

  it("add attaches an existing human (member response shape)", async () => {
    // cuid-shaped --app resolves via getApp (fast path, no listApps).
    fakeClient.getApp.mockResolvedValue({ id: "appabcdefghijklmnopqrstu" });
    fakeClient.addAppMember.mockResolvedValue({
      member: {
        humanId: "hum_1",
        email: "a@b.test",
        role: "member",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    await run([
      "add",
      "--app",
      "appabcdefghijklmnopqrstu",
      "--email",
      "a@b.test",
    ]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.addAppMember).toHaveBeenCalledWith(
      "appabcdefghijklmnopqrstu",
      { email: "a@b.test" },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      member: { humanId: "hum_1", role: "member" },
    });
  });

  it("add prints the invited-magic-link shape and forwards --role", async () => {
    fakeClient.getApp.mockResolvedValue({ id: "appabcdefghijklmnopqrstu" });
    fakeClient.addAppMember.mockResolvedValue({
      ok: true,
      invited: "new@b.test",
      expires_at: "2026-01-08T00:00:00.000Z",
    });

    await run([
      "add",
      "--app",
      "appabcdefghijklmnopqrstu",
      "--email",
      "new@b.test",
      "--role",
      "member",
    ]);

    expect(fakeClient.addAppMember).toHaveBeenCalledWith(
      "appabcdefghijklmnopqrstu",
      { email: "new@b.test", role: "member" },
    );
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      invited: "new@b.test",
      expires_at: "2026-01-08T00:00:00.000Z",
    });
  });

  it("add resolves a slug via listApps before calling addAppMember", async () => {
    fakeClient.listApps.mockResolvedValue({ items: [{ id: "app_resolved" }] });
    fakeClient.addAppMember.mockResolvedValue({
      ok: true,
      invited: "new@b.test",
      expires_at: "2026-01-08T00:00:00.000Z",
    });

    await run(["add", "--app", "my-app", "--email", "new@b.test"]);

    expect(fakeClient.listApps).toHaveBeenCalledWith({
      status: "all",
      slug: "my-app",
      limit: 1,
    });
    expect(fakeClient.addAppMember).toHaveBeenCalledWith("app_resolved", {
      email: "new@b.test",
    });
  });

  it("add requires --app", async () => {
    await run(["add", "--email", "a@b.test"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--app");
    expect(fakeClient.addAppMember).not.toHaveBeenCalled();
  });

  it("add requires --email", async () => {
    await run(["add", "--app", "appabcdefghijklmnopqrstu"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--email");
    expect(fakeClient.addAppMember).not.toHaveBeenCalled();
  });

  it("add rejects a --role other than member", async () => {
    await run([
      "add",
      "--app",
      "appabcdefghijklmnopqrstu",
      "--email",
      "a@b.test",
      "--role",
      "owner",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("member");
    expect(fakeClient.addAppMember).not.toHaveBeenCalled();
  });

  it("add surfaces the relay 503 (EMAIL_PROVIDER=none) via failFromError", async () => {
    fakeClient.getApp.mockResolvedValue({ id: "appabcdefghijklmnopqrstu" });
    fakeClient.addAppMember.mockRejectedValue(
      new HomespunApiError(
        503,
        "auth_provider_unavailable",
        "human-side login is disabled on this relay",
      ),
    );

    await run([
      "add",
      "--app",
      "appabcdefghijklmnopqrstu",
      "--email",
      "new@b.test",
    ]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("auth_provider_unavailable");
  });

  // ----- list --------------------------------------------------------------

  it("list prints the members envelope", async () => {
    fakeClient.getApp.mockResolvedValue({ id: "appabcdefghijklmnopqrstu" });
    fakeClient.listAppMembers.mockResolvedValue({
      members: [{ humanId: "hum_1", email: "a@b.test", role: "owner" }],
    });

    await run(["list", "--app", "appabcdefghijklmnopqrstu"]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.listAppMembers).toHaveBeenCalledWith(
      "appabcdefghijklmnopqrstu",
    );
    expect(JSON.parse(stdout).members[0].role).toBe("owner");
  });

  it("list requires --app", async () => {
    await run(["list"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--app");
    expect(fakeClient.listAppMembers).not.toHaveBeenCalled();
  });

  // ----- remove ------------------------------------------------------------

  it("remove calls removeAppMember and prints a receipt", async () => {
    fakeClient.getApp.mockResolvedValue({ id: "appabcdefghijklmnopqrstu" });
    fakeClient.removeAppMember.mockResolvedValue(undefined);

    await run([
      "remove",
      "--app",
      "appabcdefghijklmnopqrstu",
      "--human",
      "hum_2",
    ]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.removeAppMember).toHaveBeenCalledWith(
      "appabcdefghijklmnopqrstu",
      "hum_2",
    );
    expect(JSON.parse(stdout)).toEqual({
      removed: true,
      app_id: "appabcdefghijklmnopqrstu",
      human_id: "hum_2",
    });
  });

  it("remove requires --human", async () => {
    await run(["remove", "--app", "appabcdefghijklmnopqrstu"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--human");
    expect(fakeClient.removeAppMember).not.toHaveBeenCalled();
  });

  it("remove surfaces the owner-cannot-be-removed 409 via failFromError", async () => {
    fakeClient.getApp.mockResolvedValue({ id: "appabcdefghijklmnopqrstu" });
    fakeClient.removeAppMember.mockRejectedValue(
      new HomespunApiError(409, "conflict", "cannot remove the app owner"),
    );

    await run([
      "remove",
      "--app",
      "appabcdefghijklmnopqrstu",
      "--human",
      "hum_owner",
    ]);

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.message).toContain("owner");
  });

  // ----- roles -------------------------------------------------------------

  it("roles prints the roles-summary envelope", async () => {
    fakeClient.getApp.mockResolvedValue({ id: "appabcdefghijklmnopqrstu" });
    fakeClient.listAppRoles.mockResolvedValue({
      roles: [
        {
          name: "reviewer",
          label: "Reviewer",
          description: null,
          collections: [
            {
              name: "submissions",
              member_access: {
                read: "all",
                create: "all",
                update: "none",
                delete: "own",
              },
              grant_access: {
                read: "own",
                create: "all",
                update: "none",
                delete: "own",
              },
              append_only: false,
            },
          ],
          member_count: 3,
          active_grant_count: 7,
        },
      ],
    });

    await run(["roles", "--app", "appabcdefghijklmnopqrstu"]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.listAppRoles).toHaveBeenCalledWith(
      "appabcdefghijklmnopqrstu",
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.roles[0].member_count).toBe(3);
    expect(parsed.roles[0].collections[0].member_access.read).toBe("all");
    expect(parsed.roles[0].collections[0].grant_access.read).toBe("own");
  });

  it("roles resolves a slug via listApps first", async () => {
    fakeClient.listApps.mockResolvedValue({ items: [{ id: "app_resolved" }] });
    fakeClient.listAppRoles.mockResolvedValue({ roles: [] });

    await run(["roles", "--app", "my-app"]);

    expect(fakeClient.listApps).toHaveBeenCalledWith({
      status: "all",
      slug: "my-app",
      limit: 1,
    });
    expect(fakeClient.listAppRoles).toHaveBeenCalledWith("app_resolved");
    expect(JSON.parse(stdout)).toEqual({ roles: [] });
  });

  it("roles requires --app", async () => {
    await run(["roles"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--app");
    expect(fakeClient.listAppRoles).not.toHaveBeenCalled();
  });

  // ----- verb guards -------------------------------------------------------

  it("rejects an unknown verb", async () => {
    await run(["frobnicate", "--app", "appabcdefghijklmnopqrstu"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown verb");
  });

  it("fails with a missing-verb message when no verb is given", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing verb");
  });
});
