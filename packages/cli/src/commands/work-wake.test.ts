// Tests for `homespun work`'s WAKE SOCKET, the one part of the command that had no
// test and consequently shipped broken twice over.
//
// WHAT WENT WRONG, because it still shapes every assertion here. The socket URL was
// reconstructed as `${base}/a/${appId}/`, which is wrong twice: an app is served under
// its SLUG, and on a usercontent deployment it is a different ORIGIN entirely. So the
// socket could never connect. And the connect error was discarded, so the failure
// surfaced as "wake socket lost; polling continues while it reconnects", which reads
// like a transient blip rather than a URL that can never work.
//
// The socket now goes to `/v1/agent-tasks/stream` on the API host, off a per-OWNER
// channel, which removes the class of bug rather than the instance: there is no app
// origin to derive and nothing to look up. So the first regression test inverts. It no
// longer asks "did you connect where the relay SAID", it asserts the lookup does not
// happen at all, because a request to `/v1/apps/:id` here would mean the old
// reconstruct-an-origin shape had crept back.
//
// The second regression is unchanged and still earns its place: a socket that cannot
// connect must name its cause.
//
// The multi-app test inverts too. It used to assert NO socket was opened for more than
// one app, which was an honest statement of the per-app frame's limit; it now asserts
// one socket is woken for several apps, which is the whole point of the change.
//
// The fake server matches the upgrade path EXACTLY. A suffix test would accept
// `/anything/v1/agent-tasks/stream`, and that is how an earlier version of this file
// managed to "connect" to a URL it was supposed to prove was refused.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  openWakeSocket as openWakeSocketRaw,
  type WorkOptions,
} from "./work.js";

const STREAM_PATH = "/v1/agent-tasks/stream";

let api: Server;
let apiPort = 0;
let wss: WebSocketServer;

/** Every path the WS server was asked to upgrade, so the URL can be asserted. */
let upgradePaths: string[] = [];
/** Subprotocols the client offered, so the credential transport can be asserted. */
let offeredProtocols: string[] = [];
/** Every plain HTTP path the api served, so "it looked the app up" is detectable. */
let httpPaths: string[] = [];
let live: WsSocket[] = [];
/** When true the upgrade is refused, standing in for an unreachable relay. */
let refuseUpgrade = false;

beforeEach(async () => {
  upgradePaths = [];
  offeredProtocols = [];
  httpPaths = [];
  live = [];
  refuseUpgrade = false;

  api = createServer((req, res) => {
    httpPaths.push(req.url ?? "");
    res.statusCode = 404;
    res.end();
  });
  wss = new WebSocketServer({ noServer: true });
  api.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "").split("?")[0];
    upgradePaths.push(path ?? "");
    offeredProtocols.push(String(req.headers["sec-websocket-protocol"] ?? ""));
    // EXACT match, and refusal is a destroy rather than a 404-then-upgrade, so a
    // client that gets the path wrong cannot accidentally pass.
    if (refuseUpgrade || path !== STREAM_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      live.push(ws);
      ws.send(JSON.stringify({ type: "hello" }));
    });
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
  await new Promise<void>((r) => api.close(() => r()));
});

function opts(over: Partial<WorkOptions> = {}): WorkOptions {
  return {
    // NO app filter by default. The default worker drains every app its identity
    // owns, and a fixture that always named one app would make the filtered case look
    // like the ordinary one.
    appIds: [],
    exec: "true",
    maxConcurrent: 1,
    once: false,
    pollSeconds: 300,
    ...over,
  };
}

function base(): string {
  return `http://127.0.0.1:${apiPort}`;
}

async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Push a wake for `appId` down every live socket. */
function wakeFor(appId: string): void {
  for (const ws of live) {
    ws.send(JSON.stringify({ type: "agent-task.available", app_id: appId }));
  }
}

/**
 * `openWakeSocket` with a capacity provider supplied.
 *
 * These tests are about the WAKE half of the socket, not the credit half, so they declare
 * a fixed capacity and ignore it. Credit is covered in `work-push.test.ts`. The argument
 * is deliberately required rather than defaulted in the source: a default of zero would
 * silently disable push for any caller that forgot it, which is precisely the quiet
 * degradation this socket exists to remove.
 */
function openWakeSocket(
  o: WorkOptions,
  key: string,
  b: string,
  onWake: () => void,
): ReturnType<typeof openWakeSocketRaw> {
  return openWakeSocketRaw(o, key, b, onWake, () => 1);
}

describe("openWakeSocket: one socket on the API host", () => {
  it("connects to the worker stream and never looks an app up", async () => {
    const handle = openWakeSocket(opts(), "hs_key", base(), () => {});
    await settle();
    try {
      expect(upgradePaths).toEqual([STREAM_PATH]);
      expect(live).toHaveLength(1);
      // THE regression, inverted. Any request here means an app origin is being
      // derived again, which is the shape that could never connect.
      expect(httpPaths).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("carries the agent key as a subprotocol, not a header", async () => {
    // A WS handshake cannot set Authorization, so the key rides the subprotocol.
    const handle = openWakeSocket(opts(), "hs_secret_key", base(), () => {});
    await settle();
    try {
      expect(offeredProtocols.join(" ")).toContain("homespun.v1");
      expect(offeredProtocols.join(" ")).toContain(
        "homespun.agentkey.hs_secret_key",
      );
    } finally {
      handle.close();
    }
  });

  it("is woken for SEVERAL apps over the one socket", async () => {
    // The point of the change, and the inverse of what this file used to assert. Three
    // distinct apps, one socket, three wakes.
    let woken = 0;
    const handle = openWakeSocket(opts(), "hs_key", base(), () => {
      woken += 1;
    });
    await settle();
    try {
      expect(live).toHaveLength(1);
      wakeFor("app_1");
      wakeFor("app_2");
      wakeFor("app_3");
      await settle(300);
      expect(woken).toBe(3);
      // And still ONE socket: a wake must not cause a second connection.
      expect(upgradePaths).toEqual([STREAM_PATH]);
    } finally {
      handle.close();
    }
  });
});

describe("openWakeSocket: --app filters the wake, not just the claim", () => {
  it("wakes for a named app", async () => {
    let woken = 0;
    const handle = openWakeSocket(
      opts({ appIds: ["app_1", "app_2"] }),
      "hs_key",
      base(),
      () => {
        woken += 1;
      },
    );
    await settle();
    try {
      wakeFor("app_2");
      await settle(300);
      expect(woken).toBe(1);
    } finally {
      handle.close();
    }
  });

  it("does NOT wake for an app it was told to ignore", async () => {
    // Otherwise every other app's traffic cuts this worker's sleep short to run a
    // claim that can only come back empty. Asserted with a POSITIVE control below, so
    // "did not wake" cannot pass on a dead socket.
    const wokenFor: string[] = [];
    const handle = openWakeSocket(
      opts({ appIds: ["app_1"] }),
      "hs_key",
      base(),
      () => {
        wokenFor.push("wake");
      },
    );
    await settle();
    try {
      wakeFor("app_other");
      await settle(300);
      expect(wokenFor).toEqual([]);
      // The control: the SAME socket does wake for the app it was given, so the
      // silence above was a filter and not a broken connection.
      wakeFor("app_1");
      await settle(300);
      expect(wokenFor).toEqual(["wake"]);
    } finally {
      handle.close();
    }
  });

  it("wakes for every app when no filter is given", async () => {
    let woken = 0;
    const handle = openWakeSocket(
      opts({ appIds: [] }),
      "hs_key",
      base(),
      () => {
        woken += 1;
      },
    );
    await settle();
    try {
      wakeFor("an_app_never_named_anywhere");
      await settle(300);
      expect(woken).toBe(1);
    } finally {
      handle.close();
    }
  });
});

describe("openWakeSocket: frames it must not act on", () => {
  it("ignores frames that are not the wake hint", async () => {
    let woken = 0;
    const handle = openWakeSocket(opts(), "hs_key", base(), () => {
      woken += 1;
    });
    await settle();
    try {
      live[0]!.send(JSON.stringify({ type: "hello" }));
      live[0]!.send(
        JSON.stringify({ type: "something-new-from-a-newer-relay" }),
      );
      live[0]!.send(JSON.stringify({ type: "entry", entry: { seq: 1 } }));
      await settle(300);
      expect(woken).toBe(0);
      // And an unknown frame is not treated as an outage: a worker that announced one
      // every time the relay gained a frame type would cry wolf.
      expect(live).toHaveLength(1);
      expect(upgradePaths).toEqual([STREAM_PATH]);
    } finally {
      handle.close();
    }
  });

  it("does not wake on a hint with no app id", async () => {
    // A wake with no app id would otherwise be a wake for app "", which either drains
    // apps the worker was told to skip or claims nothing at all.
    //
    // NO `--app` HERE, and that is the whole reason this test can fail. Written first
    // with `appIds: ["app_1"]`, it passed even with the guard removed, because the
    // filter rejected "" whatever the parser did: it was asserting the CLI's filter
    // while claiming to assert the frame check. An unfiltered worker is both the
    // default and the only configuration where a malformed frame reaches the callback,
    // so it is the one the test has to use. Found by mutation.
    let woken = 0;
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const handle = openWakeSocket(
      opts({ appIds: [] }),
      "hs_key",
      base(),
      () => {
        woken += 1;
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
      await settle(300);
      expect(woken).toBe(0);
      // The positive control: the same socket, unfiltered, DOES wake on a well-formed
      // frame. Without it "no wake" would pass on a socket that had simply died.
      wakeFor("app_1");
      await settle(300);
      expect(woken).toBe(1);
    } finally {
      handle.close();
      spy.mockRestore();
    }
  });
});

describe("openWakeSocket: when it cannot connect", () => {
  it("reports the CAUSE when the socket is refused, not just that it dropped", async () => {
    // Unchanged in substance from the per-app version, and still the assertion that
    // matters most. The original failure said "wake socket lost ... while it
    // reconnects" for a URL that could never work, which sent me looking for a network
    // blip. A first-attempt failure must be distinguishable from a later drop, and must
    // name its reason.
    refuseUpgrade = true;
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const handle = openWakeSocket(opts(), "hs_key", base(), () => {});
    try {
      await settle(700);
      const said = spy.mock.calls.map((c) => String(c[0])).join("");
      expect(said).toMatch(/could not connect/);
      expect(said).not.toMatch(/wake socket lost/);
      // And the reason is in the message rather than discarded.
      expect(said).toMatch(/\(.+\)/);
    } finally {
      handle.close();
      spy.mockRestore();
    }
  });

  it("keeps a handle even when it never connects, so the caller can close it", async () => {
    // It no longer returns null, and that is deliberate: a null meant "there will
    // never be a socket", which was true when the socket needed an app it could not
    // resolve. Now the only reason not to have one is an outage, and an outage
    // reconnects, so the caller always has something to close on shutdown.
    refuseUpgrade = true;
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const handle = openWakeSocket(opts(), "hs_key", base(), () => {});
    try {
      await settle(300);
      expect(typeof handle.close).toBe("function");
      handle.close();
      // Closing must stop the reconnect loop rather than leaving a timer retrying
      // forever against a relay nobody is waiting for.
      const before = upgradePaths.length;
      await settle(1500);
      expect(upgradePaths.length).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("announces an outage once, not once per retry", async () => {
    refuseUpgrade = true;
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const handle = openWakeSocket(opts(), "hs_key", base(), () => {});
    try {
      await settle(2500);
      const said = spy.mock.calls.map((c) => String(c[0])).join("");
      const times = said.split("could not connect").length - 1;
      // Several attempts have been made by now; exactly one of them said so.
      expect(upgradePaths.length).toBeGreaterThan(1);
      expect(times).toBe(1);
    } finally {
      handle.close();
      spy.mockRestore();
    }
  });
});
