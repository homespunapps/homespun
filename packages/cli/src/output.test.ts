// Integration tests for the upgrade-required exit path through failFromError
// and failUpgradeRequired. The skill (skills/homespun/SKILL.md) instructs the
// agent's harness to detect a CLI-upgrade situation by:
//   - stderr containing "this relay requires @homespunapps/cli >="
//   - process exiting with code 75 (sysexits EX_TEMPFAIL)
//
// Both shapes must hold; this file pins them so a future refactor can't
// silently break the contract.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HomespunApiError } from "@homespunapps/core";
import { failFromError, failUpgradeRequired } from "./output.js";

let stderr: string;
let exitCode: number | undefined;

beforeEach(() => {
  stderr = "";
  exitCode = undefined;
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += String(s);
    return true;
  });
  // process.exit is mocked to throw a marker so we can resume control after
  // the never-returning failX call — matches the existing CLI test style.
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function expectMarker(fn: () => void, code: number): void {
  try {
    fn();
    throw new Error("expected process.exit but function returned normally");
  } catch (e) {
    if (!(e instanceof Error && e.message === `__exit_${code}__`)) throw e;
  }
}

describe("failFromError on a 426 cli_upgrade_required", () => {
  it("prints the upgrade message and exits 75 (not the generic JSON envelope)", () => {
    const err = new HomespunApiError(
      426,
      "cli_upgrade_required",
      "this relay requires @homespunapps/cli >= 0.0.7 (you sent 0.0.5)",
      { min_version: "0.0.7", your_version: "0.0.5" },
    );

    expectMarker(() => failFromError(err), 75);
    expect(exitCode).toBe(75);
    // The skill's "if you see this error" instructions match on this prefix
    // and version strings — keep both present.
    expect(stderr).toContain("this relay requires @homespunapps/cli >= 0.0.7");
    expect(stderr).toContain("0.0.5");
    // The CLI must NOT also print the generic { error: {...} } JSON envelope
    // here — the upgrade message stands alone so the agent's stderr parser
    // doesn't see two competing structures.
    expect(stderr).not.toContain('"code":"cli_upgrade_required"');
  });

  it("falls through to the generic envelope for other HomespunApiError codes", () => {
    // A close cousin (also 4xx, also a HomespunApiError) must NOT trip the
    // upgrade path — that path is specifically for the version-skew code.
    const err = new HomespunApiError(
      429,
      "rate_limited",
      "slow down",
      undefined,
      {
        retryable: true,
      },
    );
    expectMarker(() => failFromError(err), 1);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('"code":"rate_limited"');
  });
});

describe("failUpgradeRequired (direct entry)", () => {
  it("prints the version line and exits 75", () => {
    const err = new HomespunApiError(426, "cli_upgrade_required", "x", {
      min_version: "0.0.7",
      your_version: "0.0.5",
    });
    expectMarker(() => failUpgradeRequired(err), 75);
    expect(exitCode).toBe(75);
    expect(stderr).toContain(">= 0.0.7");
    expect(stderr).toContain("0.0.5");
  });

  it("does not crash on a malformed details payload", () => {
    // A misbehaving relay could 426 with no details at all. The upgrade
    // path must still exit cleanly — the agent has nothing to act on, but
    // a crash mid-error-handling would be far worse than a vague message.
    const err = new HomespunApiError(426, "cli_upgrade_required", "x", null);
    expectMarker(() => failUpgradeRequired(err), 75);
    expect(exitCode).toBe(75);
    expect(stderr).toContain("?");
  });
});

// The `report` key is how the CLI tells an agent "this failure was ours, file
// it" without the agent having to judge a status code. It rides the error
// envelope alongside `hint`, and must never appear on a 4xx, where the cause
// is normally the caller's own bad argument.
describe("failFromError's report prompt", () => {
  function envelopeFor(status: number, code: string) {
    // Reset per call: stderr accumulates, and a test asserting on two
    // failures in a row would otherwise parse two concatenated envelopes.
    stderr = "";
    const err = new HomespunApiError(status, code, "boom");
    expectMarker(() => failFromError(err), 1);
    return JSON.parse(stderr) as {
      error: { report?: string; hint?: string; code: string };
    };
  }

  it("appears on a 5xx", () => {
    const { error } = envelopeFor(500, "internal");
    expect(error.report).toContain("feedback");
    expect(error.code).toBe("internal");
  });

  it("does not appear on a 4xx", () => {
    expect(envelopeFor(404, "not_found").error.report).toBeUndefined();
    expect(envelopeFor(409, "conflict").error.report).toBeUndefined();
  });

  // `hint` is the relay's own remediation advice for the caller's request.
  // The report prompt must not overwrite or impersonate it.
  it("does not clobber a relay-supplied hint", () => {
    const err = new HomespunApiError(503, "unavailable", "boom", undefined, {
      hint: "retry in a moment",
    });
    expectMarker(() => failFromError(err), 1);
    const { error } = JSON.parse(stderr) as {
      error: { report?: string; hint?: string };
    };
    expect(error.hint).toBe("retry in a moment");
    expect(error.report).toBeDefined();
  });
});
