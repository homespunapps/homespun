// Tests for `homespun apps`:
//   - printFeedEntryLine is the SINGLE function both the WS entry handler
//     and the long-poll fallback loop call — pinning that both transports
//     produce byte-identical stdout lines for the same AppFeedEntry
//     (spec-cli §5's "the stdout contract is transport-blind by
//     construction").
//   - parseCollectionFilter / isDormantConflict are the small parsing/
//     guard helpers the watch loop relies on.
//   - "runApps dispatch" further down drives real command dispatch
//     (delete's --yes gate; watch's WS-connect-failure -> long-poll
//     fallback) against a fake client stubbed via vi.mock on ../config.js.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import { HomespunApiError } from "@homespunapps/core";
import type { AppFeedEntry } from "@homespunapps/core";

// A recording fake of the bits of HomespunClient `runApps` (delete/watch) uses,
// stubbed via vi.mock on ../config.js — the "runApps dispatch" describe
// blocks below drive real command dispatch (not just the pure helpers
// above) against this fake, per-test-configurable client.
const watchFakeClient = {
  listApps: vi.fn(),
  getApp: vi.fn(),
  getAppFeed: vi.fn(),
  deleteApp: vi.fn(),
  restoreApp: vi.fn(),
  purgeApp: vi.fn(),
  getAppDomain: vi.fn(),
  setAppDomain: vi.fn(),
  deleteAppDomain: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => watchFakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import {
  isDormantConflict,
  parseCollectionFilter,
  printFeedEntryLine,
  runApps,
} from "./apps.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

function entry(overrides: Partial<AppFeedEntry> = {}): AppFeedEntry {
  return {
    seq: 1,
    op: "create",
    collection_name: "items",
    row_key: "milk",
    data: { name: "Milk" },
    author: { kind: "agent", id: "agt_1" },
    ts: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseCollectionFilter", () => {
  it("returns null when --collection was not given (no filtering)", () => {
    expect(parseCollectionFilter(undefined)).toBeNull();
  });

  it("parses a comma-separated list", () => {
    expect(parseCollectionFilter("items,log")).toEqual(
      new Set(["items", "log"]),
    );
  });

  it("trims whitespace and drops empty entries", () => {
    expect(parseCollectionFilter(" items , , log ,")).toEqual(
      new Set(["items", "log"]),
    );
  });
});

describe("printFeedEntryLine — the transport-blind stdout contract", () => {
  let stdout: string;
  beforeEach(() => {
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      stdout += String(s);
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the exact same JSON line regardless of which 'transport' calls it", () => {
    const e = entry();
    // Simulate: the WS onEntry handler calls this...
    printFeedEntryLine(e, null);
    const wsLine = stdout;
    stdout = "";
    // ...and the long-poll loop calls it with the SAME entry object.
    printFeedEntryLine(e, null);
    const longPollLine = stdout;

    expect(wsLine).toBe(longPollLine);
    expect(JSON.parse(wsLine)).toEqual(e);
    // Compact (single line), matching printJsonLine's contract for `watch`.
    expect(wsLine.trim().split("\n")).toHaveLength(1);
  });

  it("suppresses an entry whose collection isn't in the filter set", () => {
    printFeedEntryLine(entry({ collection_name: "log" }), new Set(["items"]));
    expect(stdout).toBe("");
  });

  it("prints an entry whose collection IS in the filter set", () => {
    printFeedEntryLine(entry({ collection_name: "items" }), new Set(["items"]));
    expect(JSON.parse(stdout)).toMatchObject({ collection_name: "items" });
  });

  it("prints every entry when no filter is set (null)", () => {
    printFeedEntryLine(entry({ collection_name: "anything" }), null);
    expect(JSON.parse(stdout)).toMatchObject({ collection_name: "anything" });
  });
});

describe("isDormantConflict", () => {
  it("recognizes the relay's 'app is dormant' 409 conflict", () => {
    const err = new HomespunApiError(409, "conflict", "app is dormant");
    expect(isDormantConflict(err)).toBe(true);
  });

  it("does not match a different conflict message", () => {
    const err = new HomespunApiError(409, "conflict", "row version mismatch");
    expect(isDormantConflict(err)).toBe(false);
  });

  it("does not match a non-HomespunApiError", () => {
    expect(isDormantConflict(new Error("app is dormant"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runApps dispatch — real command execution against the fake client above.
// ---------------------------------------------------------------------------

const APPS_TEST_BOOLS = new Set(["yes", "once", "help"]);

/** Parse raw CLI tokens the same way index.ts does, so `--yes`/`--once`
 * land in `bools` (not as literal positionals) exactly like a real
 * invocation. */
function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, APPS_TEST_BOOLS);
}

/** Bind an ephemeral port, then release it immediately so nothing listens
 * there — connecting to it deterministically fails with ECONNREFUSED,
 * reproducing a real WS-connect-failure without a flaky hardcoded port. */
async function unreachablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("runApps dispatch — 'apps delete' requires --yes (regression)", () => {
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
    // fail() calls process.exit(1); throw instead so the test can catch it
    // and control returns to the assertions below.
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
      await runApps(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  it("refuses to delete without --yes — no resolution or delete call fires", async () => {
    await run(["delete", "my-app"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--yes");
    expect(watchFakeClient.listApps).not.toHaveBeenCalled();
    expect(watchFakeClient.getApp).not.toHaveBeenCalled();
    expect(watchFakeClient.deleteApp).not.toHaveBeenCalled();
  });

  it("deletes when --yes is given", async () => {
    watchFakeClient.listApps.mockResolvedValue({ items: [{ id: "app_1" }] });
    watchFakeClient.deleteApp.mockResolvedValue(undefined);

    await run(["delete", "my-app", "--yes"]);

    expect(exitCode).toBeUndefined();
    expect(watchFakeClient.deleteApp).toHaveBeenCalledWith("app_1");
    // `restorable` is what tells a caller reading only this JSON that the app
    // can be brought back, rather than that it is gone.
    expect(JSON.parse(stdout)).toEqual({
      deleted: true,
      app_id: "app_1",
      restorable: true,
    });
  });

  it("tells the user how to get the app back instead of calling it permanent", async () => {
    // The old copy said 'permanently removes the app and all its data', which
    // was never true: the delete is a soft delete with a retention window.
    await run(["delete", "my-app"]);
    expect(stderr).toContain("apps restore");
    expect(stderr).not.toContain("permanently removes");
  });

  it("'apps deleted' asks the relay for the trash listing", async () => {
    watchFakeClient.listApps.mockResolvedValue({
      items: [],
      next_cursor: null,
    });
    await run(["deleted"]);
    expect(exitCode).toBeUndefined();
    expect(watchFakeClient.listApps).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted" }),
    );
  });

  it("'apps restore' resolves the slug inside the trash, where it actually is", async () => {
    // Without includeDeleted the resolution hides the very app being restored
    // and the command would fail with app_not_found on its own target.
    watchFakeClient.listApps.mockResolvedValue({ items: [{ id: "app_1" }] });
    watchFakeClient.restoreApp.mockResolvedValue({ id: "app_1" });

    await run(["restore", "my-app"]);

    expect(exitCode).toBeUndefined();
    expect(watchFakeClient.listApps).toHaveBeenCalledWith(
      expect.objectContaining({ status: "deleted", slug: "my-app" }),
    );
    expect(watchFakeClient.restoreApp).toHaveBeenCalledWith("app_1");
  });

  it("refuses to purge without --yes, and resolves nothing first", async () => {
    await run(["purge", "my-app"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--yes");
    expect(watchFakeClient.listApps).not.toHaveBeenCalled();
    expect(watchFakeClient.purgeApp).not.toHaveBeenCalled();
  });

  it("purges when --yes is given", async () => {
    watchFakeClient.listApps.mockResolvedValue({ items: [{ id: "app_1" }] });
    watchFakeClient.purgeApp.mockResolvedValue(undefined);

    await run(["purge", "my-app", "--yes"]);

    expect(exitCode).toBeUndefined();
    expect(watchFakeClient.purgeApp).toHaveBeenCalledWith("app_1");
    expect(JSON.parse(stdout)).toEqual({ purged: true, app_id: "app_1" });
  });
});

describe("runApps dispatch — 'apps watch' WS-connect-failure -> long-poll fallback (HIGH bug regression)", () => {
  let stdout: string;
  let exitCalls: Array<number | undefined>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = "";
    exitCalls = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      stdout += String(s);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // Non-throwing stub: the pre-fix bug's failure path calls fail() ->
    // process.exit(1) from INSIDE a real WebSocket 'close' event callback
    // (not something this test's own call stack can catch with try/catch).
    // Recording the call instead of throwing lets the assertions below
    // observe whether the abnormal-exit path fired, however it fires.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCalls.push(code);
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    "does NOT crash with ws_closed_abnormally on a refused WS connection — " +
      "degrades to long-poll and streams the identical JSON line",
    async () => {
      const port = await unreachablePort();
      const entry: AppFeedEntry = {
        seq: 1,
        op: "create",
        collection_name: "items",
        row_key: "milk",
        data: { name: "Milk" },
        author: { kind: "agent", id: "agt_1" },
        ts: "2026-01-01T00:00:00.000Z",
      };

      watchFakeClient.listApps.mockResolvedValue({ items: [{ id: "app_1" }] });
      watchFakeClient.getApp.mockResolvedValue({
        url: `http://127.0.0.1:${port}/`,
      });
      watchFakeClient.getAppFeed.mockResolvedValue({
        entries: [entry],
        cursor: 1,
      });

      // --once: the long-poll loop finishes cleanly after the first entry
      // (finish(0)) instead of polling forever, so the test can settle.
      void runApps(makeArgs(["watch", "my-app", "--once"]));

      await vi.waitFor(
        () => {
          expect(watchFakeClient.getAppFeed).toHaveBeenCalled();
          expect(stdout.trim().length).toBeGreaterThan(0);
        },
        { timeout: 2000, interval: 10 },
      );

      // (a) never exits 1 with ws_closed_abnormally — the pre-fix bug's
      // onClose ran fail() despite the long-poll fallback already owning
      // termination. Exit 0 (via --once's finish(0)) is fine; exit 1 is the
      // regression.
      expect(exitCalls).not.toContain(1);
      // (b)/(c) the long-poll fallback actually streamed the entry, and the
      // printed line is byte-identical to the shared transport-blind
      // contract (printFeedEntryLine, covered directly above) would print.
      expect(watchFakeClient.getAppFeed).toHaveBeenCalledWith("app_1", {
        since: 0,
        wait: 25,
      });
      expect(JSON.parse(stdout.trim().split("\n")[0]!)).toEqual(entry);
    },
  );
});

// ---------------------------------------------------------------------------
// `apps domain` — the CLI half of custom domains.
// ---------------------------------------------------------------------------

describe("runApps dispatch — 'apps domain'", () => {
  let stdout: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = "";
    exitCode = undefined;
    watchFakeClient.getApp.mockResolvedValue({ id: "app_1", slug: "shop" });
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      stdout += String(s);
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}__`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("add binds the domain and prints the DNS records to publish", async () => {
    // The records ARE the output: nothing works until the domain owner
    // publishes them, so a silent success would be useless.
    watchFakeClient.setAppDomain.mockResolvedValue({
      domain: "shop.example.com",
      status: "pending",
      dns_records: [
        {
          type: "CNAME",
          name: "shop.example.com",
          value: "cname.homespunapps.com",
          purpose: "routing",
        },
      ],
    });
    await runApps(makeArgs(["domain", "add", "shop", "shop.example.com"]));
    expect(watchFakeClient.setAppDomain).toHaveBeenCalledWith(
      "app_1",
      "shop.example.com",
    );
    expect(stdout).toContain("cname.homespunapps.com");
    expect(stdout).toContain("pending");
  });

  it("show prints the serving domain with its aliases", async () => {
    watchFakeClient.getAppDomain.mockResolvedValue({
      domain: "example.com",
      status: "active",
      dns_records: [],
      aliases: [
        {
          domain: "www.example.com",
          status: "active",
          redirect_to: "example.com",
        },
      ],
    });
    await runApps(makeArgs(["domain", "show", "shop"]));
    expect(stdout).toContain("www.example.com");
    expect(stdout).toContain("example.com");
  });

  it("remove with no domain unbinds them all", async () => {
    watchFakeClient.deleteAppDomain.mockResolvedValue(undefined);
    await runApps(makeArgs(["domain", "remove", "shop"]));
    expect(watchFakeClient.deleteAppDomain).toHaveBeenCalledWith(
      "app_1",
      undefined,
    );
    expect(stdout).toContain("all");
  });

  it("remove with a domain unbinds only that one", async () => {
    watchFakeClient.deleteAppDomain.mockResolvedValue(undefined);
    await runApps(makeArgs(["domain", "remove", "shop", "www.example.com"]));
    expect(watchFakeClient.deleteAppDomain).toHaveBeenCalledWith(
      "app_1",
      "www.example.com",
    );
    expect(stdout).toContain("www.example.com");
  });

  it("rejects add without a domain, and an unknown action", async () => {
    await expect(runApps(makeArgs(["domain", "add", "shop"]))).rejects.toThrow(
      "__exit_1__",
    );
    expect(exitCode).toBe(1);
    expect(watchFakeClient.setAppDomain).not.toHaveBeenCalled();

    await expect(
      runApps(makeArgs(["domain", "rotate", "shop"])),
    ).rejects.toThrow("__exit_1__");
  });
});
