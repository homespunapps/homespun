// Tests for `homespun ingest signing-secret set` — covers only the --secret
// flag's non-argv paths (stdin sentinel, env var fallback, argv-still-works
// with a warning, TTY refusal). Drives real command dispatch against a fake
// client stubbed via vi.mock on ../config.js, mirroring connection.test.ts.
// The other ingest verbs (list/rotate/backfill) carry no secret-bearing
// flags and are not covered here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Readable } from "node:stream";

const fakeClient = {
  getApp: vi.fn(),
  listApps: vi.fn(),
  setIngestSigningSecret: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import { runIngest } from "./ingest.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

const INGEST_TEST_BOOLS = new Set(["help"]);

function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, INGEST_TEST_BOOLS);
}

const CUID = "appabcdefghijklmnopqrstu";

describe("runIngest signing-secret set --secret", () => {
  let stdout: string;
  let stderr: string;
  let exitCode: number | undefined;
  let savedSigningSecretEnv: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = "";
    stderr = "";
    exitCode = undefined;
    savedSigningSecretEnv = process.env.HOMESPUN_INGEST_SIGNING_SECRET;
    delete process.env.HOMESPUN_INGEST_SIGNING_SECRET;
    fakeClient.getApp.mockResolvedValue({ id: CUID });
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
    // Pretend stdin is a TTY by default, matching a real interactive shell.
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      get: () => true,
    });
  });

  afterEach(() => {
    if (savedSigningSecretEnv === undefined) {
      delete process.env.HOMESPUN_INGEST_SIGNING_SECRET;
    } else {
      process.env.HOMESPUN_INGEST_SIGNING_SECRET = savedSigningSecretEnv;
    }
    vi.restoreAllMocks();
  });

  async function run(tokens: string[]): Promise<void> {
    try {
      await runIngest(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  // Swap process.stdin for a piped Readable for the duration of `fn`, then
  // restore it — mirrors the pattern in feedback.test.ts / connection.test.ts.
  async function withPipedStdin(
    lines: string[],
    fn: () => Promise<void>,
  ): Promise<void> {
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      get: () => false,
    });
    const piped = Readable.from(lines) as unknown as typeof process.stdin;
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", {
      configurable: true,
      get: () => piped,
    });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, "stdin", {
        configurable: true,
        get: () => originalStdin,
      });
    }
  }

  it("mints server-side (no --secret) and requires --app/--name", async () => {
    await run(["signing-secret", "set"]);
    expect(exitCode).toBe(1);
    expect(fakeClient.setIngestSigningSecret).not.toHaveBeenCalled();
  });

  it("omitting --secret entirely still mints server-side", async () => {
    fakeClient.setIngestSigningSecret.mockResolvedValue({
      secret: "whsec_minted",
      fingerprint: "fp_1",
      setAt: "2026-08-05T00:00:00.000Z",
    });
    await run(["signing-secret", "set", "--app", CUID, "--name", "hook1"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.setIngestSigningSecret).toHaveBeenCalledWith(
      CUID,
      "hook1",
      {},
    );
    expect(JSON.parse(stdout).secret).toBe("whsec_minted");
  });

  it("reads --secret from stdin when '-' is given", async () => {
    fakeClient.setIngestSigningSecret.mockResolvedValue({
      fingerprint: "fp_2",
      setAt: "2026-08-05T00:00:00.000Z",
    });
    await withPipedStdin(["whsec_from_stdin\n"], () =>
      run([
        "signing-secret",
        "set",
        "--app",
        CUID,
        "--name",
        "hook1",
        "--secret",
        "-",
      ]),
    );
    expect(exitCode).toBeUndefined();
    expect(fakeClient.setIngestSigningSecret).toHaveBeenCalledWith(
      CUID,
      "hook1",
      { secret: "whsec_from_stdin" },
    );
  });

  it("refuses --secret - when stdin is a TTY", async () => {
    await run([
      "signing-secret",
      "set",
      "--app",
      CUID,
      "--name",
      "hook1",
      "--secret",
      "-",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("TTY");
    expect(fakeClient.setIngestSigningSecret).not.toHaveBeenCalled();
  });

  it("falls back to HOMESPUN_INGEST_SIGNING_SECRET when --secret is omitted", async () => {
    fakeClient.setIngestSigningSecret.mockResolvedValue({
      fingerprint: "fp_3",
      setAt: "2026-08-05T00:00:00.000Z",
    });
    process.env.HOMESPUN_INGEST_SIGNING_SECRET = "whsec_from_env";
    await run(["signing-secret", "set", "--app", CUID, "--name", "hook1"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.setIngestSigningSecret).toHaveBeenCalledWith(
      CUID,
      "hook1",
      { secret: "whsec_from_env" },
    );
  });

  it("still accepts --secret on argv, with a stderr warning", async () => {
    fakeClient.setIngestSigningSecret.mockResolvedValue({
      fingerprint: "fp_4",
      setAt: "2026-08-05T00:00:00.000Z",
    });
    await run([
      "signing-secret",
      "set",
      "--app",
      CUID,
      "--name",
      "hook1",
      "--secret",
      "whsec_argv",
    ]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.setIngestSigningSecret).toHaveBeenCalledWith(
      CUID,
      "hook1",
      { secret: "whsec_argv" },
    );
    expect(stderr).toContain("--secret");
    expect(stderr).toContain("warning:");
  });
});
