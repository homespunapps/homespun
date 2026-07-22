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
  /** Fired on the terminal `_dormant` frame (the app went dormant). */
  onDormant?: () => void;
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
      case "_dormant":
        handlers.onDormant?.();
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

/** Derive an app's `/_hs/ws` URL from its `url` field (https -> wss). */
export function appWsUrlFromAppUrl(appUrl: string): string {
  const u = new URL(appUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/$/, "") + "/_hs/ws";
  u.search = "";
  return u.toString();
}
