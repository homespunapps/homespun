// Tests for the two-phase device registration: `--start` parks the flow and
// returns, `--resume` redeems it.
//
// The behaviour under test is a TIMING contract, not just an output shape:
// --start must not poll (an agent needs the link before a human can act), and
// --resume must not loop (it reports back into a conversation instead of
// holding a tool call open). Both are pinned by counting relay calls.
//
// XDG_CONFIG_HOME points at a temp dir, so neither the profile store nor the
// pending file can touch a real ~/.config/homespun.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRegister } from "./register.js";
import { parseArgs, BOOLEAN_FLAGS } from "../argv.js";
import { readStore } from "../store.js";
import {
  readPendingDevice,
  writePendingDevice,
  type PendingDevice,
} from "../pending-device.js";

// The REAL parser set, not a local copy. A hand-maintained copy here is
// exactly how #827 shipped: `deploy --check` was in the command's bools and in
// the test's bools but not in BOOLEAN_FLAGS, so parseArgs read it as a value
// flag and the dry run silently deployed. These tests passed against a private
// set while `--start` was unusable in the built CLI, which is how that bug
// reappeared and how the end-to-end run caught it.
function argv(tokens: string[]) {
  return parseArgs(tokens, BOOLEAN_FLAGS);
}

const CODE_BODY = {
  device_code: "dc_test",
  user_code: "ABCD-EFGH",
  verification_uri: "https://relay.test/device",
  verification_uri_complete: "https://relay.test/device?code=ABCD-EFGH",
  expires_in: 900,
  interval: 5,
};

const PENDING: PendingDevice = {
  device_code: "dc_test",
  user_code: "ABCD-EFGH",
  verification_uri_complete: "https://relay.test/device?code=ABCD-EFGH",
  url: "https://relay.test",
  name: "test-agent",
  profile: "default",
  expires_at: new Date(Date.now() + 900_000).toISOString(),
};

let dir: string;
let savedXdg: string | undefined;
let stdout: string;
let stderr: string;
let exitCode: number | undefined;
let calls: string[];

/** Answer every relay call with one scripted response, recording the paths. */
function mockFetch(responses: Array<{ status: number; body: unknown }>): void {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: Parameters<typeof fetch>[0],
  ) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error(`unexpected relay call: ${String(input)}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "homespun-register-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  stdout = "";
  stderr = "";
  exitCode = undefined;
  calls = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr += String(s);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`__exit_${code}__`);
  }) as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  vi.restoreAllMocks();
});

async function run(tokens: string[]): Promise<void> {
  try {
    await runRegister(argv(tokens));
  } catch (e) {
    if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
  }
}

describe("agent register --start", () => {
  it("parks the flow and returns after ONE call, without polling", async () => {
    mockFetch([{ status: 200, body: CODE_BODY }]);
    await run([
      "--start",
      "--url",
      "https://relay.test",
      "--name",
      "test-agent",
    ]);

    expect(exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/device/code");

    const pending = readPendingDevice();
    expect(pending?.device_code).toBe("dc_test");
    expect(pending?.url).toBe("https://relay.test");
    expect(pending?.profile).toBe("default");
  });

  it("puts the link and the code on stdout, where an agent reads them", async () => {
    mockFetch([{ status: 200, body: CODE_BODY }]);
    await run(["--start", "--url", "https://relay.test"]);
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect(payload["state"]).toBe("pending_approval");
    expect(payload["verification_uri_complete"]).toBe(
      "https://relay.test/device?code=ABCD-EFGH",
    );
    expect(payload["user_code"]).toBe("ABCD-EFGH");
    expect(String(payload["next"])).toContain("--resume");
  });

  it("says so plainly when the relay predates the device flow", async () => {
    mockFetch([{ status: 404, body: {} }]);
    await run(["--start", "--url", "https://relay.test"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("device_flow_unsupported");
    expect(readPendingDevice()).toBeNull();
  });
});

describe("agent register --resume", () => {
  it("redeems an approved flow, saves the profile, and clears the parked file", async () => {
    writePendingDevice(PENDING);
    mockFetch([
      {
        status: 200,
        body: { agent_key: "hs_secret", agent_id: "agt_1", name: "test-agent" },
      },
    ]);
    await run(["--resume"]);

    expect(exitCode).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/device/token");

    const store = readStore();
    expect(store.profiles["default"]?.apiKey).toBe("hs_secret");
    expect(store.profiles["default"]?.url).toBe("https://relay.test");
    expect(readPendingDevice()).toBeNull();

    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect(payload["registered_via"]).toBe("device");
    // The key is not echoed unless asked for.
    expect(payload["api_key"]).toBeUndefined();
  });

  it("polls exactly ONCE when not yet approved, and keeps the parked flow", async () => {
    writePendingDevice(PENDING);
    mockFetch([{ status: 400, body: { error: "authorization_pending" } }]);
    await run(["--resume"]);

    expect(calls).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not_approved_yet");
    // The link is repeated, so the agent can re-prompt its human.
    expect(stderr).toContain("ABCD-EFGH");
    // Still resumable: this is the retry path, not a dead end.
    expect(readPendingDevice()?.device_code).toBe("dc_test");
  });

  it("drops the parked flow when the human denied it", async () => {
    writePendingDevice(PENDING);
    mockFetch([{ status: 400, body: { error: "access_denied" } }]);
    await run(["--resume"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("device_flow_denied");
    expect(readPendingDevice()).toBeNull();
  });

  it("refuses a locally expired flow without troubling the relay", async () => {
    writePendingDevice({
      ...PENDING,
      expires_at: "2020-01-01T00:00:00.000Z",
    });
    await run(["--resume"]);
    expect(calls).toHaveLength(0);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("device_flow_expired");
    expect(readPendingDevice()).toBeNull();
  });

  it("says there is nothing to resume when nothing was started", async () => {
    await run(["--resume"]);
    expect(calls).toHaveLength(0);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no_pending_registration");
  });

  it("refuses to poll a relay the flow does not belong to", async () => {
    // Polling the wrong relay would answer expired_token, which reads as
    // "the code died" rather than "you aimed at the wrong place".
    writePendingDevice(PENDING);
    await run(["--resume", "--url", "https://other.test"]);
    expect(calls).toHaveLength(0);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("https://relay.test");
    expect(readPendingDevice()?.device_code).toBe("dc_test");
  });

  it("echoes the key only when asked", async () => {
    writePendingDevice(PENDING);
    mockFetch([
      {
        status: 200,
        body: { agent_key: "hs_secret", agent_id: "agt_1", name: "n" },
      },
    ]);
    await run(["--resume", "--print-key"]);
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    expect(payload["api_key"]).toBe("hs_secret");
  });
});

describe("agent register flag combinations", () => {
  it("rejects --start with --resume", async () => {
    await run(["--start", "--resume"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("rejects --start with --no-device, which has no approval step", async () => {
    await run(["--start", "--no-device"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid_args");
    expect(calls).toHaveLength(0);
  });

  it("rejects --resume alongside a registration secret", async () => {
    await run(["--resume", "--secret", "s3cret"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("invalid_args");
    expect(calls).toHaveLength(0);
  });
});
