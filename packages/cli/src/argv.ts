// Tiny hand-rolled argv parser. No CLI framework.
//
// Supports:
//   --flag value      --flag=value      --bool      -h
// Everything that isn't a flag (or a flag's value) is a positional.

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string>;
  bools: Set<string>;
  /**
   * Value-flag names (`--name` form) that were seen with no following value
   * — either at end-of-argv or with another `--flag` next. The parser
   * deliberately does NOT classify these as known-vs-unknown; that's
   * assertKnownFlags's job. Splitting the two responsibilities means the
   * message is uniform regardless of whether the user wrote
   * `homespun config show --bogus` or `homespun config show --bogus something`:
   * an unknown flag is "unknown flag(s)" in both cases. A known flag
   * that's missing its value is the only path that apps as
   * "requires a value". See PR #227 follow-up note for the rationale.
   *
   * Optional so handwritten ParsedArgs literals (tests) don't need to set
   * it — assertKnownFlags treats undefined as empty.
   */
  danglingValueFlags?: Set<string>;
}

/**
 * Thrown for any argv-level user error: missing value, duplicate flag, or
 * (when a runner calls assertKnownFlags) an unknown flag. `hint` rides
 * alongside the message and ends up in the error envelope so callers see a
 * single line pointing them at the right --help.
 */
export class ArgvError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ArgvError";
    if (hint !== undefined) this.hint = hint;
  }
}

// Flags that never take a value. `json` is kept here purely for forward-compat
// (JSON is currently the only output mode): accepting `--json` as a no-op bool
// means a future `--text`/`--json` toggle won't break existing invocations. It
// is intentionally undocumented in --help.
//
// `version` is deliberately NOT here: the top-level `-v` / `--version` is
// handled from rawArgv[0] before parseArgs runs, so it never needs to be a
// boolean flag, and keeping it out leaves room for a future noun-level
// `--version <n>` value flag without a collision.
//
// Exported (and colocated with the parser rather than the bin entry) so tests
// exercise the REAL parse-time set. A per-test copy of this list is how
// `deploy --check` shipped un-parsed and ran a real deploy (#827): the flag
// was in the command's KNOWN_BOOLS and the test's copy, but not here, so
// parseArgs treated it as a value flag and `bools.has("check")` stayed false.
export const BOOLEAN_FLAGS = new Set([
  "json",
  "once",
  "help",
  "print-key",
  "yes",
  "plain",
  // `homespun deploy --force` / `homespun apps ... --force`: override a compat gate.
  "force",
  // `homespun deploy --check`: validate-only dry run, persists nothing (#827).
  "check",
  // `homespun agent register --no-device`: skip the browser device-authorization
  // flow and register directly (unowned agent), the pre-device-flow behavior.
  "no-device",
  // `homespun data ... import --emit-effects`: opt a silent bulk import back into
  // firing notify/webhooks (import defaults to silent).
  "emit-effects",
  // `homespun agent logout --all`: wipe every saved profile, not just the active one.
  "all",
  // `homespun members set-role --clear-role`: drop a custom role back to plain member.
  "clear-role",
]);

/**
 * Parse argv tokens. `booleanFlags` lists flags that never consume a value
 * (e.g. --json, --once, --help); everything else with a `--name` form
 * consumes the next token unless written as `--name=value`.
 *
 * Bails with ArgvError on the first duplicate (`--foo x --foo y` or
 * `--once --once`) so a typo'd repeat doesn't silently overwrite the first
 * value the way a plain `Map.set` would.
 *
 * Does NOT throw on a value-flag with no following value. Instead it
 * records the name in `danglingValueFlags` so `assertKnownFlags` can
 * produce the right message — "unknown flag(s)" for typos, "requires a
 * value" for genuine known-flag-missing-value cases. Without this split,
 * the message was non-uniform (a `--bogus` at end of argv said "requires
 * a value" while `--bogus something` said "unknown flag(s)" — same root
 * cause, two messages).
 */
export function parseArgs(
  tokens: string[],
  booleanFlags: Set<string>,
): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  const danglingValueFlags = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok === "-h" || tok === "--help") {
      bools.add("help");
      continue;
    }
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        const key = body.slice(0, eq);
        if (flags.has(key)) {
          throw new ArgvError(`duplicate flag: --${key}`);
        }
        flags.set(key, body.slice(eq + 1));
        continue;
      }
      if (booleanFlags.has(body)) {
        if (bools.has(body)) {
          throw new ArgvError(`duplicate flag: --${body}`);
        }
        bools.add(body);
        continue;
      }
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        // No value follows. Don't decide whether this is a typo or a
        // forgotten value — record it; assertKnownFlags resolves both
        // with one consistent message shape (see the field doc on
        // ParsedArgs).
        danglingValueFlags.add(body);
        continue;
      }
      if (flags.has(body)) {
        throw new ArgvError(`duplicate flag: --${body}`);
      }
      flags.set(body, next);
      i++;
      continue;
    }
    positionals.push(tok);
  }

  return { positionals, flags, bools, danglingValueFlags };
}

/**
 * Flags every command accepts. Kept here (not in each command's allow-list)
 * so adding a new global flag updates one place. `url` / `api-key` are the
 * relay-target overrides; `help` / `json` are universal display modes.
 */
const GLOBAL_FLAGS: readonly string[] = ["url", "api-key", "profile"];
const GLOBAL_BOOLS: readonly string[] = ["help", "json"];

/**
 * Reject anything the per-command allow-list (plus the globals above) does
 * not name. Run from each leaf runner before it starts pulling values out of
 * `args`. The thrown ArgvError carries a hint pointing at the verb's own
 * --help, so a user fixing a typo lands on the canonical list of flags.
 *
 * Why per-command and not at parse time: the parser stays single-pass and
 * generic, and each runner asserts only its own surface.
 *
 * This comment used to argue the allow-list must be co-located with the runner
 * so a new flag would not require a shared registry. That reasoning assumed
 * two consumers (the parser and the runner). There are now four: the runner,
 * `--help`, the published CLI reference on docs.homespun.dev, and this check.
 * Co-location bought nothing against the other three, and in practice the
 * inline lists, the help text, and the docs page had already drifted apart.
 * So the allow-list moved into help-catalog.ts, which every consumer reads via
 * specFor(). A new flag is still a one-line edit, it just lands in the table
 * instead of the runner, and the drift it used to cause is now impossible
 * rather than merely discouraged.
 *
 * Also resolves the parser's `danglingValueFlags`: an unknown name there
 * is reported alongside other unknowns ("unknown flag(s): --bogus"); a
 * known name there apps as "--name requires a value". This is what
 * keeps the error message uniform for a typo whether or not a value
 * follows it.
 */
export function assertKnownFlags(
  args: ParsedArgs,
  knownFlags: Iterable<string>,
  knownBools: Iterable<string>,
  helpCommand: string,
): void {
  const flagSet = new Set<string>([...GLOBAL_FLAGS, ...knownFlags]);
  const boolSet = new Set<string>([...GLOBAL_BOOLS, ...knownBools]);
  const dangling = args.danglingValueFlags ?? new Set<string>();

  const unknown: string[] = [];
  for (const k of args.flags.keys()) {
    if (!flagSet.has(k) && !boolSet.has(k)) unknown.push(`--${k}`);
  }
  for (const k of args.bools) {
    if (!boolSet.has(k) && !flagSet.has(k)) unknown.push(`--${k}`);
  }
  for (const k of dangling) {
    if (!flagSet.has(k) && !boolSet.has(k)) unknown.push(`--${k}`);
  }
  if (unknown.length > 0) {
    throw new ArgvError(
      `unknown flag(s): ${unknown.join(", ")}`,
      `run \`${helpCommand} --help\` for the supported flags`,
    );
  }

  // Defense against parse-time drift (#827): a flag the command declares
  // boolean must never arrive as a value flag. That happens only when the
  // name is missing from the parse-time BOOLEAN_FLAGS set, so parseArgs
  // consumed a value for it (`--check ./dir`, `--check=x`) or recorded it
  // as dangling (trailing `--check`). Before this check, that mismatch
  // passed silently, `bools.has()` stayed false, and `deploy --check` ran
  // a REAL deploy. Fail loudly instead: in tests and dev this surfaces the
  // missing BOOLEAN_FLAGS entry immediately, and no invocation can fall
  // through to the non-boolean code path.
  for (const k of args.flags.keys()) {
    if (boolSet.has(k) && !flagSet.has(k)) {
      throw new ArgvError(`--${k} takes no value`);
    }
  }
  for (const k of dangling) {
    if (boolSet.has(k) && !flagSet.has(k)) {
      throw new ArgvError(`--${k} takes no value`);
    }
  }

  // No unknowns — but a known value-flag may still have been left without
  // a value. Handle the first such case with the pre-existing message
  // shape ("--name requires a value"). Reporting only the first keeps the
  // message simple; the user fixes that flag, re-runs, sees the next one.
  for (const k of dangling) {
    if (flagSet.has(k)) {
      throw new ArgvError(`--${k} requires a value`);
    }
  }
}
