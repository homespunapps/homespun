// Device-authorization registration (RFC 8628 style) - the browser-approval
// path behind `homespun agent register`.
//
// The CLI asks the relay for a device_code + user_code pair, prints the
// verification URL + code for the human (who can open it on ANY device),
// and polls POST /v1/device/token until the human approves, denies, or the
// codes expire. On approval the relay creates an agent OWNED by the
// approving human and returns its key exactly once.
//
// Everything human-facing goes to stderr - stdout stays reserved for the
// final JSON envelope, like every other command. fetch/sleep/print are
// injectable so the polling loop is unit-testable with a mocked relay.

import { HomespunApiError } from "@homespunapps/core";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type DeviceFlowResult =
  | {
      /** The relay answered 404 - it predates the device flow. */
      supported: false;
    }
  | {
      supported: true;
      agent_id: string;
      agent_key: string;
      name: string;
    };

export interface DeviceFlowOptions {
  /** Relay base URL (no trailing slash needed; one is trimmed). */
  url: string;
  /** Agent display name shown on the relay's consent screen. Required. */
  name: string;
  /** CLI version for the relay's version-skew check header. */
  cliVersion?: string;
  /** Injectables for tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Human-facing progress sink; defaults to process.stderr. */
  print?: (line: string) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultPrint(line: string): void {
  process.stderr.write(line + "\n");
}

/** POST JSON, returning { status, body } with the body parsed best-effort. */
async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  cliVersion?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cliVersion !== undefined && cliVersion !== "") {
    headers["x-homespun-cli-version"] = cliVersion;
  }
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new HomespunApiError(0, "fetch_error", msg);
  }
  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  if (text !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, body: parsed };
}

/** The relay-envelope error code/message, when the body carries one. */
function envelopeError(
  body: unknown,
): { code: string; message: string } | null {
  const err = (body as { error?: unknown } | null)?.error;
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : "relay_error",
      message: typeof e.message === "string" ? e.message : "relay error",
    };
  }
  return null;
}

/** The RFC 8628 error string ({ error: "authorization_pending" }), if any. */
function rfcErrorCode(body: unknown): string | null {
  const err = (body as { error?: unknown } | null)?.error;
  return typeof err === "string" ? err : null;
}

/**
 * Run the device-authorization flow end to end. Returns `supported: false`
 * when the relay 404s the code request (an older relay - the caller falls
 * back to plain POST /v1/register). Throws HomespunApiError on every other
 * failure, including denial and expiry, with actionable codes:
 *
 *   device_flow_denied    the human clicked Deny
 *   device_flow_expired   nobody approved within the code's lifetime
 */
export async function runDeviceFlow(
  opts: DeviceFlowOptions,
): Promise<DeviceFlowResult> {
  const base = opts.url.replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const print = opts.print ?? defaultPrint;

  // ---- 1. Request the code pair -----------------------------------------
  const start = await postJson(
    fetchImpl,
    `${base}/v1/device/code`,
    { name: opts.name },
    opts.cliVersion,
  );
  if (start.status === 404) {
    // Older relay without the device flow - signal the caller to fall back.
    return { supported: false };
  }
  if (start.status !== 200) {
    const env = envelopeError(start.body);
    throw new HomespunApiError(
      start.status,
      env?.code ?? "relay_error",
      env?.message ?? `relay returned ${start.status} for /v1/device/code`,
    );
  }
  const code = start.body as DeviceCodeResponse;
  if (
    !code ||
    typeof code.device_code !== "string" ||
    typeof code.user_code !== "string" ||
    typeof code.verification_uri_complete !== "string"
  ) {
    throw new HomespunApiError(
      200,
      "invalid_response",
      "relay returned an unexpected /v1/device/code body",
    );
  }

  // ---- 2. Hand the human their marching orders ---------------------------
  const expiresMin = Math.max(1, Math.round((code.expires_in ?? 900) / 60));
  print("");
  print("To approve this agent, open:");
  print("");
  print(`    ${code.verification_uri_complete}`);
  print("");
  print(`and confirm the code:  ${code.user_code}`);
  print("");
  print(
    "You can open the link on any device (phone or laptop) and sign in there.",
  );
  print(
    `Waiting for approval... (expires in ${expiresMin} min; Ctrl-C to abort)`,
  );

  // ---- 3. Poll until a terminal answer -----------------------------------
  let intervalSeconds =
    typeof code.interval === "number" && code.interval > 0 ? code.interval : 5;
  const deadline = Date.now() + (code.expires_in ?? 900) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    // Re-check after sleeping: don't fire a poll we already know is past
    // the code's lifetime (the relay would just answer expired_token).
    if (Date.now() >= deadline) break;

    const poll = await postJson(
      fetchImpl,
      `${base}/v1/device/token`,
      { device_code: code.device_code },
      opts.cliVersion,
    );

    if (poll.status === 200) {
      const body = poll.body as {
        agent_key?: unknown;
        agent_id?: unknown;
        name?: unknown;
      };
      if (
        typeof body?.agent_key !== "string" ||
        typeof body?.agent_id !== "string"
      ) {
        throw new HomespunApiError(
          200,
          "invalid_response",
          "relay returned an unexpected /v1/device/token body",
        );
      }
      print("Approved.");
      return {
        supported: true,
        agent_id: body.agent_id,
        agent_key: body.agent_key,
        name: typeof body.name === "string" ? body.name : opts.name,
      };
    }

    const rfc = rfcErrorCode(poll.body);
    if (poll.status === 400 && rfc !== null) {
      switch (rfc) {
        case "authorization_pending":
          continue;
        case "slow_down":
          // RFC 8628 §3.5: add 5 seconds to the interval and keep going.
          intervalSeconds += 5;
          continue;
        case "access_denied":
          throw new HomespunApiError(
            400,
            "device_flow_denied",
            "the approval request was denied in the browser",
          );
        case "expired_token":
          throw new HomespunApiError(
            400,
            "device_flow_expired",
            "the device code expired before it was approved - run 'homespun agent register' again",
          );
        default:
          throw new HomespunApiError(
            400,
            rfc,
            `relay rejected the poll (${rfc})`,
          );
      }
    }

    if (poll.status === 429) {
      // Transient general rate limit - back off like a slow_down and retry.
      intervalSeconds += 5;
      continue;
    }

    // 426 cli_upgrade_required and anything else: surface the envelope.
    const env = envelopeError(poll.body);
    throw new HomespunApiError(
      poll.status,
      env?.code ?? "relay_error",
      env?.message ?? `relay returned ${poll.status} for /v1/device/token`,
      (poll.body as { error?: { details?: unknown } } | null)?.error?.details,
    );
  }

  throw new HomespunApiError(
    400,
    "device_flow_expired",
    "the device code expired before it was approved - run 'homespun agent register' again",
  );
}
