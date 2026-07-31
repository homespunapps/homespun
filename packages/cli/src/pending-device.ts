// The half-finished device-authorization flow, parked on disk between
// `homespun agent register --start` and `homespun agent register --resume`.
//
// WHY THIS FILE EXISTS. The blocking `homespun agent register` holds the
// device_code in memory and polls until the human approves. That is right for
// a human at their own terminal and wrong for a coding agent, which runs the
// command as one blocking tool call: the harness kills it on a timeout (Claude
// Code's default is 2 minutes against a 15-minute code lifetime), and the relay
// issues the agent key ONLY to the poller that consumes the approved flow. So
// the human approves, sees success in the browser, and no key is ever written.
//
// Parking the device_code here breaks that coupling. `--start` returns as soon
// as it has the link, the agent shows it to the human, and `--resume` collects
// the key whenever the human says they are done. The relay needs no change: an
// approved flow waits, unconsumed, for its full TTL.
//
// MODE 0600, and that is not decoration. Until it is consumed, the device_code
// is a bearer credential: whoever holds it collects the key the human just
// approved. It lives beside config.json (which holds API keys under the same
// mode) rather than in /tmp, where a world-readable default would hand the
// approval to any other account on the machine.
//
// One pending flow at a time. A second --start overwrites the first, which is
// what someone re-running it after a mistake means; the abandoned flow expires
// on the relay by itself.

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { storePath } from "./store.js";

export interface PendingDevice {
  /** The bearer credential the relay redeems for the agent key. */
  device_code: string;
  /** The short code the human confirms on the approval screen. */
  user_code: string;
  /** The link the human opens, code already embedded. */
  verification_uri_complete: string;
  /** Relay this flow belongs to. --resume must not poll a different one. */
  url: string;
  /** Agent display name, echoed on the approval screen. */
  name: string;
  /** Profile the key lands in once approved. */
  profile: string;
  /** ISO 8601. Past this, the relay answers expired_token. */
  expires_at: string;
}

/** Absolute path to the pending-flow file, beside the config file. */
export function pendingDevicePath(): string {
  return join(dirname(storePath()), "pending-device.json");
}

/** Persist the in-flight flow. Creates the config dir if this is a fresh
 *  install, and forces 0600 even when the file already existed looser. */
export function writePendingDevice(pending: PendingDevice): string {
  const path = pendingDevicePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pending, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * Read the parked flow, or null when there is none.
 *
 * Returns null rather than throwing for a missing, unreadable, unparseable or
 * structurally wrong file: every one of those means the same thing to the
 * caller ("nothing to resume, run --start"), and a JSON parse error is a
 * worse way to say it.
 */
export function readPendingDevice(): PendingDevice | null {
  let text: string;
  try {
    text = readFileSync(pendingDevicePath(), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const p = parsed as Partial<PendingDevice>;
  if (
    typeof p.device_code !== "string" ||
    typeof p.url !== "string" ||
    typeof p.profile !== "string"
  ) {
    return null;
  }
  return {
    device_code: p.device_code,
    user_code: typeof p.user_code === "string" ? p.user_code : "",
    verification_uri_complete:
      typeof p.verification_uri_complete === "string"
        ? p.verification_uri_complete
        : "",
    url: p.url,
    name: typeof p.name === "string" ? p.name : "",
    profile: p.profile,
    expires_at: typeof p.expires_at === "string" ? p.expires_at : "",
  };
}

/** Whether the parked flow is past its expiry. An unparseable or absent
 *  timestamp counts as NOT expired: let the relay be the judge rather than
 *  refusing to poll a flow that might still be good. */
export function isPendingExpired(
  pending: PendingDevice,
  now: number = Date.now(),
): boolean {
  const at = Date.parse(pending.expires_at);
  return Number.isFinite(at) && at <= now;
}

/** Delete the parked flow. Idempotent: a missing file is success, since the
 *  post-condition ("no pending flow on disk") already holds. */
export function clearPendingDevice(): void {
  try {
    unlinkSync(pendingDevicePath());
  } catch {
    // Already gone.
  }
}
