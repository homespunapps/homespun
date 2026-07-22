// Single source of truth for the CLI version string.
//
// - `homespun --version` prints this verbatim.
// - Every HomespunClient construction passes it as `cliVersion`, which rides
//   as the `x-homespun-cli-version` header on every relay request, driving the
//   relay's version-skew check (HTTP 426 `cli_upgrade_required`).
//
// The value is read at runtime from THIS package's own `package.json`
// `version` field rather than hardcoded, so it can never drift from what npm
// published. Both the built `dist/version.js` and the source `src/version.ts`
// sit exactly one directory below the package root, so `../package.json`
// resolves the same in either location.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error(`homespun CLI: missing version in ${pkgPath}`);
  }
  return pkg.version;
}

export const VERSION = readVersion();
