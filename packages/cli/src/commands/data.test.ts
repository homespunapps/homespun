// Tests for `homespun data` — collection row CRUD round-trips + <app> id/slug
// resolution (spec-cli §3.3).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  // resolveAppId verifies a cuid-shaped <app> via GET /v1/apps/:id before
  // trusting it (resolve-app.ts) — a hyphen-free 21+-char OWNER-CHOSEN slug
  // can match the same shape, so the id-path lookup is tried first and
  // only falls back to the slug lookup (listApps below) on a 404.
  getApp: vi.fn((appId: unknown) => {
    calls.push({ method: "getApp", args: [appId] });
    return Promise.resolve({ id: appId });
  }),
  listApps: vi.fn((opts: { slug?: string }) => {
    calls.push({ method: "listApps", args: [opts] });
    return Promise.resolve({
      items: opts.slug === "my-app" ? [{ id: "app_resolved" }] : [],
      next_cursor: null,
    });
  }),
  listAppRows: vi.fn((appId: unknown, collection: unknown, opts: unknown) => {
    calls.push({ method: "listAppRows", args: [appId, collection, opts] });
    return Promise.resolve({ rows: [], next_cursor: null, has_more: false });
  }),
  getAppRow: vi.fn((appId: unknown, collection: unknown, key: unknown) => {
    calls.push({ method: "getAppRow", args: [appId, collection, key] });
    return Promise.resolve({
      row: {
        key,
        data: { name: "Milk" },
        version: 1,
        author: { kind: "agent", id: "agt_1" },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null,
      },
    });
  }),
  upsertAppRow: vi.fn((appId: unknown, collection: unknown, body: unknown) => {
    calls.push({ method: "upsertAppRow", args: [appId, collection, body] });
    return Promise.resolve({
      row: {
        key: (body as { key?: string }).key ?? "row_generated",
        data: (body as { data: unknown }).data,
        version: 1,
        author: { kind: "agent", id: "agt_1" },
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
        deleted_at: null,
      },
    });
  }),
  updateAppRow: vi.fn(
    (appId: unknown, collection: unknown, key: unknown, body: unknown) => {
      calls.push({
        method: "updateAppRow",
        args: [appId, collection, key, body],
      });
      return Promise.resolve({
        row: {
          key,
          data: (body as { data: unknown }).data,
          version: 2,
          author: { kind: "agent", id: "agt_1" },
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
        },
      });
    },
  ),
  deleteAppRow: vi.fn(
    (appId: unknown, collection: unknown, key: unknown, opts: unknown) => {
      calls.push({
        method: "deleteAppRow",
        args: [appId, collection, key, opts],
      });
      return Promise.resolve();
    },
  ),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runData } from "./data.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "help", "yes"]);
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let stdout: string;
let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  calls.length = 0;
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

// A cuid-shaped id is verified via GET /v1/apps/:id (getApp) first — the
// fast path when it's a real id — then used as-is; anything else (or an id
// that turns out to be a legit hyphen-free slug and 404s) resolves via
// listApps({ slug }).
const CUID_APP = "clh1a2b3c4d5e6f7g8h9i0j1";

describe("<app> resolution", () => {
  it("uses a cuid-shaped app id as-is once GET /v1/apps/:id confirms it", async () => {
    await runData(argv([CUID_APP, "items", "list"]));
    expect(calls.map((c) => c.method)).toEqual(["getApp", "listAppRows"]);
    expect(calls[0]!.args[0]).toBe(CUID_APP);
    expect(calls[1]!.args[0]).toBe(CUID_APP);
  });

  it("resolves a slug via GET /v1/apps?slug=", async () => {
    await runData(argv(["my-app", "items", "list"]));
    expect(calls.map((c) => c.method)).toEqual(["listApps", "listAppRows"]);
    expect(calls[1]!.args[0]).toBe("app_resolved");
  });

  it("fails with app_not_found when no app matches the slug", async () => {
    await expect(
      runData(argv(["no-such-slug", "items", "list"])),
    ).rejects.toThrow("__exit_1__");
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("app_not_found");
  });
});

describe("upsert/update/delete round-trips", () => {
  it("upsert without --key lets the server generate one", async () => {
    await runData(
      argv([CUID_APP, "items", "upsert", "--data", '{"name":"Milk"}']),
    );
    // calls[0] is the resolveAppId id-path verification (getApp); the
    // actual upsert is calls[1].
    expect(calls[1]).toEqual({
      method: "upsertAppRow",
      args: [CUID_APP, "items", { data: { name: "Milk" } }],
    });
    expect(JSON.parse(stdout).row.key).toBe("row_generated");
  });

  it("upsert with --key passes it through", async () => {
    await runData(
      argv([
        CUID_APP,
        "items",
        "upsert",
        "--data",
        '{"name":"Milk"}',
        "--key",
        "milk",
      ]),
    );
    expect(calls[1]!.args[2]).toEqual({ key: "milk", data: { name: "Milk" } });
    expect(JSON.parse(stdout).row.key).toBe("milk");
  });

  it("update round-trips --data and --if-match", async () => {
    await runData(
      argv([
        CUID_APP,
        "items",
        "update",
        "milk",
        "--data",
        '{"name":"Whole Milk"}',
        "--if-match",
        "1",
      ]),
    );
    expect(calls[1]).toEqual({
      method: "updateAppRow",
      args: [
        CUID_APP,
        "items",
        "milk",
        { data: { name: "Whole Milk" }, if_match: 1 },
      ],
    });
    expect(JSON.parse(stdout).row.version).toBe(2);
  });

  it("delete round-trips --if-match and reports {deleted:true, key}", async () => {
    await runData(
      argv([CUID_APP, "items", "delete", "milk", "--if-match", "2"]),
    );
    expect(calls[1]).toEqual({
      method: "deleteAppRow",
      args: [CUID_APP, "items", "milk", { ifMatch: 2 }],
    });
    expect(JSON.parse(stdout)).toEqual({ deleted: true, key: "milk" });
  });

  it("get uses the dedicated per-row route (no client-side scan)", async () => {
    await runData(argv([CUID_APP, "items", "get", "milk"]));
    expect(calls).toEqual([
      { method: "getApp", args: [CUID_APP] },
      { method: "getAppRow", args: [CUID_APP, "items", "milk"] },
    ]);
    expect(JSON.parse(stdout).row.key).toBe("milk");
  });
});
