// Guards the `--help` banner's "Tools exposed:" line against drift.
//
// It used to be a hardcoded list and quietly fell behind the real registry
// (15 of 25 tools listed, see #1659). Nothing else in the repo would catch
// that: tools.test.ts and server.test.ts pin the tool set at the MCP layer,
// but this banner is plain text assembled in index.ts, outside all of it.
// So: derive the line from TOOLS (done in index.ts) and assert here that
// every registered tool actually shows up in the rendered HELP text.

import { describe, it, expect } from "vitest";
import { HELP, wrapToolNames } from "./index.js";
import { TOOLS } from "./tools.js";

describe("--help banner: Tools exposed", () => {
  it("names every tool currently registered in TOOLS", () => {
    for (const t of TOOLS) {
      expect(HELP).toContain(t.name);
    }
  });

  it("names exactly as many tools as are registered, not more, not fewer", () => {
    const namesInBanner = HELP.match(/Tools exposed:[\s\S]*?\n\n/)?.[0] ?? "";
    // Count comma/period-terminated tokens rather than splitting on ", " so
    // wrapped newlines don't break the count.
    const mentioned = namesInBanner
      .replace("Tools exposed:", "")
      .split(/[,.]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    expect(mentioned.sort()).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("wraps a long name list onto multiple lines instead of one unreadable line", () => {
    const wrapped = wrapToolNames(
      TOOLS.map((t) => t.name),
      74,
    );
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(90);
    }
  });
});
