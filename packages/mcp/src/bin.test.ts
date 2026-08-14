// Proves the published binary actually runs when npm installs it.
//
// npm installs a package's `bin` entry as a SYMLINK
// (node_modules/.bin/homespun-mcp -> the real dist file). A unit test that
// imports index.ts/bin.ts directly never launches through that symlink, so
// it cannot see what only shows up when the process is started that way:
// `process.argv[1]` is the symlink path while `fileURLToPath(import.meta.url)`
// resolves to the real file, so any entry-point guard built on comparing the
// two is false under a symlink and silently never runs. An earlier version
// of bin.ts had exactly that guard; it built, typechecked, and passed every
// in-process test, then produced a no-op binary once installed.
//
// So this test does the one thing that reproduces the failure: build a real
// symlink to the built entry point, in a directory unrelated to dist/, and
// spawn it as a child process, the way npm's shim actually does.

import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const mcpRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = resolve(mcpRoot, "dist/bin.js");

function runNode(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolveP({ stdout, stderr, code }));
  });
}

// Skips cleanly (not a failure) when the workspace build hasn't produced
// dist/bin.js yet: this test spawns the REAL built entry point, the same
// file npm points `bin` at, not a ts-node/tsx shortcut. CI always builds
// first.
describe.skipIf(!existsSync(distEntry))(
  "homespun-mcp binary, launched through a symlink like npm installs it",
  () => {
    let tmpDir: string | undefined;

    afterAll(() => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });

    it("prints the --help banner and exits 0 when invoked via a symlink", async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "homespun-mcp-bin-test-"));
      const link = join(tmpDir, "homespun-mcp");
      symlinkSync(distEntry, link);

      const { stdout, stderr, code } = await runNode([link, "--help"]);

      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("Tools exposed:");
      expect(stdout).toContain("deploy_app");
      expect(stdout).toContain("get_skill");
    });
  },
);
