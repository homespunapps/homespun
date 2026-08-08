// `homespun work` - the long-running worker that drains this identity's agent-task
// queue and hands each task to whatever agent its owner uses.
//
// THE ENVELOPE GOES TO A CHILD PROCESS ON STDIN, and that is the entire integration
// contract. No SDK, no library, no assumption that the consumer is Claude or that it
// can call tools: `--exec` names any command, and a shell script reading stdin is a
// first-class consumer. That is also how the harness-agnostic claim gets tested, by
// pointing `--exec` at a script rather than at a model.
//
// EXIT CODE IS THE ANSWER. Zero acks, non-zero nacks with the child's stderr as the
// report. Nothing is parsed out of stdout, deliberately: requiring a structured
// reply would mean every worker needs a wrapper that produces it, and the one thing
// every program on every platform already reports reliably is its exit status.
//
// POLLING IS THE FLOOR. The wake frame only shortens the wait, so this drains
// correctly with no socket at all. That is why the reconnect logic below is allowed
// to give up on the socket and keep working.
//
// WHY THIS FILE CONTAINS RECONNECT LOGIC AT ALL, when `apps watch` does not: nothing
// in this CLI has it. `apps watch` falls back to HTTP long-polling permanently on any
// pre-connect WS failure, never retries, handles SIGINT but not SIGTERM, and parks on
// `await new Promise(() => {})`. That is fine for a person watching a terminal and
// wrong for a process meant to run under a supervisor for weeks: it would silently
// degrade to a slower path and nothing would say so. So this reconnects with capped
// backoff, says so on stderr when it does, and exits cleanly on SIGTERM.

import { spawn } from "node:child_process";
import { openAppStream, appWsUrlFromAppUrl } from "@homespunapps/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { resolveConfig } from "../config.js";
import { fail, printJsonLine, warn } from "../output.js";

/** One task, as the relay hands it over. Kept loose: the CLI does not interpret it. */
interface Envelope {
  task_id: string;
  app_id: string;
  app_slug: string;
  task_type: string;
  [k: string]: unknown;
}

interface WorkOptions {
  appIds: string[];
  exec: string;
  maxConcurrent: number;
  once: boolean;
  pollSeconds: number;
}

/** Backoff bounds for the wake socket. Capped so a long outage does not spin. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export async function runWork(args: ParsedArgs): Promise<void> {
  if (
    args.flags.has("help") ||
    args.bools.has("help") ||
    args.positionals[0] === "help"
  ) {
    const spec = nounSpec("work");
    if (spec) process.stdout.write(renderNounHelp(spec));
    return;
  }
  // The catalogue entry IS the flag allowlist, so a flag documented in help and a
  // flag accepted here cannot drift apart.
  assertKnownFlags(args, ...specFor("work"));

  const exec = args.flags.get("exec");
  if (!exec) {
    fail(
      "work requires --exec <command>: the program each task envelope is piped to",
      "invalid_request",
    );
  }
  const opts: WorkOptions = {
    // Repeatable OR comma-separated, because both are things a person types.
    appIds: (args.flags.get("app") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    exec: exec!,
    maxConcurrent: positiveInt(args.flags.get("max-concurrent"), 1),
    once: args.bools.has("once") || args.flags.has("once"),
    pollSeconds: positiveInt(args.flags.get("poll-interval"), 15),
  };

  const cfg = resolveConfig(args);
  const base = cfg.url.replace(/\/$/, "");

  let stopping = false;
  /** Resolves early when the wake frame arrives, so a sleep can be interrupted. */
  let wake: (() => void) | null = null;

  const stop = (): void => {
    stopping = true;
    wake?.();
  };
  // BOTH signals. A supervisor sends SIGTERM, and a worker that only handles SIGINT
  // gets killed mid-task, which strands its lease until it expires.
  //
  // Removed again in the `finally` below. In production this runs once and process
  // exit would clean up anyway, but leaving them attached leaks a listener per call,
  // which surfaced as a MaxListenersExceededWarning once the test suite called this
  // fifteen times in one process. A warning that only appears under test is still a
  // handler this function attached and did not own up to.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const socket = opts.once
    ? null
    : openWakeSocket(opts, cfg.apiKey, base, () => wake?.());

  try {
    for (;;) {
      const claimed = await claim(base, cfg.apiKey, opts);
      for (const task of claimed) {
        await runTask(base, cfg.apiKey, task, opts.exec);
        if (stopping) break;
      }
      if (opts.once || stopping) break;
      // Sleep, interruptible by the wake frame. `wake` is re-armed each pass so a
      // frame that arrives WHILE tasks are running does not resolve a stale promise
      // and get lost; the next sleep is what it shortens.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, opts.pollSeconds * 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    socket?.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

/**
 * Claim a batch. A claim failure is NOT fatal outside `--once`: the relay may be
 * restarting or briefly unreachable, and a worker that exits on the first 503 is a
 * worker that needs a supervisor to do its retrying. Logged and retried on the next
 * pass instead.
 */
async function claim(
  base: string,
  apiKey: string,
  opts: WorkOptions,
): Promise<Envelope[]> {
  const body: Record<string, unknown> = { max: opts.maxConcurrent };
  if (opts.appIds.length > 0) body.app_ids = opts.appIds;
  try {
    const res = await fetch(`${base}/v1/agent-tasks/claim`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      if (opts.once) {
        fail(`claim failed (${res.status}): ${text}`, "claim_failed");
      }
      warn(`claim failed (${res.status}), retrying next pass: ${text}`);
      return [];
    }
    return ((await res.json()) as { tasks: Envelope[] }).tasks ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.once) fail(`claim failed: ${msg}`, "claim_failed");
    warn(`claim failed, retrying next pass: ${msg}`);
    return [];
  }
}

/**
 * Hand one task to the child and report the outcome.
 *
 * The whole envelope goes on stdin as one JSON line, including the credential, so a
 * worker needs no configuration of its own to write results back: everything it
 * needs to act is in the thing it was handed.
 */
async function runTask(
  base: string,
  apiKey: string,
  task: Envelope,
  exec: string,
): Promise<void> {
  const started = Date.now();
  const result = await runChild(exec, JSON.stringify(task));
  const seconds = Math.round((Date.now() - started) / 100) / 10;

  if (result.code === 0) {
    await report(base, apiKey, task.task_id, "ack", trim(result.stdout));
    printJsonLine({
      task: task.task_id,
      app: task.app_slug,
      type: task.task_type,
      status: "done",
      seconds,
    });
    return;
  }
  // Non-zero: nack, with the child's STDERR as the report. Stderr rather than stdout
  // because that is where a failing program explains itself, and the report is read
  // by a person working out why their task did not run.
  await report(
    base,
    apiKey,
    task.task_id,
    "nack",
    trim(result.stderr || result.stdout) ||
      `worker exited ${result.code ?? "on a signal"}`,
  );
  printJsonLine({
    task: task.task_id,
    app: task.app_slug,
    type: task.task_type,
    status: "failed",
    exit: result.code,
    seconds,
  });
}

function runChild(
  exec: string,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Through a shell, so `--exec "claude -p"` and `--exec ./parse.sh` both work the
    // way a person expects when they type them.
    const child = spawn(exec, { shell: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (err) => {
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Ack or nack. A REPORTING failure is logged and swallowed rather than thrown: the
 * work has already happened, and the lease will lapse and return the task to the
 * queue on its own, which is the correct recovery. Crashing the worker here would
 * lose every other task it holds for the sake of one it could not report on.
 */
async function report(
  base: string,
  apiKey: string,
  taskId: string,
  verb: "ack" | "nack",
  text: string,
): Promise<void> {
  try {
    const res = await fetch(`${base}/v1/agent-tasks/${taskId}/${verb}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(text ? { report: text } : {}),
    });
    if (!res.ok) {
      warn(`${verb} failed for ${taskId} (${res.status}); lease will lapse`);
    }
  } catch (err) {
    warn(
      `${verb} failed for ${taskId} (${
        err instanceof Error ? err.message : String(err)
      }); lease will lapse`,
    );
  }
}

/**
 * The wake socket, with real reconnect.
 *
 * ONE APP ONLY, and this is the honest limitation of the frame rather than of this
 * command: the hint is published on the app's own `/_hs/ws`, so a worker draining
 * five apps would need five sockets. Polling already drains every app correctly, so
 * the socket is opened only when `--app` names exactly one and is simply skipped
 * otherwise. A multi-app worker polls, which costs latency and nothing else.
 *
 * Reconnects with capped exponential backoff and says so, once, per outage. It never
 * escalates to an exit: losing the socket makes this slower, not broken, and a
 * worker that killed itself over a lost optimisation would be worse than one that
 * kept polling.
 */
function openWakeSocket(
  opts: WorkOptions,
  apiKey: string,
  base: string,
  onWake: () => void,
): { close: () => void } | null {
  if (opts.appIds.length !== 1) return null;
  const appId = opts.appIds[0]!;

  let closed = false;
  let delay = RECONNECT_MIN_MS;
  let handle: { close: () => void } | null = null;
  let announcedOutage = false;

  const connect = (): void => {
    if (closed) return;
    const wsUrl = appWsUrlFromAppUrl(`${base}/a/${appId}/`);
    handle = openAppStream(
      { wsUrl, apiKey, since: Number.MAX_SAFE_INTEGER },
      {
        onHello: () => {
          // A successful connect resets the backoff, so a flapping link does not
          // inherit the previous outage's delay.
          delay = RECONNECT_MIN_MS;
          if (announcedOutage) {
            warn("wake socket reconnected");
            announcedOutage = false;
          }
        },
        onAgentTaskAvailable: onWake,
        onClose: () => scheduleReconnect(),
        onError: () => scheduleReconnect(),
      },
    );
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    if (!announcedOutage) {
      warn("wake socket lost; polling continues while it reconnects");
      announcedOutage = true;
    }
    const wait = delay;
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    setTimeout(connect, wait).unref?.();
  };

  connect();
  return {
    close: () => {
      closed = true;
      handle?.close();
    },
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail(`expected a positive integer, got '${raw}'`, "invalid_request");
  }
  return n;
}

/** Cap the report at what the ack route accepts, keeping the TAIL of a long one:
 * the end of a stack trace says more about a failure than its beginning. */
function trim(s: string): string {
  const t = s.trim();
  return t.length > 3900 ? t.slice(-3900) : t;
}
