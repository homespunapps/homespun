// Tests for `homespun data <app> <coll> import`: the NDJSON/JSON-array bulk
// import (Wave B). Verifies: one process imports 150 rows in chunks of 100 via
// the batch API, resolveAppId is called ONCE (not per chunk), and per-row
// failures are surfaced in the final summary by their GLOBAL index.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Call {
  method: string;
  args: unknown[];
}
const calls: Call[] = [];

// A fake client: getApp resolves the id (resolveAppId), batchRows returns a
// per-row result, failing the one row whose data.i === 105.
const fakeClient = {
  getApp: vi.fn((id: string) => {
    calls.push({ method: "getApp", args: [id] });
    return Promise.resolve({ id });
  }),
  batchRows: vi.fn(
    (
      appId: string,
      collection: string,
      rows: { key?: string; data: { i: number } }[],
    ) => {
      calls.push({
        method: "batchRows",
        args: [appId, collection, rows.length],
      });
      const results = rows.map((row, idx) => {
        if (row.data.i === 105) {
          return {
            index: idx,
            ok: false,
            error: {
              code: "row_schema_violation",
              message: "bad",
              status: 422,
            },
          };
        }
        return { index: idx, ok: true, key: `k${row.data.i}` };
      });
      const ok = results.filter((r) => r.ok).length;
      return Promise.resolve({
        results,
        ok_count: ok,
        error_count: results.length - ok,
      });
    },
  ),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
}));

import { runData } from "./data.js";
import { parseArgs } from "../argv.js";

const BOOLS = new Set(["json", "help", "yes", "emit-effects"]);

function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLS);
}

let stdout: string;
let stderr: string;
let exitCode: number | undefined;
let tmp: string;

beforeEach(() => {
  calls.length = 0;
  fakeClient.getApp.mockClear();
  fakeClient.batchRows.mockClear();
  stdout = "";
  stderr = "";
  exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += s;
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += s;
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
  tmp = mkdtempSync(join(tmpdir(), "hs-import-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

// A cuid-shaped app id so resolveAppId takes the getApp fast path (one lookup).
const APP_ID = "clabcdefgh0000000000000001";

describe("homespun data import", () => {
  it("imports 150 NDJSON rows in one process, chunked, with a per-row failure listed", async () => {
    const path = join(tmp, "rows.ndjson");
    const lines = Array.from({ length: 150 }, (_, i) => JSON.stringify({ i }));
    writeFileSync(path, lines.join("\n") + "\n", "utf8");

    await runData(argv([APP_ID, "items", "import", "--file", path]));

    // resolveAppId resolved ONCE for the whole import.
    expect(fakeClient.getApp).toHaveBeenCalledTimes(1);
    // 150 rows / chunk 100 => 2 batch calls (100 + 50).
    expect(fakeClient.batchRows).toHaveBeenCalledTimes(2);
    const batchCalls = calls.filter((c) => c.method === "batchRows");
    expect(batchCalls[0]!.args[2]).toBe(100);
    expect(batchCalls[1]!.args[2]).toBe(50);

    const summary = JSON.parse(stdout);
    expect(summary.total).toBe(150);
    expect(summary.imported).toBe(149);
    expect(summary.failed).toBe(1);
    expect(summary.chunks).toBe(2);
    expect(summary.silent).toBe(true); // default silent
    expect(summary.failures).toHaveLength(1);
    // The failure is reported by its GLOBAL index (105), not the per-chunk index.
    expect(summary.failures[0].index).toBe(105);
    expect(summary.failures[0].error.code).toBe("row_schema_violation");
  });

  it("accepts a JSON array file too, and honors --emit-effects", async () => {
    const path = join(tmp, "rows.json");
    const arr = Array.from({ length: 3 }, (_, i) => ({ i }));
    writeFileSync(path, JSON.stringify(arr), "utf8");

    await runData(
      argv([APP_ID, "items", "import", "--file", path, "--emit-effects"]),
    );

    expect(fakeClient.batchRows).toHaveBeenCalledTimes(1);
    // emitEffects was passed through to the batch call.
    const opts = fakeClient.batchRows.mock.calls[0]![3] as {
      emitEffects?: boolean;
    };
    expect(opts.emitEffects).toBe(true);
    const summary = JSON.parse(stdout);
    expect(summary.total).toBe(3);
    expect(summary.imported).toBe(3);
    expect(summary.silent).toBe(false);
  });

  it("fails cleanly when --file is missing", async () => {
    await expect(runData(argv([APP_ID, "items", "import"]))).rejects.toThrow(
      /__exit_1__/,
    );
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/--file is required/);
  });
});
