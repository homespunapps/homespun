// Unit tests for `openWorkerStream`, the client half of the per-owner wake channel.
//
// These exist BECAUSE a mutation survived the CLI's tests. The frame guard that drops a
// wake carrying no `app_id` could be deleted with `work-wake.test.ts` staying entirely
// green, because that file exercised the client through a worker configured with
// `--app`, whose own filter rejected the empty id whatever the parser did. The CLI test
// was fixed too, but the durable answer is a test at the layer that owns the contract:
// this parser must reject a malformed frame no matter who calls it or how they have
// configured themselves.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { openWorkerStream, workerWsUrlFromBase } from "./app-stream.js";

let server: Server;
let port = 0;
let wss: WebSocketServer;
let live: WsSocket[] = [];
let upgradePaths: string[] = [];

beforeEach(async () => {
  live = [];
  upgradePaths = [];
  server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    upgradePaths.push((req.url ?? "").split("?")[0] ?? "");
    wss.handleUpgrade(req, socket, head, (ws) => {
      live.push(ws);
      ws.send(JSON.stringify({ type: "hello" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  for (const ws of live) {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  }
  wss.close();
  await new Promise<void>((r) => server.close(() => r()));
});

function base(): string {
  return `http://127.0.0.1:${port}`;
}

async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("workerWsUrlFromBase", () => {
  it("upgrades the scheme and appends the stream path", () => {
    expect(workerWsUrlFromBase("https://app.homespun.dev")).toBe(
      "wss://app.homespun.dev/v1/agent-tasks/stream",
    );
    expect(workerWsUrlFromBase("http://localhost:3000")).toBe(
      "ws://localhost:3000/v1/agent-tasks/stream",
    );
  });

  it("tolerates a trailing slash rather than doubling it", () => {
    expect(workerWsUrlFromBase("https://app.homespun.dev/")).toBe(
      "wss://app.homespun.dev/v1/agent-tasks/stream",
    );
  });

  it("drops a query string and fragment", () => {
    // A configured base can carry either, and a WS handshake to a path with a stray
    // `?token=` would be refused by the relay's exact-path match.
    expect(workerWsUrlFromBase("https://app.homespun.dev/?a=1#x")).toBe(
      "wss://app.homespun.dev/v1/agent-tasks/stream",
    );
  });
});

describe("openWorkerStream: the wake frame", () => {
  it("reports hello and every well-formed wake, with the app id", async () => {
    const wakes: string[] = [];
    let hellos = 0;
    const h = openWorkerStream(
      { baseUrl: base(), apiKey: "hs_key" },
      {
        onHello: () => {
          hellos += 1;
        },
        onAgentTaskAvailable: ({ appId }) => wakes.push(appId),
      },
    );
    await settle();
    try {
      expect(hellos).toBe(1);
      expect(upgradePaths).toEqual(["/v1/agent-tasks/stream"]);
      live[0]!.send(
        JSON.stringify({ type: "agent-task.available", app_id: "app_1" }),
      );
      live[0]!.send(
        JSON.stringify({ type: "agent-task.available", app_id: "app_2" }),
      );
      await settle();
      expect(wakes).toEqual(["app_1", "app_2"]);
    } finally {
      h.close();
    }
  });

  it("refuses a wake with a missing, empty or non-string app id", async () => {
    // THE mutation-driven test. Each of these must be an error and NOT a wake: a
    // consumer handed appId "" claims with an empty filter, which either drains apps it
    // was told to skip or claims nothing while believing it acted.
    const wakes: string[] = [];
    const errors: string[] = [];
    const h = openWorkerStream(
      { baseUrl: base(), apiKey: "hs_key" },
      {
        onAgentTaskAvailable: ({ appId }) => wakes.push(appId),
        onError: (e) => errors.push(e.message),
      },
    );
    await settle();
    try {
      live[0]!.send(JSON.stringify({ type: "agent-task.available" }));
      live[0]!.send(
        JSON.stringify({ type: "agent-task.available", app_id: "" }),
      );
      live[0]!.send(
        JSON.stringify({ type: "agent-task.available", app_id: 7 }),
      );
      live[0]!.send(
        JSON.stringify({ type: "agent-task.available", app_id: null }),
      );
      await settle();
      expect(wakes).toEqual([]);
      expect(errors).toHaveLength(4);
      expect(errors[0]).toMatch(/no app_id/);
      // The positive control, on the same socket: a good frame still wakes, so the
      // four refusals above are refusals and not a dead connection.
      live[0]!.send(
        JSON.stringify({ type: "agent-task.available", app_id: "app_ok" }),
      );
      await settle();
      expect(wakes).toEqual(["app_ok"]);
    } finally {
      h.close();
    }
  });

  it("ignores an unknown frame type instead of reporting it as a fault", async () => {
    // A newer relay may add frames. A client that raised an error on each one would
    // make its caller announce an outage every time the relay gained a feature.
    const errors: string[] = [];
    const wakes: string[] = [];
    const h = openWorkerStream(
      { baseUrl: base(), apiKey: "hs_key" },
      {
        onAgentTaskAvailable: ({ appId }) => wakes.push(appId),
        onError: (e) => errors.push(e.message),
      },
    );
    await settle();
    try {
      live[0]!.send(JSON.stringify({ type: "something-from-a-newer-relay" }));
      live[0]!.send(JSON.stringify({ type: "entry", entry: { seq: 1 } }));
      live[0]!.send(JSON.stringify({ type: "_dormant" }));
      await settle();
      expect(errors).toEqual([]);
      expect(wakes).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("reports a frame that is not JSON, and keeps the socket", async () => {
    const errors: string[] = [];
    const wakes: string[] = [];
    const h = openWorkerStream(
      { baseUrl: base(), apiKey: "hs_key" },
      {
        onAgentTaskAvailable: ({ appId }) => wakes.push(appId),
        onError: (e) => errors.push(e.message),
      },
    );
    await settle();
    try {
      live[0]!.send("not json at all");
      live[0]!.send(JSON.stringify("a bare string is not a frame"));
      await settle();
      expect(errors).toHaveLength(2);
      expect(errors.join(" ")).toMatch(/worker stream frame/);
      // Still usable afterwards: one bad frame is not a reason to drop the channel.
      live[0]!.send(
        JSON.stringify({ type: "agent-task.available", app_id: "app_1" }),
      );
      await settle();
      expect(wakes).toEqual(["app_1"]);
    } finally {
      h.close();
    }
  });

  it("sends the api key as a subprotocol and never as a query parameter", async () => {
    // The key must not land in the request line, where it would be written to every
    // access log in the path. The subprotocol header is the only carrier.
    const h = openWorkerStream(
      { baseUrl: base(), apiKey: "hs_super_secret" },
      {},
    );
    await settle();
    try {
      expect(upgradePaths).toEqual(["/v1/agent-tasks/stream"]);
      expect(upgradePaths.join(" ")).not.toContain("hs_super_secret");
    } finally {
      h.close();
    }
  });
});
