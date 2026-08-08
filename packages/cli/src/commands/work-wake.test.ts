// Tests for `homespun work`'s WAKE SOCKET, the one part of the command that had no
// test and consequently shipped broken twice over.
//
// WHAT WENT WRONG, because it shapes every assertion here. The socket URL was
// reconstructed as `${base}/a/${appId}/`, which is wrong twice: an app is served
// under its SLUG, and on a usercontent deployment it is a different ORIGIN entirely.
// So the socket could never connect. And the connect error was discarded, so the
// failure surfaced as "wake socket lost; polling continues while it reconnects",
// which reads like a transient blip rather than a URL that can never work.
//
// So these tests assert two things a passing unit test of the surrounding command
// could not: that the client connects to the address THE RELAY NAMES rather than one
// it derived, and that a failure to connect is reported with its cause.
//
// The server here is a real HTTP + WebSocket server that mimics the relay's app
// socket: it answers `GET /v1/apps/:id` with a url on a DIFFERENT host and port from
// the API, which is the shape that caught the original bug, then speaks enough of the
// app-socket protocol to deliver a wake frame.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { openWakeSocket, type WorkOptions } from "./work.js";

let api: Server;
let apiPort = 0;
let appServer: Server;
let appPort = 0;
let wss: WebSocketServer;

/** Every path the WS server was asked to upgrade, so the URL can be asserted. */
let upgradePaths: string[] = [];
/** Subprotocols the client offered, so the credential transport can be asserted. */
let offeredProtocols: string[] = [];
let live: WsSocket[] = [];
/** What `GET /v1/apps/:id` reports as the app's url. */
let appUrl = "";
/** Status the api returns for the app lookup. */
let appLookupStatus = 200;

const warnings: string[] = [];

beforeEach(async () => {
  upgradePaths = [];
  offeredProtocols = [];
  live = [];
  appLookupStatus = 200;
  warnings.length = 0;

  // The APP server, on its own port: standing in for `<slug>.homespunapps.com` being
  // a different origin from the API. A client that reconstructs the URL from the API
  // base cannot reach this at all, which is precisely the bug.
  appServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  wss = new WebSocketServer({ noServer: true });
  appServer.on("upgrade", (req, socket, head) => {
    upgradePaths.push(req.url ?? "");
    const proto = String(req.headers["sec-websocket-protocol"] ?? "");
    offeredProtocols.push(proto);
    // Only the EXACT app-socket path upgrades. An exact match rather than a suffix
    // test on purpose: the relay serves this at the app root, and a suffix test would
    // accept `/anything/_hs/ws`, which is how the first version of this file managed
    // to "connect" to a URL it was supposed to prove was refused.
    if ((req.url ?? "") !== "/_hs/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      live.push(ws);
      ws.send(JSON.stringify({ type: "hello", app: { id: "app_1" } }));
      ws.on("message", (raw) => {
        // The client subscribes; answer with an empty batch so it settles.
        try {
          if (JSON.parse(String(raw)).type === "sub") {
            ws.send(JSON.stringify({ type: "batch", entries: [], cursor: 0 }));
          }
        } catch {
          /* ignore */
        }
      });
    });
  });
  await new Promise<void>((r) => appServer.listen(0, r));
  appPort = (appServer.address() as { port: number }).port;
  appUrl = `http://127.0.0.1:${appPort}/`;

  // The API server, on a DIFFERENT port.
  api = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/v1/apps/")) {
      res.statusCode = appLookupStatus;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(appLookupStatus === 200 ? { url: appUrl } : {}));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => api.listen(0, r));
  apiPort = (api.address() as { port: number }).port;
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
  await new Promise<void>((r) => appServer.close(() => r()));
  await new Promise<void>((r) => api.close(() => r()));
});

function opts(over: Partial<WorkOptions> = {}): WorkOptions {
  return {
    appIds: ["app_1"],
    exec: "true",
    maxConcurrent: 1,
    once: false,
    pollSeconds: 300,
    ...over,
  };
}

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("openWakeSocket: it connects where the RELAY says the app lives", () => {
  it("connects to the app's own origin, not one derived from the api base", async () => {
    // THE regression. The app is on a different port from the api, so a client that
    // builds `${base}/a/${appId}/` reaches the api server and never upgrades.
    const handle = await openWakeSocket(
      opts(),
      "hs_key",
      `http://127.0.0.1:${apiPort}`,
      () => {},
    );
    await settle();
    try {
      expect(handle, "expected a socket handle").not.toBeNull();
      expect(upgradePaths).toEqual(["/_hs/ws"]);
      expect(live).toHaveLength(1);
    } finally {
      handle?.close();
    }
  });

  it("carries the agent key as a subprotocol, not a header", async () => {
    // A WS handshake cannot set Authorization, so the key rides the subprotocol.
    const handle = await openWakeSocket(
      opts(),
      "hs_secret_key",
      `http://127.0.0.1:${apiPort}`,
      () => {},
    );
    await settle();
    try {
      expect(offeredProtocols.join(" ")).toContain("homespun.v1");
      expect(offeredProtocols.join(" ")).toContain(
        "homespun.agentkey.hs_secret_key",
      );
    } finally {
      handle?.close();
    }
  });

  it("delivers the wake frame to the caller's callback", async () => {
    // The whole point of the socket: the relay says there is work, the worker claims
    // now rather than at the next poll.
    let woken = 0;
    const handle = await openWakeSocket(
      opts(),
      "hs_key",
      `http://127.0.0.1:${apiPort}`,
      () => {
        woken += 1;
      },
    );
    await settle();
    try {
      expect(live).toHaveLength(1);
      live[0]!.send(JSON.stringify({ type: "agent-task.available" }));
      await settle(300);
      expect(woken).toBe(1);
    } finally {
      handle?.close();
    }
  });

  it("ignores frames that are not the wake hint", async () => {
    let woken = 0;
    const handle = await openWakeSocket(
      opts(),
      "hs_key",
      `http://127.0.0.1:${apiPort}`,
      () => {
        woken += 1;
      },
    );
    await settle();
    try {
      live[0]!.send(JSON.stringify({ type: "entry", entry: { seq: 1 } }));
      live[0]!.send(JSON.stringify({ type: "resync" }));
      await settle(300);
      expect(woken).toBe(0);
    } finally {
      handle?.close();
    }
  });
});

describe("openWakeSocket: when it cannot connect", () => {
  it("returns null and says why when the app cannot be resolved", async () => {
    // A worker that cannot find its app must keep polling, not die: the queue still
    // drains. But it has to SAY so, which is the half that was missing.
    appLookupStatus = 500;
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const handle = await openWakeSocket(
        opts(),
        "hs_key",
        `http://127.0.0.1:${apiPort}`,
        () => {},
      );
      expect(handle).toBeNull();
      const said = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(said).toMatch(/cannot resolve app/);
      expect(said).toMatch(/polling only/);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports the CAUSE when the socket is refused, not just that it dropped", async () => {
    // The original failure said "wake socket lost ... while it reconnects" for a URL
    // that could never work, which sent me looking for a network blip. A first-attempt
    // failure must be distinguishable from a later drop, and must name its reason.
    appUrl = `http://127.0.0.1:${appPort}/nope/`; // upgrades are refused here
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const handle = await openWakeSocket(
        opts(),
        "hs_key",
        `http://127.0.0.1:${apiPort}`,
        () => {},
      );
      await settle(700);
      const said = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(said).toMatch(/could not connect/);
      expect(said).not.toMatch(/wake socket lost/);
      // And the reason is in the message rather than discarded.
      expect(said).toMatch(/\(.+\)/);
      handle?.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("opens no socket at all when more than one app is in scope", async () => {
    // The frame is published per app, so a multi-app worker polls. Asserted so the
    // limitation stays deliberate rather than becoming a silent half-feature.
    const handle = await openWakeSocket(
      opts({ appIds: ["app_1", "app_2"] }),
      "hs_key",
      `http://127.0.0.1:${apiPort}`,
      () => {},
    );
    await settle();
    expect(handle).toBeNull();
    expect(upgradePaths).toEqual([]);
  });
});
