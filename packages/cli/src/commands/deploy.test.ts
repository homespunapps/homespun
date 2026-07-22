// Tests for `homespun deploy` — packaging (dir vs single-file), create-vs-
// redeploy dispatch by --app presence, and the client-side slug/visibility
// mutual-exclusion checks (spec-cli §3.1).
//
// --app on redeploy goes through the same resolveAppId helper as
// `apps show` / `data ... list` (resolve-app.ts): a cuid-shaped value is
// verified via GET /v1/apps/:id, anything else resolves via
// GET /v1/apps?slug=. CUID_APP below is cuid-shaped so it's used as-is.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CUID_APP = "clh1a2b3c4d5e6f7g8h9i0j1";

const calls: { method: string; args: unknown[] }[] = [];
const fakeClient = {
  deployApp: vi.fn((body: unknown) => {
    calls.push({ method: "deployApp", args: [body] });
    return Promise.resolve({
      app_id: CUID_APP,
      slug: "grocery-x7k2m9",
      visibility: "private",
      url: "https://grocery-x7k2m9.homespunapps.com/",
      version: 1,
      created: true,
    });
  }),
  redeployApp: vi.fn((id: unknown, body: unknown) => {
    calls.push({ method: "redeployApp", args: [id, body] });
    return Promise.resolve({ app_id: id, version: 2, compat: "clean" });
  }),
  getApp: vi.fn((id: unknown) => {
    calls.push({ method: "getApp", args: [id] });
    return Promise.resolve({
      id,
      slug: "grocery-x7k2m9",
      visibility: "private",
      status: "active",
      url: "https://grocery-x7k2m9.homespunapps.com/",
      created_at: "2026-01-01T00:00:00.000Z",
      last_activity_at: "2026-01-01T00:00:00.000Z",
      manifest: {},
      current_version: 2,
      owner_human_id: "hum_1",
      row_count: 0,
      storage_bytes: "0",
    });
  }),
  // Backs the resolveAppId slug-lookup path (resolve-app.ts): resolves
  // "my-slug" to CUID_APP, anything else comes back empty.
  listApps: vi.fn((opts: { slug?: string }) => {
    calls.push({ method: "listApps", args: [opts] });
    return Promise.resolve({
      items: opts.slug === "my-slug" ? [{ id: CUID_APP }] : [],
      next_cursor: null,
    });
  }),
  checkDeploy: vi.fn((body: unknown) => {
    calls.push({ method: "checkDeploy", args: [body] });
    return Promise.resolve({ ok: true, warnings: [] });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runDeploy } from "./deploy.js";
import { parseArgs, BOOLEAN_FLAGS } from "../argv.js";

// Parse with the REAL production boolean-flag set. A test-local copy is what
// masked #827: it listed "check" while the real set did not, so every --check
// test here passed while the shipped CLI ran a real deploy.
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLEAN_FLAGS);
}

let stdout: string;
let stderr: string;
let exitCode: number | undefined;
let dir: string;

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

  dir = mkdtempSync(join(tmpdir(), "homespun-deploy-test-"));
  writeFileSync(join(dir, "index.html"), "<html>hi</html>");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ "x-homespun-manifest": { app: { name: "Test" } } }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function expectExit(code: number): void {
  expect(exitCode).toBe(code);
}

describe("directory packaging", () => {
  it("reads index.html + manifest.json and creates (no --app)", async () => {
    await runDeploy(argv([dir]));
    expect(calls).toEqual([
      {
        method: "deployApp",
        args: [
          {
            html: "<html>hi</html>",
            manifest: { "x-homespun-manifest": { app: { name: "Test" } } },
            visibility: undefined,
            slug: undefined,
          },
        ],
      },
    ]);
    expect(JSON.parse(stdout)).toMatchObject({
      app_id: CUID_APP,
      created: true,
    });
  });

  it("fails fast naming the missing file when manifest.json is absent", async () => {
    rmSync(join(dir, "manifest.json"));
    await expect(runDeploy(argv([dir]))).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(JSON.parse(stderr).error.message).toContain("manifest.json");
    expect(calls).toEqual([]);
  });

  it("rejects --manifest alongside a directory (that's the single-file escape hatch)", async () => {
    await expect(runDeploy(argv([dir, "--manifest", "{}"]))).rejects.toThrow(
      "__exit_1__",
    );
    expectExit(1);
  });
});

describe("single-file packaging (escape hatch)", () => {
  it("requires --manifest", async () => {
    await expect(runDeploy(argv([join(dir, "index.html")]))).rejects.toThrow(
      "__exit_1__",
    );
    expectExit(1);
    expect(JSON.parse(stderr).error.message).toContain("--manifest");
  });

  it("accepts an inline JSON --manifest", async () => {
    await runDeploy(
      argv([
        join(dir, "index.html"),
        "--manifest",
        '{"x-homespun-manifest":{"app":{"name":"Test"}}}',
      ]),
    );
    expect(calls[0]!.method).toBe("deployApp");
  });
});

describe("create vs redeploy — decided by --app's presence", () => {
  it("no --app: create", async () => {
    await runDeploy(argv([dir]));
    expect(calls.map((c) => c.method)).toEqual(["deployApp"]);
  });

  it("--app <id>: redeploy, then enriches output via getApp", async () => {
    await runDeploy(argv([dir, "--app", CUID_APP]));
    // calls[0] is the resolveAppId id-path verification (getApp).
    expect(calls.map((c) => c.method)).toEqual([
      "getApp",
      "redeployApp",
      "getApp",
    ]);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({
      app_id: CUID_APP,
      version: 2,
      compat: "clean",
      created: false,
      slug: "grocery-x7k2m9",
    });
  });

  it("--app <slug>: resolves the slug to an id before redeploying (bug: previously passed the raw slug straight through)", async () => {
    await runDeploy(argv([dir, "--app", "my-slug"]));
    expect(calls.map((c) => c.method)).toEqual([
      "listApps",
      "redeployApp",
      "getApp",
    ]);
    expect(calls[0]).toEqual({
      method: "listApps",
      args: [{ status: "all", slug: "my-slug", limit: 1 }],
    });
    expect(calls[1]!.args[0]).toBe(CUID_APP);
    expect(calls[2]!.args[0]).toBe(CUID_APP);
    const out = JSON.parse(stdout);
    expect(out).toMatchObject({
      app_id: CUID_APP,
      version: 2,
      created: false,
    });
  });

  it("--app <unresolvable slug>: fails with app_not_found rather than redeploying", async () => {
    await expect(
      runDeploy(argv([dir, "--app", "no-such-slug"])),
    ).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(JSON.parse(stderr).error.code).toBe("app_not_found");
    expect(calls.map((c) => c.method)).toEqual(["listApps"]);
  });
});

describe("client-side slug/visibility mutual-exclusion (spec-cli §3.1)", () => {
  it("allows --slug with the default (no --visibility, resolves to private)", async () => {
    await runDeploy(argv([dir, "--slug", "my-slug"]));
    expect(calls).toEqual([
      {
        method: "deployApp",
        args: [
          {
            html: "<html>hi</html>",
            manifest: { "x-homespun-manifest": { app: { name: "Test" } } },
            visibility: undefined,
            slug: "my-slug",
          },
        ],
      },
    ]);
  });

  it("rejects --slug with --visibility link", async () => {
    await expect(
      runDeploy(argv([dir, "--slug", "my-slug", "--visibility", "link"])),
    ).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(calls).toEqual([]);
  });

  it("allows --slug with --visibility public", async () => {
    await runDeploy(argv([dir, "--slug", "my-slug", "--visibility", "public"]));
    expect(calls[0]!.method).toBe("deployApp");
  });

  it("rejects --slug on redeploy (slug is immutable)", async () => {
    await expect(
      runDeploy(argv([dir, "--app", "app_1", "--slug", "my-slug"])),
    ).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(calls).toEqual([]);
  });

  it("rejects --visibility on redeploy", async () => {
    await expect(
      runDeploy(argv([dir, "--app", "app_1", "--visibility", "public"])),
    ).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(calls).toEqual([]);
  });
});

describe("--check (dry run)", () => {
  it("a create --check calls checkDeploy (no app id) and deploys nothing", async () => {
    await runDeploy(argv([dir, "--check"]));
    // Only checkDeploy is called — never deployApp.
    expect(calls).toEqual([
      {
        method: "checkDeploy",
        args: [
          {
            html: "<html>hi</html>",
            manifest: { "x-homespun-manifest": { app: { name: "Test" } } },
          },
        ],
      },
    ]);
    expect(JSON.parse(stdout)).toEqual({ ok: true, warnings: [] });
  });

  it("a redeploy --check resolves the app id, forwards --force, and redeploys nothing", async () => {
    await runDeploy(argv([dir, "--app", CUID_APP, "--check", "--force"]));
    // resolveAppId verifies the cuid-shaped id via getApp, then checkDeploy
    // runs — never redeployApp.
    expect(calls.map((c) => c.method)).toEqual(["getApp", "checkDeploy"]);
    const checkCall = calls.find((c) => c.method === "checkDeploy")!;
    expect(checkCall.args).toEqual([
      {
        app_id: CUID_APP,
        html: "<html>hi</html>",
        manifest: { "x-homespun-manifest": { app: { name: "Test" } } },
        force: true,
      },
    ]);
    expect(calls.some((c) => c.method === "redeployApp")).toBe(false);
  });
});
