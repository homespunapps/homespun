#!/usr/bin/env node
// Process entry point for the `homespun-mcp` binary (see package.json's
// `bin` field). Kept separate from index.ts, which is a pure module with no
// top-level side effects, so index.ts can be imported by a test (or by
// anything else) without starting a stdio server.
//
// npm installs a bin as a symlink (node_modules/.bin/homespun-mcp -> this
// file), so an entry point cannot tell "am I the main module" apart from
// "was I imported" by comparing process.argv[1] to import.meta.url: under a
// symlink those two disagree (one is the link path, the other is the
// resolved real path) and a guard built on that comparison silently never
// runs main(). Unconditionally calling main() here, in a file whose only
// job is to be the entry point, sidesteps the question entirely.

import { main } from "./index.js";

main().catch((e) => {
  process.stderr.write(
    `homespun-mcp: fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
