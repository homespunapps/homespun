// Unit tests for the device-authorization polling loop, exercised through
// the injectable fetch/sleep: pending -> slow_down -> success, the 404
// older-relay fallback signal, and the terminal denied/expired errors.

import { describe, it, expect } from "vitest";
import { HomespunApiError } from "@homespunapps/core";
import { runDeviceFlow, type DeviceCodeResponse } from "./device-flow.js";

const CODE_RESPONSE: DeviceCodeResponse = {
  device_code: "dc_test-device-code",
  user_code: "ABCD-EFGH",
  verification_uri: "https://relay.test/device",
  verification_uri_complete: "https://relay.test/device?code=ABCD-EFGH",
  expires_in: 900,
  interval: 5,
};

interface Call {
  url: string;
  body: unknown;
}

/**
 * Build a mocked relay: the first call answers /v1/device/code with `start`,
 * then each /v1/device/token poll shifts the next scripted answer. Records
 * every call and every sleep so tests can pin ordering + intervals.
 */
function mockRelay(
  start: { status: number; body?: unknown },
  polls: Array<{ status: number; body: unknown }>,
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const printed: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    if (url.endsWith("/v1/device/code")) {
      return new Response(JSON.stringify(start.body ?? {}), {
        status: start.status,
        headers: { "content-type": "application/json" },
      });
    }
    const next = polls.shift();
    if (!next) throw new Error("unexpected extra poll");
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    sleeps,
    printed,
    opts: {
      url: "https://relay.test",
      name: "test-agent",
      cliVersion: "9.9.9",
      fetchImpl,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
      print: (line: string) => {
        printed.push(line);
      },
    },
  };
}

describe("runDeviceFlow", () => {
  it("polls through pending and slow_down to success, honoring the interval bump", async () => {
    const relay = mockRelay({ status: 200, body: CODE_RESPONSE }, [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "authorization_pending" } },
      {
        status: 200,
        body: { agent_key: "hs_abc123", agent_id: "agt_1", name: "test-agent" },
      },
    ]);

    const result = await runDeviceFlow(relay.opts);
    expect(result).toEqual({
      supported: true,
      agent_id: "agt_1",
      agent_key: "hs_abc123",
      name: "test-agent",
    });

    // One code request + four polls.
    expect(relay.calls.map((c) => c.url)).toEqual([
      "https://relay.test/v1/device/code",
      "https://relay.test/v1/device/token",
      "https://relay.test/v1/device/token",
      "https://relay.test/v1/device/token",
      "https://relay.test/v1/device/token",
    ]);
    expect(relay.calls[0]!.body).toEqual({ name: "test-agent" });
    expect(relay.calls[1]!.body).toEqual({
      device_code: "dc_test-device-code",
    });

    // Interval: 5s, 5s, then slow_down bumps to 10s (RFC 8628 3.5).
    expect(relay.sleeps).toEqual([5000, 5000, 10000, 10000]);

    // The human-facing block names the URL and the code, on stderr not stdout.
    const text = relay.printed.join("\n");
    expect(text).toContain("https://relay.test/device?code=ABCD-EFGH");
    expect(text).toContain("ABCD-EFGH");
    expect(text).toContain("any device");
  });

  it("returns supported:false when the relay 404s the code request", async () => {
    const relay = mockRelay({ status: 404, body: {} }, []);
    const result = await runDeviceFlow(relay.opts);
    expect(result).toEqual({ supported: false });
    expect(relay.calls).toHaveLength(1);
    expect(relay.sleeps).toEqual([]);
  });

  it("throws device_flow_denied when the human denies", async () => {
    const relay = mockRelay({ status: 200, body: CODE_RESPONSE }, [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "access_denied" } },
    ]);
    await expect(runDeviceFlow(relay.opts)).rejects.toMatchObject({
      code: "device_flow_denied",
    });
  });

  it("throws device_flow_expired on expired_token", async () => {
    const relay = mockRelay({ status: 200, body: CODE_RESPONSE }, [
      { status: 400, body: { error: "expired_token" } },
    ]);
    await expect(runDeviceFlow(relay.opts)).rejects.toMatchObject({
      code: "device_flow_expired",
    });
  });

  it("gives up with device_flow_expired once the local deadline passes", async () => {
    // expires_in of 12s with a 5s interval: two on-schedule polls fit
    // (5s, 10s), the third would start past the deadline.
    const relay = mockRelay(
      { status: 200, body: { ...CODE_RESPONSE, expires_in: 12 } },
      [
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "authorization_pending" } },
      ],
    );
    let clock = 0;
    relay.opts.sleepImpl = async (ms: number) => {
      clock += ms;
    };
    const realNow = Date.now;
    const base = realNow.call(Date);
    Date.now = () => base + clock;
    try {
      await expect(runDeviceFlow(relay.opts)).rejects.toMatchObject({
        code: "device_flow_expired",
      });
    } finally {
      Date.now = realNow;
    }
    expect(relay.calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(2);
  });

  it("backs off and retries on a 429 general rate limit", async () => {
    const relay = mockRelay({ status: 200, body: CODE_RESPONSE }, [
      {
        status: 429,
        body: { error: { code: "rate_limited", message: "slow down" } },
      },
      {
        status: 200,
        body: { agent_key: "hs_abc", agent_id: "agt_2", name: "test-agent" },
      },
    ]);
    const result = await runDeviceFlow(relay.opts);
    expect(result).toMatchObject({ supported: true, agent_id: "agt_2" });
    expect(relay.sleeps).toEqual([5000, 10000]);
  });

  it("surfaces the relay error envelope on non-RFC failures", async () => {
    const relay = mockRelay({ status: 200, body: CODE_RESPONSE }, [
      {
        status: 426,
        body: {
          error: { code: "cli_upgrade_required", message: "too old" },
        },
      },
    ]);
    await expect(runDeviceFlow(relay.opts)).rejects.toMatchObject({
      status: 426,
      code: "cli_upgrade_required",
    });
  });

  it("surfaces a code-request failure as a HomespunApiError", async () => {
    const relay = mockRelay(
      {
        status: 400,
        body: { error: { code: "invalid_request", message: "bad name" } },
      },
      [],
    );
    await expect(runDeviceFlow(relay.opts)).rejects.toBeInstanceOf(
      HomespunApiError,
    );
  });

  it("sends the CLI version header on both endpoints", async () => {
    const headersSeen: Array<Record<string, string>> = [];
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      headersSeen.push({ ...(init?.headers as Record<string, string>) });
      if (headersSeen.length === 1) {
        return new Response(JSON.stringify(CODE_RESPONSE), { status: 200 });
      }
      return new Response(
        JSON.stringify({ agent_key: "hs_k", agent_id: "a", name: "n" }),
        { status: 200 },
      );
    }) as typeof fetch;
    await runDeviceFlow({
      url: "https://relay.test",
      name: "x",
      cliVersion: "1.2.3",
      fetchImpl,
      sleepImpl: async () => {},
      print: () => {},
    });
    expect(headersSeen).toHaveLength(2);
    for (const h of headersSeen) {
      expect(h["x-homespun-cli-version"]).toBe("1.2.3");
    }
  });
});
