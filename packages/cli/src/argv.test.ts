// Unit tests for the hand-rolled argv parser.

import { describe, it, expect } from "vitest";
import {
  parseArgs,
  ArgvError,
  assertKnownFlags,
  BOOLEAN_FLAGS,
} from "./argv.js";

const BOOLS = new Set(["json", "once", "help", "version"]);

describe("parseArgs", () => {
  it("collects positionals", () => {
    const r = parseArgs(["pan_1", "pan_2"], BOOLS);
    expect(r.positionals).toEqual(["pan_1", "pan_2"]);
  });

  it("parses --flag value", () => {
    const r = parseArgs(["--url", "https://x.test"], BOOLS);
    expect(r.flags.get("url")).toBe("https://x.test");
  });

  it("parses --flag=value", () => {
    const r = parseArgs(["--url=https://x.test"], BOOLS);
    expect(r.flags.get("url")).toBe("https://x.test");
  });

  it("parses boolean flags", () => {
    const r = parseArgs(["--once"], BOOLS);
    expect(r.bools.has("once")).toBe(true);
  });

  it("maps -h and --help to the help bool", () => {
    expect(parseArgs(["-h"], BOOLS).bools.has("help")).toBe(true);
    expect(parseArgs(["--help"], BOOLS).bools.has("help")).toBe(true);
  });

  it("records a value-flag with no argument as dangling (does NOT throw)", () => {
    // Splitting the "requires a value" decision off the parser keeps the
    // unknown-flag message uniform whether or not a token follows the
    // typo — assertKnownFlags is the single decider. See the field doc
    // on ParsedArgs.danglingValueFlags.
    const r = parseArgs(["--url"], BOOLS);
    expect(r.danglingValueFlags!.has("url")).toBe(true);
    expect(r.flags.has("url")).toBe(false);
  });

  it("records a value-flag followed by another flag as dangling", () => {
    const r = parseArgs(["--url", "--api-key", "k"], BOOLS);
    expect(r.danglingValueFlags!.has("url")).toBe(true);
    expect(r.flags.get("api-key")).toBe("k");
  });

  it("does not throw for a boolean flag at end of argv", () => {
    expect(() => parseArgs(["--once"], BOOLS)).not.toThrow();
  });

  it("handles a mix of positionals, flags, and bools", () => {
    const r = parseArgs(
      ["watch", "pan_1", "--type", "form.submitted", "--once"],
      BOOLS,
    );
    expect(r.positionals).toEqual(["watch", "pan_1"]);
    expect(r.flags.get("type")).toBe("form.submitted");
    expect(r.bools.has("once")).toBe(true);
  });

  it("throws on a repeated value-flag (space form)", () => {
    expect(() => parseArgs(["--url", "a", "--url", "b"], BOOLS)).toThrow(
      ArgvError,
    );
    expect(() => parseArgs(["--url", "a", "--url", "b"], BOOLS)).toThrow(
      "duplicate flag: --url",
    );
  });

  it("throws on a repeated value-flag (equals form)", () => {
    expect(() => parseArgs(["--url=a", "--url=b"], BOOLS)).toThrow(
      "duplicate flag: --url",
    );
  });

  it("throws on a repeated value-flag mixing space + equals", () => {
    expect(() => parseArgs(["--url", "a", "--url=b"], BOOLS)).toThrow(
      "duplicate flag: --url",
    );
  });

  it("throws on a repeated boolean flag", () => {
    expect(() => parseArgs(["--once", "--once"], BOOLS)).toThrow(
      "duplicate flag: --once",
    );
  });

  describe("the real BOOLEAN_FLAGS set (regression #827)", () => {
    // These parse with the exported production set, not a test-local copy.
    // A test-local copy is exactly what masked #827: `check` was in the
    // deploy test's set but not the real one, so trailing `--check` fell
    // into danglingValueFlags and a documented dry run performed a real
    // deploy.
    it("trailing --check parses into bools", () => {
      const r = parseArgs(["deploy", "./my-app", "--check"], BOOLEAN_FLAGS);
      expect(r.bools.has("check")).toBe(true);
      expect(r.danglingValueFlags!.has("check")).toBe(false);
      expect(r.positionals).toEqual(["deploy", "./my-app"]);
    });

    it("leading --check does not swallow the directory as its value", () => {
      const r = parseArgs(["deploy", "--check", "./my-app"], BOOLEAN_FLAGS);
      expect(r.bools.has("check")).toBe(true);
      expect(r.flags.has("check")).toBe(false);
      expect(r.positionals).toEqual(["deploy", "./my-app"]);
    });

    it("covers every bool a command declares in KNOWN_BOOLS", () => {
      // Same bug class as #827 for the other verbs: `agent logout --all`
      // and `members set-role --clear-role` were also missing from the
      // parse-time set.
      for (const name of ["force", "all", "clear-role", "yes", "once"]) {
        expect(BOOLEAN_FLAGS.has(name)).toBe(true);
      }
    });
  });
});

describe("assertKnownFlags", () => {
  const empty = {
    positionals: [],
    flags: new Map<string, string>(),
    bools: new Set<string>(),
  };

  it("accepts nothing-passed", () => {
    expect(() => assertKnownFlags(empty, [], [], "app example")).not.toThrow();
  });

  it("accepts the per-command allow-list", () => {
    const args = {
      positionals: [],
      flags: new Map([
        ["file", "/tmp/x"],
        ["scope", "agent"],
      ]),
      bools: new Set(["once"]),
    };
    expect(() =>
      assertKnownFlags(args, ["file", "scope"], ["once"], "app example"),
    ).not.toThrow();
  });

  it("always accepts global flags (--url / --api-key / --json / --help)", () => {
    const args = {
      positionals: [],
      flags: new Map([
        ["url", "https://x.test"],
        ["api-key", "pk_secret"],
      ]),
      bools: new Set(["json", "help"]),
    };
    // No per-command knowledge — globals still pass.
    expect(() => assertKnownFlags(args, [], [], "app example")).not.toThrow();
  });

  it("rejects an unknown value-flag with a hinted ArgvError", () => {
    const args = {
      positionals: [],
      flags: new Map([["totally-fake-flag", "oops"]]),
      bools: new Set<string>(),
    };
    let caught: ArgvError | undefined;
    try {
      assertKnownFlags(args, ["file"], [], "homespun attachment upload");
    } catch (e) {
      caught = e as ArgvError;
    }
    expect(caught).toBeInstanceOf(ArgvError);
    expect(caught!.message).toBe("unknown flag(s): --totally-fake-flag");
    expect(caught!.hint).toBe(
      "run `homespun attachment upload --help` for the supported flags",
    );
  });

  it("rejects an unknown boolean flag", () => {
    const args = {
      positionals: [],
      flags: new Map<string, string>(),
      bools: new Set(["bogus"]),
    };
    expect(() => assertKnownFlags(args, [], [], "app example")).toThrow(
      "unknown flag(s): --bogus",
    );
  });

  it("reports every unknown flag in one message", () => {
    const args = {
      positionals: [],
      flags: new Map([
        ["foo", "1"],
        ["bar", "2"],
      ]),
      bools: new Set(["baz"]),
    };
    let msg = "";
    try {
      assertKnownFlags(args, [], [], "app example");
    } catch (e) {
      msg = (e as ArgvError).message;
    }
    // All three reported — saves the user re-running once per typo.
    expect(msg).toContain("--foo");
    expect(msg).toContain("--bar");
    expect(msg).toContain("--baz");
  });

  it("reports a dangling unknown flag with the same 'unknown flag(s)' message", () => {
    // The whole point of the danglingValueFlags split: the message for
    // a typo is uniform whether or not a token follows. `homespun config
    // show --bogus` (parser path: dangling) and `homespun config show
    // --bogus something` (parser path: flags.set) MUST app the
    // same envelope.
    const danglingArgs = {
      positionals: [],
      flags: new Map<string, string>(),
      bools: new Set<string>(),
      danglingValueFlags: new Set(["bogus"]),
    };
    const valueArgs = {
      positionals: [],
      flags: new Map([["bogus", "something"]]),
      bools: new Set<string>(),
    };
    const err1 = catchArgvError(() =>
      assertKnownFlags(danglingArgs, [], [], "homespun config show"),
    );
    const err2 = catchArgvError(() =>
      assertKnownFlags(valueArgs, [], [], "homespun config show"),
    );
    expect(err1.message).toBe("unknown flag(s): --bogus");
    expect(err2.message).toBe("unknown flag(s): --bogus");
    expect(err1.hint).toBe(err2.hint);
  });

  it("reports a dangling KNOWN flag as 'requires a value'", () => {
    // A known flag that the user forgot to give a value to still gets
    // the specific message — assertKnownFlags only collapses to
    // "unknown flag(s)" for genuinely unknown names.
    const args = {
      positionals: [],
      flags: new Map<string, string>(),
      bools: new Set<string>(),
      danglingValueFlags: new Set(["title"]),
    };
    expect(() =>
      assertKnownFlags(args, ["title"], [], "homespun create"),
    ).toThrow("--title requires a value");
  });

  it("dangling globals (--url) still app as 'requires a value'", () => {
    const args = {
      positionals: [],
      flags: new Map<string, string>(),
      bools: new Set<string>(),
      danglingValueFlags: new Set(["url"]),
    };
    expect(() => assertKnownFlags(args, [], [], "app example")).toThrow(
      "--url requires a value",
    );
  });

  it("rejects a known BOOL that arrived as a value flag (parse-time drift defense)", () => {
    // #827 defense: if a name in the command's KNOWN_BOOLS shows up in
    // args.flags, the parse-time BOOLEAN_FLAGS set is missing it (or the
    // user wrote --check=x). Either way the bool would silently read as
    // unset, which is how `deploy --check` performed a real deploy. It
    // must fail loudly instead.
    const args = {
      positionals: [],
      flags: new Map([["check", "./my-app"]]),
      bools: new Set<string>(),
    };
    expect(() =>
      assertKnownFlags(args, [], ["check"], "homespun deploy"),
    ).toThrow("--check takes no value");
  });

  it("rejects a known BOOL that arrived as a dangling value flag", () => {
    // Trailing position of the same drift: parseArgs recorded the
    // mis-registered bool as dangling. Previously this passed silently
    // and bools.has() was false.
    const args = {
      positionals: [],
      flags: new Map<string, string>(),
      bools: new Set<string>(),
      danglingValueFlags: new Set(["check"]),
    };
    expect(() =>
      assertKnownFlags(args, [], ["check"], "homespun deploy"),
    ).toThrow("--check takes no value");
  });

  it("a correctly parsed bool still passes, and =value on a global bool is rejected", () => {
    const ok = {
      positionals: [],
      flags: new Map<string, string>(),
      bools: new Set(["check"]),
    };
    expect(() =>
      assertKnownFlags(ok, [], ["check"], "homespun deploy"),
    ).not.toThrow();
    // --json=x lands in flags (the = form always does); it used to pass
    // silently and be ignored. Now it is loud too.
    const eqForm = {
      positionals: [],
      flags: new Map([["json", "true"]]),
      bools: new Set<string>(),
    };
    expect(() => assertKnownFlags(eqForm, [], [], "app example")).toThrow(
      "--json takes no value",
    );
  });

  it("prioritises unknown-flag reports over dangling known-flag reports", () => {
    // If the user has BOTH a typo'd flag AND forgot a value on a known
    // one, lead with the typo — that's the more common case and the
    // user-visible foot-gun #224 was filed against.
    const args = {
      positionals: [],
      flags: new Map<string, string>(),
      bools: new Set<string>(),
      danglingValueFlags: new Set(["title", "bogus"]),
    };
    expect(() =>
      assertKnownFlags(args, ["title"], [], "homespun create"),
    ).toThrow("unknown flag(s): --bogus");
  });
});

function catchArgvError(fn: () => void): ArgvError {
  try {
    fn();
  } catch (e) {
    if (e instanceof ArgvError) return e;
    throw e;
  }
  throw new Error("expected an ArgvError, none thrown");
}
