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
// ONE SOCKET FOR EVERY OWNED APP. Both halves of this command are owner-scoped: a
// claim with no `--app` drains every app the identity owns, and the wake socket
// (`/v1/agent-tasks/stream`) is subscribed to a per-owner channel, so `--app` is a
// filter over both and never a decision about transport. Worth stating because the
// first version was not like this: the hint rode the app's own feed socket, so `--app`
// silently doubled as "which app's socket carries my wakes" and a worker that gained a
// second app quietly stopped being pushed to.
//
// WHY THIS FILE CONTAINS RECONNECT LOGIC AT ALL, when `apps watch` does not: nothing
// in this CLI has it. `apps watch` falls back to HTTP long-polling permanently on any
// pre-connect WS failure, never retries, handles SIGINT but not SIGTERM, and parks on
// `await new Promise(() => {})`. That is fine for a person watching a terminal and
// wrong for a process meant to run under a supervisor for weeks: it would silently
// degrade to a slower path and nothing would say so. So this reconnects with capped
// backoff, says so on stderr when it does, and exits cleanly on SIGTERM.

import { spawn } from "node:child_process";
import { openWorkerStream, type WorkerStreamHandle } from "@homespunapps/core";
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

export interface WorkOptions {
  appIds: string[];
  exec: string;
  maxConcurrent: number;
  once: boolean;
  pollSeconds: number;
}

/**
 * A bounded pool of running children, which is what makes `--max-concurrent` true.
 *
 * IT WAS NOT TRUE BEFORE. The flag sized the claim batch and nothing else: the batch
 * then ran in a plain `for` loop with an `await` per task, so `--max-concurrent 4`
 * claimed four tasks and ran them one after another. That is not a naming quibble, it
 * manufactures duplicate work. Each of those four is LEASED from the moment it is
 * claimed, the default lease is 120 s (`AGENT_TASKS_LEASE_SECONDS`), and a `claude -p`
 * call takes tens of seconds, so the third and fourth leases could lapse before those
 * tasks were started. A lapsed lease returns the task to the queue, so it gets handed
 * out again and done twice, while the first worker is still holding a child for it.
 *
 * The pool also gives `capacity()`, which is the number the next claim should ask for.
 * Claiming a full batch every pass regardless of what is already running is the same
 * bug in a slower form.
 */
interface Pool {
  /** Start `task`, waiting for a free slot first. Resolves once it has STARTED. */
  admit(task: Envelope): Promise<void>;
  /** Free slots against the cap: what a claim should ask for, and never below zero. */
  capacity(): number;
  /** Wait for every running child to finish. */
  drain(): Promise<void>;
}

function createPool(
  limit: number,
  run: (task: Envelope) => Promise<void>,
  onSlotFree: () => void,
): Pool {
  const running = new Set<Promise<void>>();

  return {
    async admit(task) {
      // `Promise.race` on the live set, so this wakes on the FIRST finisher rather
      // than the oldest. Racing the oldest would idle a free slot behind a long task.
      while (running.size >= limit) await Promise.race(running);
      const p = (async () => {
        try {
          await run(task);
        } catch (err) {
          // `runTask` is written not to throw, and if that ever stops being true the
          // failure must not escape into the pool: an unhandled rejection here would
          // abandon every sibling child mid-flight for the sake of one task.
          warn(
            `worker crashed on ${task.task_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      })();
      const settled = p.finally(() => {
        running.delete(settled);
        // A freed slot is a reason to claim again NOW rather than at the end of the
        // poll interval. Without this the pool would idle out the rest of a 15 s sleep
        // with nothing running, which is slower than the sequential version it replaces.
        onSlotFree();
      });
      running.add(settled);
    },
    capacity() {
      return Math.max(0, limit - running.size);
    },
    async drain() {
      while (running.size > 0) await Promise.race(running);
    },
  };
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

  // A finished child shortens the current sleep through the SAME `wake` the socket
  // uses, because "there is capacity now" and "there is work now" both mean claim
  // again, and one mechanism for both is one thing to keep correct.
  const pool = createPool(
    opts.maxConcurrent,
    (task) => runTask(base, cfg.apiKey, task, opts.exec),
    () => wake?.(),
  );

  // ONE BUDGET, SHARED BETWEEN PUSH AND POLL. The socket owns the credit accounting;
  // this loop subtracts what it has promised. Capacity offered to the relay is capacity
  // already spoken for, and a poll that claimed it as well would leave a worker told to
  // run one task at a time holding two leases and starting one. That is the bug #1608
  // fixed, arriving through a different door.
  const socket = opts.once
    ? null
    : openWakeSocket(
        opts,
        cfg.apiKey,
        base,
        () => wake?.(),
        () => pool.capacity(),
        (task) => {
          // Not awaited: this is a socket callback, and blocking it on a free slot would
          // stall every other frame on the connection. The relay respected the credit, so
          // a slot exists; `admit` waits only if it somehow did not.
          void pool.admit(task);
        },
      );

  try {
    for (;;) {
      // Restate the offer every pass. See `reoffer`: it is the drift repair, not a
      // belt-and-braces resend.
      const promised = socket?.reoffer() ?? 0;

      // Ask for what can actually be STARTED and is not already promised away. Claiming
      // four while three children are running leases work that waits out its own lease
      // before anything begins on it.
      const want = Math.max(0, pool.capacity() - promised);
      const claimed = want > 0 ? await claim(base, cfg.apiKey, opts, want) : [];
      for (const task of claimed) {
        if (stopping) break;
        // Awaited, and only for a free SLOT: `admit` returns as soon as the child is
        // spawned, so a batch larger than the cap is fed through rather than run in
        // lockstep.
        await pool.admit(task);
      }
      if (opts.once || stopping) break;
      // Sleep, interruptible by the wake frame OR by a child finishing. `wake` is
      // re-armed each pass so a frame that arrives WHILE tasks are running does not
      // resolve a stale promise and get lost; the next sleep is what it shortens.
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
    // Wait for the children BEFORE closing the socket and dropping the handlers.
    // Under `--once` this is what makes the command mean "drain a pass", and on
    // SIGTERM it is the difference between finishing the work in flight and stranding
    // every lease it holds until expiry.
    await pool.drain();
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
  max: number,
): Promise<Envelope[]> {
  // `max` is the pool's free capacity, NOT `--max-concurrent`. The two are the same
  // only on an idle worker, and asking for the flag's value while children are running
  // is what leased work that could not be started.
  const body: Record<string, unknown> = { max };
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
    // The envelope write races the child's exit, and losing that race used to
    // kill the WORKER, not the task.
    //
    // A broken pipe surfaces on the STREAM, and an unhandled stream "error"
    // event is fatal to the process. `child.on("error")` above does not cover
    // it: that fires for a failed SPAWN, which with `shell: true` almost never
    // happens because the shell itself starts fine. So a child that exits
    // before reading stdin (a typo in `--exec`, where the shell prints
    // "not found" and exits 127; or any script that simply does not read)
    // raised an uncaught EPIPE and took down every other task the worker held.
    //
    // Measured 2026-08-09: it is the race, not the payload. A 500-byte write to
    // a child running `exit 0` crashed a Node 24 process every time, and an
    // agent-task envelope is comfortably larger than that. It reached CI as an
    // intermittent "write EPIPE" in this file's own tests (issue #1616) while
    // every assertion passed, which is why it read as flake rather than as the
    // bug it is.
    //
    // Swallowed rather than reported, because it is a SYMPTOM and the real
    // outcome is already on its way: the child's exit code and stderr arrive on
    // "close" and decide ack versus nack. Reporting here as well would nack
    // twice for one failure. This mirrors `report`'s own rule a few lines
    // below, that one task's trouble must never cost the worker the others.
    child.stdin.on("error", () => {});
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
 * ONE SOCKET, EVERY APP THIS IDENTITY OWNS. It connects to `/v1/agent-tasks/stream`
 * on the API host, which the relay serves off a per-OWNER channel, so a worker
 * draining a hundred apps holds one socket rather than a hundred.
 *
 * That removes two things this function used to need and got wrong. It no longer
 * refuses to run unless `--app` names exactly one app, so `--app` is now purely a
 * claim filter and nothing about the transport. And it no longer asks the relay where
 * an app lives: the old wake frame was published on the app's own `/_hs/ws`, on a
 * different origin entirely, and reconstructing that URL is what left the socket
 * permanently unable to connect while reporting a transient-looking outage.
 *
 * Reconnects with capped exponential backoff and says so, once, per outage. It never
 * escalates to an exit: losing the socket makes this slower, not broken, and a
 * worker that killed itself over a lost optimisation would be worse than one that
 * kept polling.
 */
/**
 * Exported for testing. This function is the one part of `work` that had NO test and
 * shipped broken twice over (a URL built from the app id rather than its real
 * location, and a swallowed connect error), so it is worth being able to point a test
 * straight at it rather than only at the command that calls it.
 *
 * No longer async, and that is the visible sign of what changed: it used to have to
 * ASK the relay where an app lived before it could build a URL. The worker stream is
 * on the API host this CLI is already configured for, so there is nothing to look up.
 */
export interface WakeSocket {
  close(): void;
  /**
   * Restate this worker's free capacity as credit, and return what is now outstanding.
   *
   * Called on every poll pass as well as on connect, and UNCONDITIONALLY rather than only
   * when the number changed. That is the drift repair: if an assign frame was lost the
   * relay spent a credit this worker never saw, so its count is lower than ours and one
   * slot would sit idle indefinitely. `ready` is absolute, so restating it closes the gap,
   * and because the relay compares against its OWN value the restatement reads as a rise
   * and triggers a dispatch for whatever was stranded.
   */
  reoffer(): number;
}

export function openWakeSocket(
  opts: WorkOptions,
  apiKey: string,
  base: string,
  onWake: () => void,
  capacity: () => number,
  onAssign?: (task: Envelope) => void,
): WakeSocket {
  // `--app` filters the wake as well as the claim. A wake for an app this worker was
  // told to ignore would otherwise cut the sleep short to run a claim that can only
  // come back empty, which is a wasted round trip on every OTHER app's traffic. An
  // empty filter means every app, matching the claim.
  const wanted = new Set(opts.appIds);
  const wants = (appId: string): boolean =>
    wanted.size === 0 || wanted.has(appId);

  let closed = false;
  let connectedOnce = false;
  let delay = RECONNECT_MIN_MS;
  let handle: WorkerStreamHandle | null = null;
  let announcedOutage = false;
  /** Does THIS relay push? Answered in its hello, never guessed. */
  let pushes = false;
  /**
   * Restate free capacity as credit and return what is now outstanding.
   *
   * NOTHING IS TRACKED HERE, and two surviving mutations are what established that it
   * should not be. Earlier versions decremented a running total on each assign and zeroed
   * it on disconnect, and both lines could be deleted with every test still green. They
   * were unobservable rather than untested: `capacity()` already excludes a child that a
   * pushed task started, because `admit` occupies its slot before returning, so the
   * recomputation below is always the same number the bookkeeping was maintaining. Code
   * that looks load-bearing and is not is worse than no code, because the next person to
   * chase a credit bug will trust it.
   */
  const offer = (): number => {
    if (closed || !pushes || !handle) return 0;
    const want = Math.max(0, capacity());
    return handle.sendReady(want) ? want : 0;
  };

  const connect = (): void => {
    if (closed) return;
    handle = openWorkerStream(
      { baseUrl: base, apiKey },
      {
        onHello: ({ push }) => {
          // A successful connect resets the backoff, so a flapping link does not
          // inherit the previous outage's delay.
          connectedOnce = true;
          delay = RECONNECT_MIN_MS;
          pushes = push;
          if (announcedOutage) {
            warn("wake socket reconnected");
            announcedOutage = false;
          }
          // OFFER IMMEDIATELY, not at the next poll pass. A worker with a long
          // `--poll-interval` would otherwise offer nothing until the interval elapsed,
          // so a relay ready to push had no credit to push against and the whole feature
          // waited out a timer that push exists to avoid.
          offer();
        },
        onAgentTaskAvailable: ({ appId }) => {
          if (wants(appId)) onWake();
        },
        onAssign: (task) => {
          // A pushed task is already LEASED, so ignoring one costs a whole lease. It is
          // still filtered by `--app`, but a task outside the filter is a relay bug
          // rather than something to run quietly: the claim scope and the push scope are
          // the same scope.
          if (!wants(task.app_id)) {
            warn(
              `relay pushed a task for ${task.app_id}, which --app excludes; ignoring`,
            );
            return;
          }
          onAssign?.(task as Envelope);
        },
        onClose: ({ code, reason }) =>
          scheduleReconnect(`closed ${code}${reason ? ": " + reason : ""}`),
        // The error is REPORTED, not swallowed. Discarding it is what made the
        // original URL bug take three guesses to find: every failure looked
        // identical from the outside.
        onError: (err) =>
          scheduleReconnect(err instanceof Error ? err.message : String(err)),
      },
    );
  };

  const scheduleReconnect = (why: string): void => {
    if (closed) return;
    // Credit dies with the connection. Anything the old socket was promised is gone, and
    // the caller must be free to claim that capacity itself while this reconnects.
    // `pushes` alone is enough: the next `offer` returns 0 while it is false, so the
    // caller reclaims that capacity for its own polling on the very next pass.
    pushes = false;
    if (!announcedOutage) {
      warn(
        (connectedOnce
          ? "wake socket lost; polling continues while it reconnects"
          : "wake socket could not connect; polling only until it does") +
          ` (${why})`,
      );
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
    reoffer: offer,
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
