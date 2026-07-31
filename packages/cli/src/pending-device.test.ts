// Unit tests for the parked device flow: where it lands, what mode it lands
// with, and that a corrupt or absent file reads as "nothing to resume" rather
// than throwing.
//
// XDG_CONFIG_HOME is redirected at a temp dir per test, so nothing here can
// touch a real ~/.config/homespun.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pendingDevicePath,
  writePendingDevice,
  readPendingDevice,
  clearPendingDevice,
  isPendingExpired,
  type PendingDevice,
} from "./pending-device.js";

let dir: string;
let savedXdg: string | undefined;

const SAMPLE: PendingDevice = {
  device_code: "dc_abc",
  user_code: "ABCD-EFGH",
  verification_uri_complete: "https://relay.test/device?code=ABCD-EFGH",
  url: "https://relay.test",
  name: "test-agent",
  profile: "default",
  expires_at: new Date(Date.now() + 900_000).toISOString(),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "homespun-pending-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(dir, { recursive: true, force: true });
});

describe("pending device store", () => {
  it("lands beside the config file, not in a temp dir", () => {
    // /tmp would be world-readable by default, and until it is redeemed the
    // device_code is what collects the approved key.
    expect(pendingDevicePath()).toBe(
      join(dir, "homespun", "pending-device.json"),
    );
  });

  it("round-trips, at mode 0600", () => {
    writePendingDevice(SAMPLE);
    expect(readPendingDevice()).toEqual(SAMPLE);
    const mode = statSync(pendingDevicePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("forces 0600 even when the file already existed looser", () => {
    mkdirSync(join(dir, "homespun"), { recursive: true });
    writeFileSync(pendingDevicePath(), "{}", { mode: 0o644 });
    writePendingDevice(SAMPLE);
    expect(statSync(pendingDevicePath()).mode & 0o777).toBe(0o600);
  });

  it("reads a missing, corrupt or structurally wrong file as nothing to resume", () => {
    expect(readPendingDevice()).toBeNull();
    mkdirSync(join(dir, "homespun"), { recursive: true });
    writeFileSync(pendingDevicePath(), "not json at all");
    expect(readPendingDevice()).toBeNull();
    writeFileSync(pendingDevicePath(), JSON.stringify({ url: "x" }));
    expect(readPendingDevice()).toBeNull();
  });

  it("clears idempotently", () => {
    writePendingDevice(SAMPLE);
    clearPendingDevice();
    expect(readPendingDevice()).toBeNull();
    // Second clear must not throw: the post-condition already holds.
    expect(() => clearPendingDevice()).not.toThrow();
  });

  it("treats a past expiry as expired and an unparseable one as not", () => {
    expect(
      isPendingExpired({ ...SAMPLE, expires_at: "2020-01-01T00:00:00Z" }),
    ).toBe(true);
    // Let the relay be the judge rather than refusing to poll a live code.
    expect(isPendingExpired({ ...SAMPLE, expires_at: "" })).toBe(false);
  });
});
