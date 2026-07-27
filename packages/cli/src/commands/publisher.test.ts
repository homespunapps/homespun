// Tests for `homespun publisher` — drives real command dispatch
// (claim/show/update/set-trust) against a fake client stubbed via vi.mock on
// ../config.js, mirroring the members.test.ts style. Covers each verb calling
// the right SDK method with the right args, the update at-least-one-flag guard
// and its --website to url mapping, set-trust level validation, and a relay
// error surfaced through failFromError.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HomespunApiError } from "@homespunapps/core";

const fakeClient = {
  claimPublisherHandle: vi.fn(),
  getPublisher: vi.fn(),
  updatePublisher: vi.fn(),
  setPublisherTrustLevel: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import { runPublisher } from "./publisher.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

const PUBLISHER_TEST_BOOLS = new Set(["help"]);

function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, PUBLISHER_TEST_BOOLS);
}

describe("runPublisher dispatch", () => {
  let stdout: string;
  let stderr: string;
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = "";
    stderr = "";
    exitCode = undefined;
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
    vi.restoreAllMocks();
  });

  async function run(tokens: string[]): Promise<void> {
    try {
      await runPublisher(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  // ----- claim -------------------------------------------------------------

  it("claim calls claimPublisherHandle with the handle", async () => {
    fakeClient.claimPublisherHandle.mockResolvedValue({
      handle: "acme",
      claimed: true,
    });
    await run(["claim", "acme"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.claimPublisherHandle).toHaveBeenCalledWith("acme");
    expect(JSON.parse(stdout).handle).toBe("acme");
  });

  it("claim requires a handle", async () => {
    await run(["claim"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage");
    expect(fakeClient.claimPublisherHandle).not.toHaveBeenCalled();
  });

  // ----- show --------------------------------------------------------------

  it("show calls getPublisher", async () => {
    fakeClient.getPublisher.mockResolvedValue({ handle: "acme", bio: "hi" });
    await run(["show"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.getPublisher).toHaveBeenCalledWith();
    expect(JSON.parse(stdout).handle).toBe("acme");
  });

  // ----- update ------------------------------------------------------------

  it("update maps --website to the url field and forwards the rest", async () => {
    fakeClient.updatePublisher.mockResolvedValue({ handle: "acme" });
    await run([
      "update",
      "--display-name",
      "Acme Co",
      "--bio",
      "We build",
      "--website",
      "https://acme.test",
    ]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.updatePublisher).toHaveBeenCalledWith({
      displayName: "Acme Co",
      bio: "We build",
      url: "https://acme.test",
    });
  });

  it("update requires at least one field", async () => {
    await run(["update"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("at least one");
    expect(fakeClient.updatePublisher).not.toHaveBeenCalled();
  });

  // ----- set-trust ---------------------------------------------------------

  it("set-trust forwards the handle and level", async () => {
    fakeClient.setPublisherTrustLevel.mockResolvedValue({
      handle: "acme",
      trust_level: "established",
    });
    await run(["set-trust", "acme", "established"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.setPublisherTrustLevel).toHaveBeenCalledWith(
      "acme",
      "established",
    );
  });

  it("set-trust rejects an invalid level", async () => {
    await run(["set-trust", "acme", "gold"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("trust level");
    expect(fakeClient.setPublisherTrustLevel).not.toHaveBeenCalled();
  });

  it("set-trust requires both positionals", async () => {
    await run(["set-trust", "acme"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage");
    expect(fakeClient.setPublisherTrustLevel).not.toHaveBeenCalled();
  });

  // ----- error path + verb guards -----------------------------------------

  it("surfaces a relay error via failFromError", async () => {
    fakeClient.claimPublisherHandle.mockRejectedValue(
      new HomespunApiError(409, "handle_taken", "that handle is taken"),
    );
    await run(["claim", "acme"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("handle_taken");
  });

  it("rejects an unknown verb", async () => {
    await run(["frobnicate"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown verb");
  });

  it("fails with a missing-verb message when no verb is given", async () => {
    await run([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("missing verb");
  });
});
