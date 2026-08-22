// Tests for `homespun deploy` — packaging (dir vs single-file), create-vs-
// redeploy dispatch by --app presence, and the client-side slug/visibility
// mutual-exclusion checks (spec-cli §3.1).
//
// --app on redeploy goes through the same resolveAppId helper as
// `apps show` / `data ... list` (resolve-app.ts): a cuid-shaped value is
// verified via GET /v1/apps/:id, anything else resolves via
// GET /v1/apps?slug=. CUID_APP below is cuid-shaped so it's used as-is.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
  // Backs the by-reference asset path (issue #1028): presignBlob -> PUT
  // (mocked separately below, via @homespunapps/core's putPresigned) ->
  // confirmBlob. Defaults to a working presign; individual tests override
  // with mockRejectedValueOnce / mockImplementationOnce for the
  // not_implemented-fallback and real-failure cases.
  presignBlob: vi.fn((opts: unknown) => {
    calls.push({ method: "presignBlob", args: [opts] });
    return Promise.resolve({
      attachment_id: "att_presigned_1",
      upload_url: "https://storage.test/blob/att_presigned_1?sig=abc",
      expires_at: "2026-01-01T00:10:00.000Z",
    });
  }),
  confirmBlob: vi.fn((attachmentId: unknown) => {
    calls.push({ method: "confirmBlob", args: [attachmentId] });
    return Promise.resolve({
      attachment_id: attachmentId,
      scope: "app",
      mime: "application/octet-stream",
      size: 0,
      sha256: "0".repeat(64),
      status: "ready",
    });
  }),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

// putPresigned is the raw fetch-to-storage PUT (packages/core/src/client.ts).
// Mocked at the module boundary rather than by stubbing global fetch: deploy.ts
// imports it by name, so this intercepts exactly the call it makes without
// touching unrelated fetch usage elsewhere. HomespunApiError is re-exported
// from the REAL module so `e instanceof HomespunApiError` inside deploy.ts
// matches instances the tests construct below (the not_implemented case).
//
// vi.hoisted (not a plain const): the vi.mock factory below reads
// putPresignedMock at MODULE-LOAD time (import hoisting runs "./deploy.js"'s
// import graph, which pulls in this mock, before this file's own plain
// `const` statements execute), so a plain `const` here is still in its
// temporal dead zone when the factory first runs. vi.hoisted runs its
// initializer before that import graph loads.
const putPresignedMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@homespunapps/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@homespunapps/core")>();
  return { ...actual, putPresigned: putPresignedMock };
});

import { runDeploy } from "./deploy.js";
import { parseArgs, BOOLEAN_FLAGS, REPEATABLE_FLAGS } from "../argv.js";
import { HomespunApiError } from "@homespunapps/core";

// Parse with the REAL production flag sets (boolean AND repeatable). A
// test-local copy is what masked #827: it listed "check" while the real set
// did not, so every --check test here passed while the shipped CLI ran a
// real deploy. Omitting REPEATABLE_FLAGS here would make a second --asset
// throw "duplicate flag" before runDeploy ever saw it.
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLEAN_FLAGS, REPEATABLE_FLAGS);
}

let stdout: string;
let stderr: string;
let exitCode: number | undefined;
let dir: string;

beforeEach(() => {
  calls.length = 0;
  putPresignedMock.mockClear();
  putPresignedMock.mockResolvedValue(undefined);
  fakeClient.presignBlob.mockClear();
  fakeClient.confirmBlob.mockClear();
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

// On a redeploy an omitted field keeps what is live (#1272), so the CLI must
// let a caller ship one half. A create can inherit nothing and still needs both.
describe("partial redeploys (inherit on omit)", () => {
  it("a single file with --app and no --manifest ships the document alone", async () => {
    await runDeploy(argv([join(dir, "index.html"), "--app", CUID_APP]));
    const redeploy = calls.find((c) => c.method === "redeployApp")!;
    expect(redeploy.args[1]).toEqual({
      html: "<html>hi</html>",
      force: false,
    });
  });

  it("--manifest with no file argument ships the manifest alone", async () => {
    await runDeploy(
      argv(["--app", CUID_APP, "--manifest", join(dir, "manifest.json")]),
    );
    const redeploy = calls.find((c) => c.method === "redeployApp")!;
    expect(redeploy.args[1]).toEqual({
      manifest: { "x-homespun-manifest": { app: { name: "Test" } } },
      force: false,
    });
  });

  it("--check on a partial redeploy sends only the half that was read", async () => {
    await runDeploy(
      argv([
        "--app",
        CUID_APP,
        "--manifest",
        join(dir, "manifest.json"),
        "--check",
      ]),
    );
    const check = calls.find((c) => c.method === "checkDeploy")!;
    expect(check.args).toEqual([
      {
        app_id: CUID_APP,
        manifest: { "x-homespun-manifest": { app: { name: "Test" } } },
      },
    ]);
  });

  it("--app with neither a file nor --manifest has nothing to deploy", async () => {
    await expect(runDeploy(argv(["--app", CUID_APP]))).rejects.toThrow(
      "__exit_1__",
    );
    expectExit(1);
    expect(JSON.parse(stderr).error.message).toContain("nothing to deploy");
    expect(calls).toEqual([]);
  });

  it("a create still needs a source, since it can inherit nothing", async () => {
    await expect(runDeploy(argv([]))).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(JSON.parse(stderr).error.message).toContain("usage:");
    expect(calls).toEqual([]);
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

// Issue #1225: the relay has always accepted a multi-file `assets[]` bundle,
// and the CLI silently dropped every file that was not index.html or
// manifest.json. The failure was in the SUCCESS direction (deploy reports a
// version, app 404s on the asset), so these tests pin both that assets now
// ship and that the things which must NOT ship still do not.
describe("asset bundle", () => {
  /** Write `<dir>/assets/<rel>`, creating intermediate directories. */
  function writeAsset(rel: string, contents: Buffer | string): void {
    const full = join(dir, "assets", rel);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, contents);
  }

  /** The `assets` array the CLI passed to deployApp, or undefined. */
  function deployedAssets(): unknown {
    const call = calls.find((c) => c.method === "deployApp")!;
    return (call.args[0] as { assets?: unknown }).assets;
  }

  it("ships files under assets/ as base64, keeping the assets/ prefix", async () => {
    writeAsset("logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await runDeploy(argv([dir]));
    expect(deployedAssets()).toEqual([
      { path: "assets/logo.png", content_base64: "iVBORw==" },
    ]);
  });

  it("preserves nested paths and sorts for a deterministic bundle", async () => {
    writeAsset("fonts/inter.woff2", "b");
    writeAsset("img/a.png", "a");
    await runDeploy(argv([dir]));
    expect((deployedAssets() as { path: string }[]).map((a) => a.path)).toEqual(
      ["assets/fonts/inter.woff2", "assets/img/a.png"],
    );
  });

  it("omits assets entirely when there is no assets/ directory", async () => {
    await runDeploy(argv([dir]));
    expect(deployedAssets()).toBeUndefined();
  });

  it("sends an empty array for an empty assets/ directory (the relay's explicit clear)", async () => {
    mkdirSync(join(dir, "assets"));
    await runDeploy(argv([dir]));
    expect(deployedAssets()).toEqual([]);
  });

  it("skips dotfiles rather than letting them consume the asset budget", async () => {
    writeAsset(".DS_Store", "junk");
    writeAsset("keep.png", "x");
    await runDeploy(argv([dir]));
    expect((deployedAssets() as { path: string }[]).map((a) => a.path)).toEqual(
      ["assets/keep.png"],
    );
  });

  it("declares a mime for types the relay cannot sniff, and omits it for types it can", async () => {
    writeAsset("data.json", "{}");
    writeAsset("pic.png", "x");
    await runDeploy(argv([dir]));
    expect(deployedAssets()).toEqual([
      {
        path: "assets/data.json",
        content_base64: "e30=",
        mime: "application/json",
      },
      { path: "assets/pic.png", content_base64: "eA==" },
    ]);
  });

  it("refuses a .js asset by name, explaining it would serve as an inert download", async () => {
    writeAsset("app.js", "console.log(1)");
    await expect(runDeploy(argv([dir]))).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(stderr).toContain("assets/app.js");
    expect(stderr).toContain("nosniff");
    expect(calls).toEqual([]);
  });

  it("refuses a .css asset the same way", async () => {
    writeAsset("style.css", "body{}");
    await expect(runDeploy(argv([dir]))).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(stderr).toContain("assets/style.css");
    expect(calls).toEqual([]);
  });

  it("refuses a file over the per-asset byte cap, naming it", async () => {
    writeAsset("big.png", Buffer.alloc(5_000_001));
    await expect(runDeploy(argv([dir]))).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(stderr).toContain("assets/big.png");
    expect(calls).toEqual([]);
  });

  it("refuses more than 50 assets before base64-ing them", async () => {
    for (let i = 0; i < 51; i++) writeAsset(`f${i}.png`, "x");
    await expect(runDeploy(argv([dir]))).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(stderr).toContain("too many assets");
    expect(calls).toEqual([]);
  });

  it("warns on stdout-safe stderr about files it is not shipping", async () => {
    writeFileSync(join(dir, "notes.txt"), "hi");
    mkdirSync(join(dir, "node_modules"));
    await runDeploy(argv([dir]));
    expect(stderr).toContain("not deploying");
    expect(stderr).toContain("node_modules/");
    expect(stderr).toContain("notes.txt");
    // The warning must never reach stdout, which stays parseable JSON.
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("does not warn when the directory holds only the three deployable things", async () => {
    writeAsset("logo.png", "x");
    await runDeploy(argv([dir]));
    expect(stderr).toBe("");
  });

  it("forwards the bundle on a redeploy", async () => {
    writeAsset("logo.png", "x");
    await runDeploy(argv([dir, "--app", CUID_APP]));
    const call = calls.find((c) => c.method === "redeployApp")!;
    expect((call.args[1] as { assets?: unknown }).assets).toEqual([
      { path: "assets/logo.png", content_base64: "eA==" },
    ]);
  });

  it("omits assets on a redeploy from a directory with no assets/, leaving the live set alone", async () => {
    await runDeploy(argv([dir, "--app", CUID_APP]));
    const call = calls.find((c) => c.method === "redeployApp")!;
    expect((call.args[1] as { assets?: unknown }).assets).toBeUndefined();
  });

  it("forwards the bundle on --check so a dry run validates what a real deploy would send", async () => {
    writeAsset("logo.png", "x");
    await runDeploy(argv([dir, "--check"]));
    const call = calls.find((c) => c.method === "checkDeploy")!;
    expect((call.args[0] as { assets?: unknown }).assets).toEqual([
      { path: "assets/logo.png", content_base64: "eA==" },
    ]);
  });
});

// Issue #1028: the explicit --asset <local>=<app-path> flag, for a file that
// does not live under assets/, or that is too big to inline. Small files
// (< 1 MB) inline exactly like a directory-convention asset; large ones
// (>= 1 MB) go by reference: presignBlob -> a raw PUT to storage (mocked via
// @homespunapps/core's putPresigned, see the top-of-file vi.mock) ->
// confirmBlob. A brand-new app cannot presign on its first deploy call (the
// app id does not exist yet, and scope is fixed at presign time with no
// rescope endpoint), so a create carrying a large asset is two round trips;
// an existing app (--app given) is one.
describe("--asset flag (issue #1028)", () => {
  /** Write a file anywhere under the deploy dir, NOT necessarily under assets/. */
  function writeLocal(rel: string, contents: Buffer | string): string {
    const full = join(dir, rel);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, contents);
    return full;
  }

  function writeAsset(rel: string, contents: Buffer | string): void {
    const full = join(dir, "assets", rel);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, contents);
  }

  /** The `assets` array sent on the FIRST call to `method`, or undefined. */
  function assetsSentBy(
    method: "deployApp" | "redeployApp" | "checkDeploy",
  ): unknown {
    const call = calls.find((c) => c.method === method);
    const body = method === "redeployApp" ? call?.args[1] : call?.args[0];
    return (body as { assets?: unknown } | undefined)?.assets;
  }

  describe("flag parsing", () => {
    it("ships a single small file inline, at the given app-path, with no presign round trip", async () => {
      const local = writeLocal("logo.png", "x");
      await runDeploy(argv([dir, "--asset", `${local}=brand/logo.png`]));
      expect(assetsSentBy("deployApp")).toEqual([
        { path: "brand/logo.png", content_base64: "eA==" },
      ]);
      expect(fakeClient.presignBlob).not.toHaveBeenCalled();
    });

    it("accepts multiple --asset flags, each shipped", async () => {
      const a = writeLocal("a.txt", "a");
      const b = writeLocal("b.txt", "b");
      await runDeploy(
        argv([dir, "--asset", `${a}=x/a.txt`, "--asset", `${b}=y/b.txt`]),
      );
      expect(assetsSentBy("deployApp")).toEqual([
        { path: "x/a.txt", content_base64: "YQ==", mime: "text/plain" },
        { path: "y/b.txt", content_base64: "Yg==", mime: "text/plain" },
      ]);
    });

    it("strips a leading '/' on the app-path, since every relay-side path is relative", async () => {
      const local = writeLocal("logo.png", "x");
      await runDeploy(argv([dir, "--asset", `${local}=/logo.png`]));
      expect(assetsSentBy("deployApp")).toEqual([
        { path: "logo.png", content_base64: "eA==" },
      ]);
    });

    it("rejects a value with no '=', showing the expected form", async () => {
      const local = writeLocal("logo.png", "x");
      await expect(runDeploy(argv([dir, "--asset", local]))).rejects.toThrow(
        "__exit_1__",
      );
      expectExit(1);
      expect(stderr).toContain("<local>=<app-path>");
      expect(calls).toEqual([]);
    });

    it("rejects a value with an empty local half", async () => {
      await expect(
        runDeploy(argv([dir, "--asset", "=logo.png"])),
      ).rejects.toThrow("__exit_1__");
      expectExit(1);
      expect(stderr).toContain("<local>=<app-path>");
      expect(calls).toEqual([]);
    });

    it("rejects a value with an empty app-path half", async () => {
      const local = writeLocal("logo.png", "x");
      await expect(
        runDeploy(argv([dir, "--asset", `${local}=`])),
      ).rejects.toThrow("__exit_1__");
      expectExit(1);
      expect(stderr).toContain("<local>=<app-path>");
      expect(calls).toEqual([]);
    });

    it("fails naming the path when the local file does not exist", async () => {
      const missing = join(dir, "nope.png");
      await expect(
        runDeploy(argv([dir, "--asset", `${missing}=logo.png`])),
      ).rejects.toThrow("__exit_1__");
      expectExit(1);
      expect(stderr).toContain(missing);
      expect(stderr).toContain("not found");
      expect(calls).toEqual([]);
    });

    it("fails naming the path when the local path is a directory, not a file", async () => {
      const sub = join(dir, "adir");
      mkdirSync(sub);
      await expect(
        runDeploy(argv([dir, "--asset", `${sub}=logo.png`])),
      ).rejects.toThrow("__exit_1__");
      expectExit(1);
      expect(stderr).toContain(sub);
      expect(calls).toEqual([]);
    });

    it("validates the app-path with the same charset readAssets uses", async () => {
      const local = writeLocal("logo.png", "x");
      await expect(
        runDeploy(argv([dir, "--asset", `${local}=my logo.png`])),
      ).rejects.toThrow("__exit_1__");
      expectExit(1);
      expect(stderr).toContain("A-Za-z0-9._/-");
      expect(calls).toEqual([]);
    });

    it("refuses a non-servable extension (.js) the same way readAssets does", async () => {
      const local = writeLocal("script.js", "console.log(1)");
      await expect(
        runDeploy(argv([dir, "--asset", `${local}=app.js`])),
      ).rejects.toThrow("__exit_1__");
      expectExit(1);
      expect(stderr).toContain("nosniff");
      expect(calls).toEqual([]);
    });
  });

  describe("merge with directory-convention assets", () => {
    it("adds an --asset alongside directory assets", async () => {
      writeAsset("logo.png", "d");
      const local = writeLocal("extra.txt", "e");
      await runDeploy(argv([dir, "--asset", `${local}=extra.txt`]));
      expect(assetsSentBy("deployApp")).toEqual([
        { path: "assets/logo.png", content_base64: "ZA==" },
        { path: "extra.txt", content_base64: "ZQ==", mime: "text/plain" },
      ]);
    });

    it("an --asset at the same app-path overrides the directory asset, keeping its position", async () => {
      writeAsset("logo.png", "old");
      const local = writeLocal("new-logo.png", "new");
      await runDeploy(argv([dir, "--asset", `${local}=assets/logo.png`]));
      expect(assetsSentBy("deployApp")).toEqual([
        {
          path: "assets/logo.png",
          content_base64: Buffer.from("new").toString("base64"),
        },
      ]);
    });
  });

  describe("by-reference upload via presign (existing app, single pass)", () => {
    it("presigns, PUTs the raw bytes, confirms, and ships an attachment_id, all in ONE redeploy call", async () => {
      const bytes = Buffer.alloc(1_200_000, 7); // >= 1 MB presign threshold
      const local = writeLocal("video.mp4", bytes);
      await runDeploy(
        argv([dir, "--app", CUID_APP, "--asset", `${local}=media/video.mp4`]),
      );
      expect(calls.map((c) => c.method)).toEqual([
        "getApp", // resolveAppId verifying the cuid-shaped --app value
        "presignBlob",
        "confirmBlob",
        "redeployApp",
        "getApp", // enriching the printed output
      ]);
      const presignCall = calls.find((c) => c.method === "presignBlob")!;
      expect(presignCall.args[0]).toMatchObject({
        scope: "app",
        appId: CUID_APP,
        size: 1_200_000,
        filename: "video.mp4",
      });
      expect(putPresignedMock).toHaveBeenCalledWith(
        "https://storage.test/blob/att_presigned_1?sig=abc",
        bytes,
        expect.any(String),
      );
      expect(fakeClient.confirmBlob).toHaveBeenCalledWith("att_presigned_1");
      expect(assetsSentBy("redeployApp")).toEqual([
        { path: "media/video.mp4", attachment_id: "att_presigned_1" },
      ]);
    });
  });

  describe("by-reference upload on a new app (two round trips)", () => {
    it("deploys without the large asset, presigns against the id the relay just minted, then redeploys carrying the reference", async () => {
      const bytes = Buffer.alloc(2_000_000, 3);
      const local = writeLocal("hero.mp4", bytes);
      await runDeploy(argv([dir, "--asset", `${local}=media/hero.mp4`]));
      expect(calls.map((c) => c.method)).toEqual([
        "deployApp",
        "presignBlob",
        "confirmBlob",
        "redeployApp",
        "getApp",
      ]);
      // The large asset must NOT be part of the FIRST deploy call: the app
      // id it needs to presign against does not exist until this call returns.
      expect(assetsSentBy("deployApp")).toBeUndefined();

      const presignCall = calls.find((c) => c.method === "presignBlob")!;
      expect(presignCall.args[0]).toMatchObject({ appId: CUID_APP });

      const redeployCall = calls.find((c) => c.method === "redeployApp")!;
      expect(redeployCall.args[0]).toBe(CUID_APP);
      expect(assetsSentBy("redeployApp")).toEqual([
        { path: "media/hero.mp4", attachment_id: "att_presigned_1" },
      ]);

      const out = JSON.parse(stdout);
      expect(out).toMatchObject({
        app_id: CUID_APP,
        created: true,
        version: 2, // from the redeployApp mock, not the create's version: 1
      });
    });

    it("still ships small directory + explicit assets on the FIRST deploy, and re-sends them on the redeploy so they are not wiped", async () => {
      writeAsset("logo.png", "d");
      const smallLocal = writeLocal("small.txt", "s");
      const bigLocal = writeLocal("hero.mp4", Buffer.alloc(1_500_000, 1));
      await runDeploy(
        argv([
          dir,
          "--asset",
          `${smallLocal}=small.txt`,
          "--asset",
          `${bigLocal}=media/hero.mp4`,
        ]),
      );
      expect(
        (assetsSentBy("deployApp") as { path: string }[]).map((a) => a.path),
      ).toEqual(["assets/logo.png", "small.txt"]);
      expect(
        (assetsSentBy("redeployApp") as { path: string }[]).map((a) => a.path),
      ).toEqual(["assets/logo.png", "small.txt", "media/hero.mp4"]);
    });
  });

  describe("fallback to inline when presign is unavailable", () => {
    it("ships the asset inline with a stderr warning when presign answers not_implemented and the file still fits the inline cap", async () => {
      fakeClient.presignBlob.mockImplementationOnce((opts: unknown) => {
        calls.push({ method: "presignBlob", args: [opts] });
        return Promise.reject(
          new HomespunApiError(
            501,
            "not_implemented",
            "filesystem backend has no presign route",
          ),
        );
      });
      const bytes = Buffer.alloc(2_000_000, 5); // >= 1 MB threshold, <= 5 MB inline cap
      const local = writeLocal("clip.mp4", bytes);
      await runDeploy(
        argv([dir, "--app", CUID_APP, "--asset", `${local}=media/clip.mp4`]),
      );
      expect(fakeClient.confirmBlob).not.toHaveBeenCalled();
      expect(putPresignedMock).not.toHaveBeenCalled();
      expect(stderr).toContain("presigned upload is not available");
      const assets = assetsSentBy("redeployApp") as {
        path: string;
        content_base64?: string;
      }[];
      const entry = assets.find((a) => a.path === "media/clip.mp4")!;
      expect(entry.content_base64).toBe(bytes.toString("base64"));
    });

    it("fails naming the file when presign is not_implemented and the file is over the inline cap", async () => {
      fakeClient.presignBlob.mockImplementationOnce((opts: unknown) => {
        calls.push({ method: "presignBlob", args: [opts] });
        return Promise.reject(
          new HomespunApiError(
            501,
            "not_implemented",
            "filesystem backend has no presign route",
          ),
        );
      });
      const local = writeLocal("huge.mp4", Buffer.alloc(6_000_000, 9)); // over the 5 MB inline cap
      await expect(
        runDeploy(
          argv([dir, "--app", CUID_APP, "--asset", `${local}=media/huge.mp4`]),
        ),
      ).rejects.toThrow("__exit_1__");
      expectExit(1);
      expect(stderr).toContain(local);
      expect(calls.some((c) => c.method === "redeployApp")).toBe(false);
    });

    it("propagates a real presign failure (not not_implemented) rather than silently falling back to inline", async () => {
      fakeClient.presignBlob.mockImplementationOnce((opts: unknown) => {
        calls.push({ method: "presignBlob", args: [opts] });
        return Promise.reject(
          new HomespunApiError(403, "forbidden", "quota exceeded"),
        );
      });
      const local = writeLocal("clip.mp4", Buffer.alloc(1_200_000, 2));
      await expect(
        runDeploy(
          argv([dir, "--app", CUID_APP, "--asset", `${local}=media/clip.mp4`]),
        ),
      ).rejects.toThrow("__exit_1__");
      expectExit(1);
      expect(calls.some((c) => c.method === "redeployApp")).toBe(false);
      expect(putPresignedMock).not.toHaveBeenCalled();
    });
  });
});

describe("asset paths the relay would reject", () => {
  function writeAsset(rel: string, contents: string): void {
    const full = join(dir, "assets", rel);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, contents);
  }

  it("refuses a filename with a space locally, rather than round-tripping to the relay", async () => {
    writeAsset("my logo.png", "x");
    await expect(runDeploy(argv([dir]))).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(stderr).toContain("my logo.png");
    expect(stderr).toContain("A-Za-z0-9._/-");
    expect(calls).toEqual([]);
  });

  it("refuses an accented filename the same way", async () => {
    writeAsset("café.png", "x");
    await expect(runDeploy(argv([dir]))).rejects.toThrow("__exit_1__");
    expectExit(1);
    expect(calls).toEqual([]);
  });

  it("accepts the characters the relay's charset does allow", async () => {
    writeAsset("a-b_c.2/d.png", "x");
    await runDeploy(argv([dir]));
    const call = calls.find((c) => c.method === "deployApp")!;
    expect((call.args[0] as { assets: { path: string }[] }).assets).toEqual([
      { path: "assets/a-b_c.2/d.png", content_base64: "eA==" },
    ]);
  });
});
