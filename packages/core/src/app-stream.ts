// WebSocket client for the v2 app change-feed endpoint, `GET /_hs/ws` on
// the app's OWN usercontent origin (spec-serving §5, spec-cli §5) — NOT the
// main relay domain. An agent/CLI watcher authenticates via a second
// `Sec-WebSocket-Protocol` subprotocol token carrying its API key:
//
//   Sec-WebSocket-Protocol: homespun.v1, homespun.agentkey.<agent-api-key>
//
// Frame protocol (relay's ws/app-handler.ts):
//   server -> client  {"type":"hello", seq, app:{...}, session:{...}, auth:{...}}
//   client -> server  {"type":"sub", "since":<seq>}
//   server -> client  {"type":"batch","entries":[...],"cursor":<seq>,"truncated":bool}
//   server -> client  {"type":"entry","entry":{...}}            (live push)
//   server -> client  {"type":"resync"}                          (since below retention floor)
//   server -> client  {"type":"_dormant"}                        (terminal — app went dormant)
//   server -> client  {"type":"_suspended"}                      (terminal: operator takedown, #1041)
//   server -> client  {"type":"error","error":{...}}
//
// `openAppStream` sends the initial `sub` itself (from `opts.since`) and
// automatically re-subscribes with the batch's own cursor whenever a batch
// comes back `truncated:true`, so the caller only ever sees a clean stream of
// individual `AppFeedEntry` objects via `onEntry` — identical in shape to
// what `HomespunClient#getAppFeed`'s long-poll fallback returns, which is what
// lets `homespun apps watch` print the exact same JSON line regardless of
// transport (spec-cli §3.4/§5).

import { WebSocket } from "ws";
import type { AppFeedEntry } from "./client.js";

export interface OpenAppStreamOptions {
  /**
   * The app's OWN WebSocket origin + path, e.g.
   * `wss://grocery-x7k2m9.homespunapps.com/_hs/ws` — derived from the
   * `url` a deploy/show response returns (swap https->wss, append `_hs/ws`).
   */
  wsUrl: string;
  /** Agent API key, carried via the `homespun.agentkey.<key>` subprotocol token. */
  apiKey: string;
  /** Resume cursor — replay only feed entries with seq > since. */
  since?: number;
}

export interface AppStreamHandlers {
  /** Fired once on connect with the app's hello metadata. */
  onHello?: (hello: {
    seq: number;
    app: {
      slug: string;
      name: string;
      description: string | null;
      icon: string | null;
      visibility: string;
      collections: Array<{ name: string; appendOnly: boolean }>;
    };
    session: { kind: "owner" | "member" | "anonymous"; humanId: string | null };
  }) => void;
  /** Fired for every feed entry — replayed (via batch) or live. */
  onEntry?: (entry: AppFeedEntry) => void;
  /** Fired once the initial catch-up (from `opts.since`) is fully drained. */
  onCaughtUp?: () => void;
  /** Fired on a `resync` frame — the caller should full-resync each collection. */
  onResync?: () => void;
  /**
   * A task was queued for this app: claim now rather than waiting out the poll
   * interval. A HINT ONLY, carrying nothing, so a consumer that never receives one
   * (no socket, dropped frame, older relay) must still poll and lose nothing but
   * time. Only agent-key sockets receive it.
   */
  onAgentTaskAvailable?: () => void;
  /** Fired on the terminal `_dormant` frame (the app went dormant). */
  onDormant?: () => void;
  /** Fired on the terminal `_suspended` frame (an operator suspended the
   *  app, issue #1041). Distinct from `onDormant`: there is no self-service
   *  recovery here, only an operator can unsuspend. */
  onSuspended?: () => void;
  /** Fired on a relay-side error frame. */
  onRelayError?: (error: {
    code?: string;
    message?: string;
    details?: unknown;
  }) => void;
  /** Fired when the socket closes (cleanly or otherwise). */
  onClose?: (info: { code: number; reason: string }) => void;
  /** Fired on a transport-level error (incl. a rejected upgrade). */
  onError?: (err: Error) => void;
}

export interface AppStreamHandle {
  close(): void;
  readonly socket: WebSocket;
}

/**
 * Open a WebSocket to an app's `/_hs/ws` endpoint as an agent. Drives the
 * `sub`/`batch` catch-up loop internally (re-subscribing while
 * `truncated:true`) so callers only handle individual entries.
 */
export function openAppStream(
  opts: OpenAppStreamOptions,
  handlers: AppStreamHandlers,
): AppStreamHandle {
  const socket = new WebSocket(opts.wsUrl, [
    "homespun.v1",
    `homespun.agentkey.${opts.apiKey}`,
  ]);
  let lastSeen = opts.since ?? 0;

  const sendSub = (since: number): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "sub", since }));
  };

  socket.on("open", () => {
    sendSub(lastSeen);
  });

  socket.on("message", (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      handlers.onError?.(
        new Error(
          `failed to parse app stream frame as JSON: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
      return;
    }
    if (!msg || typeof msg !== "object") {
      handlers.onError?.(new Error("unexpected non-object app stream frame"));
      return;
    }
    const obj = msg as Record<string, unknown>;
    switch (obj["type"]) {
      case "hello":
        handlers.onHello?.(
          obj as unknown as Parameters<
            NonNullable<AppStreamHandlers["onHello"]>
          >[0],
        );
        return;
      case "batch": {
        const entries = (obj["entries"] as AppFeedEntry[] | undefined) ?? [];
        for (const entry of entries) {
          if (entry.seq <= lastSeen) continue;
          lastSeen = entry.seq;
          handlers.onEntry?.(entry);
        }
        const cursor = obj["cursor"] as number | undefined;
        if (cursor !== undefined) lastSeen = Math.max(lastSeen, cursor);
        if (obj["truncated"] === true) {
          // More history remains — immediately re-subscribe from the new
          // cursor to drain the rest of the backlog.
          sendSub(lastSeen);
        } else {
          handlers.onCaughtUp?.();
        }
        return;
      }
      case "entry": {
        const entry = obj["entry"] as AppFeedEntry;
        if (entry.seq <= lastSeen) return;
        lastSeen = entry.seq;
        handlers.onEntry?.(entry);
        return;
      }
      case "resync":
        handlers.onResync?.();
        return;
      case "agent-task.available":
        handlers.onAgentTaskAvailable?.();
        return;
      case "_dormant":
        handlers.onDormant?.();
        return;
      case "_suspended":
        handlers.onSuspended?.();
        return;
      case "error":
        handlers.onRelayError?.(
          obj["error"] as {
            code?: string;
            message?: string;
            details?: unknown;
          },
        );
        return;
      default:
        handlers.onError?.(
          new Error(
            `unrecognized app stream frame type '${String(obj["type"])}'`,
          ),
        );
    }
  });

  socket.on("close", (code, reason) => {
    handlers.onClose?.({ code, reason: reason.toString() });
  });

  socket.on("error", (err) => {
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    close() {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
    get socket() {
      return socket;
    },
  };
}

// ---------------------------------------------------------------------------
// The WORKER stream: `/v1/agent-tasks/stream` on the MAIN relay domain
// ---------------------------------------------------------------------------
//
// A sibling of `openAppStream` rather than a mode of it, and the duplication is
// deliberate. `openAppStream` exists to drive the app feed's `sub`/`batch`/`entry`
// catch-up loop, which this socket does not speak at all: there is no cursor, no
// replay and no history, because a wake is only ever about work that exists NOW. A
// worker that reconnects should CLAIM, not catch up. Threading a "no really, skip all
// of that" flag through the feed client would make both harder to read and would leave
// the resume machinery one bug away from replaying wakes for tasks already done.
//
// It also lives on a DIFFERENT origin. The app feed is served from the app's own
// usercontent host; this is on the API host the CLI is already configured for, which
// is what removes the app-URL lookup the per-app wake socket needed (and got wrong).

export interface OpenWorkerStreamOptions {
  /**
   * The relay's API base, e.g. `https://app.homespun.dev` — NOT an app origin, and
   * NOT a WebSocket URL. The path is appended here so a caller cannot get it wrong,
   * which the per-app version demonstrated was worth taking out of their hands.
   */
  baseUrl: string;
  /** Agent API key, carried via the `homespun.agentkey.<key>` subprotocol token. */
  apiKey: string;
}

export interface WorkerStreamHandlers {
  /**
   * Fired once on connect.
   *
   * `push` is the relay telling the worker whether offering credit will achieve
   * anything. A worker that promised its capacity to a relay with push switched off
   * would hold that capacity back from its own polling and starve waiting for frames
   * that are never coming, so this is answered rather than inferred. An older relay
   * omits it, and `false` is the safe reading: poll.
   */
  onHello?: (info: { push: boolean }) => void;
  /**
   * A task was queued for one of this owner's apps. `appId` is present so a worker
   * can narrow its claim, and is the ONLY thing the frame carries: no task id, no
   * prompt, no row data. A consumer that never receives one (no socket, dropped
   * frame, older relay) must still poll and lose nothing but time.
   */
  onAgentTaskAvailable?: (info: { appId: string }) => void;
  /**
   * A task has been ASSIGNED to this worker: leased, with the whole envelope.
   *
   * Unlike the hint above, this is work in hand. The lease is already running, so a
   * consumer that ignores the frame holds a task nobody is doing until the lease lapses.
   * The envelope is the same shape the claim route returns, deliberately, so a consumer
   * can hand it to the same executor either way.
   */
  onAssign?: (envelope: WorkerTaskEnvelope) => void;
  /** Fired when the socket closes (cleanly or otherwise). */
  onClose?: (info: { code: number; reason: string }) => void;
  /** Fired on a transport-level error, including a rejected upgrade. */
  onError?: (err: Error) => void;
}

/**
 * One assigned task, as the relay sends it.
 *
 * Kept OPEN (`[k: string]: unknown`) on purpose. This client does not interpret the
 * envelope, it forwards it, and a closed type here would silently drop any field the
 * relay adds later: a consumer piping the whole object to a child process would start
 * handing over a truncated version of it after a relay upgrade. Only the fields this
 * layer actually reasons about are named.
 */
export interface WorkerTaskEnvelope {
  task_id: string;
  app_id: string;
  app_slug: string;
  task_type: string;
  [k: string]: unknown;
}

/** A live worker stream, with the client-to-server half of the protocol. */
export interface WorkerStreamHandle extends AppStreamHandle {
  /**
   * Declare how many tasks this worker will accept, right now.
   *
   * ABSOLUTE, not an increment: the relay replaces whatever it held. Send it again after
   * each task finishes to top back up. The worker has to drive this, because an ack goes
   * over HTTP to whichever replica answers and that is usually not the one holding this
   * socket, so the relay cannot see a task finish.
   *
   * Returns false if the socket was not open, so a caller can tell the difference
   * between "declared" and "shouted into a closed pipe".
   */
  sendReady(credits: number): boolean;
}

/** Derive the worker stream's WebSocket URL from an API base (https -> wss). */
export function workerWsUrlFromBase(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/v1/agent-tasks/stream";
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * Open the worker stream: one socket, wakes for every app this key's owner has.
 *
 * Does not reconnect. That is the caller's job, because only the caller knows whether
 * an outage is worth announcing and the CLI already has the backoff-with-one-warning
 * behaviour this would otherwise duplicate.
 */
export function openWorkerStream(
  opts: OpenWorkerStreamOptions,
  handlers: WorkerStreamHandlers,
): WorkerStreamHandle {
  const socket = new WebSocket(workerWsUrlFromBase(opts.baseUrl), [
    "homespun.v1",
    `homespun.agentkey.${opts.apiKey}`,
  ]);

  socket.on("message", (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      handlers.onError?.(
        new Error(
          `failed to parse worker stream frame as JSON: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      );
      return;
    }
    if (!msg || typeof msg !== "object") {
      handlers.onError?.(
        new Error("unexpected non-object worker stream frame"),
      );
      return;
    }
    const obj = msg as Record<string, unknown>;
    switch (obj["type"]) {
      case "hello":
        handlers.onHello?.({ push: obj["push"] === true });
        return;
      case "agent-task.available": {
        const appId = obj["app_id"];
        // A wake with no app id is not passed on as a wake for app "". The worker
        // would claim with an empty filter and either drain apps it was told not to
        // or claim nothing at all, and both are worse than reporting a bad frame.
        if (typeof appId !== "string" || appId === "") {
          handlers.onError?.(
            new Error("worker stream wake frame carried no app_id"),
          );
          return;
        }
        handlers.onAgentTaskAvailable?.({ appId });
        return;
      }
      case "agent-task.assign": {
        // Validated harder than the hint, because this frame is WORK rather than a
        // suggestion. A leased task the consumer cannot identify is a task nobody will
        // ack, and it stays out of circulation for a whole lease before anyone notices.
        const taskId = obj["task_id"];
        if (typeof taskId !== "string" || taskId === "") {
          handlers.onError?.(
            new Error("worker stream assign frame carried no task_id"),
          );
          return;
        }
        // `type` is stripped: it is this protocol's envelope tag, not part of the task,
        // and leaving it in would put a field in a consumer's stdin that the claim route
        // never sends. The two paths must hand over the same object.
        const envelope: Record<string, unknown> = { ...obj };
        delete envelope["type"];
        handlers.onAssign?.(envelope as unknown as WorkerTaskEnvelope);
        return;
      }
      default:
        // Tolerated, not an error. A newer relay may add a frame type, and a worker
        // that treated one as a fault would report an outage every time the relay
        // gained a feature. Unknown frames are simply not wakes.
        return;
    }
  });

  socket.on("close", (code, reason) => {
    handlers.onClose?.({ code, reason: reason.toString() });
  });

  socket.on("error", (err) => {
    handlers.onError?.(err instanceof Error ? err : new Error(String(err)));
  });

  return {
    close() {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    },
    sendReady(credits: number): boolean {
      if (socket.readyState !== WebSocket.OPEN) return false;
      try {
        socket.send(JSON.stringify({ type: "ready", credits }));
        return true;
      } catch {
        return false;
      }
    },
    get socket() {
      return socket;
    },
  };
}

/** Derive an app's `/_hs/ws` URL from its `url` field (https -> wss). */
export function appWsUrlFromAppUrl(appUrl: string): string {
  const u = new URL(appUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/_hs/ws";
  u.search = "";
  return u.toString();
}
