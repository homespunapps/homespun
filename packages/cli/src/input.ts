// Helpers for reading CLI inputs that may be either a file path or an inline
// literal (JSON, or raw text for an HTML template body), plus a shared
// resolver for flags that carry a caller-supplied secret.

import { readFileSync, statSync } from "node:fs";
import { fail, warn } from "./output.js";

/**
 * True if `value` names an existing file. Only a missing path (ENOENT) is
 * treated as "not a file" — any other fs error (EACCES, ELOOP, …) propagates
 * with a labeled message rather than being misreported as inline content.
 */
function isFilePath(value: string): boolean {
  try {
    return statSync(value).isFile();
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    const code =
      e && typeof e === "object" ? (e as { code?: string }).code : undefined;
    throw new Error(
      `cannot stat '${value}'${code ? ` (${code})` : ""}: ${
        e instanceof Error ? e.message : String(e)
      }`,
      { cause: e },
    );
  }
}

/**
 * Resolve a value that is either a file path or an inline JSON literal.
 * Returns the parsed JSON. Throws on parse failure.
 */
export function resolveJson(value: string, label: string): unknown {
  const raw = isFilePath(value) ? readFileSync(value, "utf8") : value;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${label}: not valid JSON (${e instanceof Error ? e.message : String(e)})`,
      { cause: e },
    );
  }
}

/**
 * Resolve raw text that is either a file path or an inline literal — no JSON
 * parsing. Used for an inline HTML template body.
 */
export function resolveText(value: string): string {
  return isFilePath(value) ? readFileSync(value, "utf8") : value;
}

/**
 * Drain process.stdin to a utf8 string and trim exactly one trailing
 * newline (or CRLF) — the byte an `echo` or heredoc appends and which is
 * never part of the secret itself. The caller is responsible for gating on
 * `process.stdin.isTTY` first; in a TTY this blocks waiting for ^D.
 */
async function readStdinSecret(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.endsWith("\r\n")) return raw.slice(0, -2);
  if (raw.endsWith("\n")) return raw.slice(0, -1);
  return raw;
}

/**
 * Resolve a flag that carries a caller-supplied secret (a third-party
 * client secret, a static connection's header value, a webhook signing
 * secret, an agent API key) — anything an operator types in, as opposed to
 * a token the relay generates and hands back. A value on argv sits in shell
 * history and is readable by any other local user via `ps` or
 * /proc/<pid>/cmdline for the life of the process, so this offers two ways
 * around that, checked in order:
 *
 *   1. the flag given as exactly "-": read the value from stdin, refusing
 *      when stdin is a TTY so the command fails fast instead of hanging on
 *      ^D. Mirrors `feedback create --message -`.
 *   2. `envVar`, read only when the flag was not given at all.
 *
 * The flag's literal value keeps working (scripts that already pass it
 * verbatim must not break), but that path is the exposed one, so it prints
 * a stderr warning naming the two alternatives above. Mirrors the
 * `--secret` / `HOMESPUN_REGISTER_SECRET` fallback in `agent register`.
 *
 * `flagLabel` (e.g. "--client-secret") appears only in messages.
 */
export async function resolveSecretFlag(
  flagValue: string | undefined,
  envVar: string,
  flagLabel: string,
): Promise<string | undefined> {
  if (flagValue === "-") {
    if (process.stdin.isTTY) {
      fail(
        `'${flagLabel} -' expects the secret on stdin, but stdin is a TTY`,
        "invalid_args",
      );
    }
    return readStdinSecret();
  }
  if (flagValue !== undefined) {
    warn(
      `${flagLabel} was passed on the command line: it is visible in your shell history and, while this command runs, to any other user on this machine via ps or /proc. Use '${flagLabel} -' to read it from stdin instead, or set ${envVar}.`,
    );
    return flagValue;
  }
  const env = process.env[envVar];
  return env !== undefined && env !== "" ? env : undefined;
}
