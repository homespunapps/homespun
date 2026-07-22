// The CLI version must always equal this package's published `package.json`
// version, so `homespun --version` can never drift from what npm shipped
// (fix-anon-dx). version.ts reads package.json at runtime rather than
// hardcoding a literal, and this test locks the two together.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

describe("VERSION", () => {
  it("matches packages/cli/package.json version exactly", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(resolve(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("is a semantic version string, not the stale 0.0.29 literal", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(VERSION).not.toBe("0.0.29");
  });
});
