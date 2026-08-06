// Unit tests for resolveJson / resolveText — file-path vs inline content, and
// the I3 fs-error case (only ENOENT means "not a file").

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { resolveJson, resolveText, resolveSecretFlag } from "./input.js";

let dir: string;
let jsonFile: string;
let textFile: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "homespun-input-"));
  jsonFile = join(dir, "payload.json");
  textFile = join(dir, "template.html");
  writeFileSync(jsonFile, JSON.stringify({ from: "file" }));
  writeFileSync(textFile, "<h1>hi</h1>");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveJson", () => {
  it("reads and parses JSON from a file path", () => {
    expect(resolveJson(jsonFile, "--schema")).toEqual({ from: "file" });
  });

  it("parses an inline JSON literal", () => {
    expect(resolveJson('{"from":"inline"}', "--schema")).toEqual({
      from: "inline",
    });
  });

  it("throws a labeled error on invalid JSON", () => {
    expect(() => resolveJson("{not json", "--schema")).toThrow(
      /--schema: not valid JSON/,
    );
  });
});

describe("resolveText", () => {
  it("reads raw text from a file path", () => {
    expect(resolveText(textFile)).toBe("<h1>hi</h1>");
  });

  it("returns an inline literal verbatim (not a path)", () => {
    expect(resolveText("<p>inline</p>")).toBe("<p>inline</p>");
  });

  it("treats a missing path as inline content (ENOENT → not a file)", () => {
    // A non-existent path is JSON-ish text, used verbatim.
    expect(resolveText("/no/such/path/here.html")).toBe(
      "/no/such/path/here.html",
    );
  });
});

describe("resolveSecretFlag", () => {
  const ENV_VAR = "HOMESPUN_TEST_SECRET_FLAG";
  let savedEnv: string | undefined;
  let stderr: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
    stderr = "";
    exitCode = undefined;
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr += String(s);
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}__`);
    }) as never);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      get: () => true,
    });
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = savedEnv;
    vi.restoreAllMocks();
  });

  async function withPipedStdin(
    lines: string[],
    fn: () => Promise<unknown>,
  ): Promise<unknown> {
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
      return await fn();
    } finally {
      Object.defineProperty(process, "stdin", {
        configurable: true,
        get: () => originalStdin,
      });
    }
  }

  it("returns the literal argv value and warns on stderr", async () => {
    const value = await resolveSecretFlag("s3cr3t", ENV_VAR, "--secret");
    expect(value).toBe("s3cr3t");
    expect(stderr).toContain("warning:");
    expect(stderr).toContain("--secret");
  });

  it("reads from stdin and strips one trailing newline", async () => {
    const value = await withPipedStdin(["s3cr3t\n"], () =>
      resolveSecretFlag("-", ENV_VAR, "--secret"),
    );
    expect(value).toBe("s3cr3t");
  });

  it("reads from stdin and strips one trailing CRLF", async () => {
    const value = await withPipedStdin(["s3cr3t\r\n"], () =>
      resolveSecretFlag("-", ENV_VAR, "--secret"),
    );
    expect(value).toBe("s3cr3t");
  });

  it("refuses '-' when stdin is a TTY", async () => {
    await expect(resolveSecretFlag("-", ENV_VAR, "--secret")).rejects.toThrow(
      "__exit_1__",
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("TTY");
  });

  it("falls back to the env var when the flag is not given", async () => {
    process.env[ENV_VAR] = "s3cr3t_env";
    const value = await resolveSecretFlag(undefined, ENV_VAR, "--secret");
    expect(value).toBe("s3cr3t_env");
    expect(stderr).toBe("");
  });

  it("returns undefined when neither the flag nor the env var is set", async () => {
    const value = await resolveSecretFlag(undefined, ENV_VAR, "--secret");
    expect(value).toBeUndefined();
  });
});

describe("isFilePath fs-error handling (I3)", () => {
  it("propagates a non-ENOENT fs error instead of misreporting as inline", () => {
    // An unreadable directory makes statSync on a child throw EACCES on most
    // POSIX systems. Skip the assertion when running as root (no EACCES).
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const locked = mkdtempSync(join(tmpdir(), "homespun-locked-"));
    const child = join(locked, "inner.json");
    writeFileSync(child, "{}");
    try {
      chmodSync(locked, 0o000);
      // statSync(child) should now fail with EACCES, not ENOENT.
      expect(() => resolveJson(child, "--schema")).toThrow(/cannot stat/);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });
});
