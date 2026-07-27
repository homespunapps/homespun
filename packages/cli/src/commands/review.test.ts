// Tests for `homespun review` — drives real command dispatch (create/respond/
// report/remove/unhold) against a fake client stubbed via vi.mock on
// ../config.js, mirroring members.test.ts. Covers each verb calling the right
// SDK method with the right args, star validation, the respond --response vs
// --clear exclusivity, required-flag guards, and a relay error via failFromError.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HomespunApiError } from "@homespunapps/core";

const fakeClient = {
  createReview: vi.fn(),
  respondToReview: vi.fn(),
  reportReview: vi.fn(),
  removeReview: vi.fn(),
  unholdReview: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import { runReview } from "./review.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

const REVIEW_TEST_BOOLS = new Set(["help", "clear"]);

function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, REVIEW_TEST_BOOLS);
}

describe("runReview dispatch", () => {
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
      await runReview(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  // ----- create ------------------------------------------------------------

  it("create forwards the template ref, integer stars, and body", async () => {
    fakeClient.createReview.mockResolvedValue({ id: "rev_1", stars: 5 });
    await run(["create", "acme/todo", "--stars", "5", "--body", "Great app"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.createReview).toHaveBeenCalledWith({
      template: "acme/todo",
      stars: 5,
      body: "Great app",
    });
    // The verb prints the SDK result as JSON.
    expect(JSON.parse(stdout).id).toBe("rev_1");
  });

  it("create requires --stars", async () => {
    await run(["create", "acme/todo"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--stars");
    expect(fakeClient.createReview).not.toHaveBeenCalled();
  });

  it("create rejects stars outside 1 to 5", async () => {
    await run(["create", "acme/todo", "--stars", "6"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("1 to 5");
    expect(fakeClient.createReview).not.toHaveBeenCalled();
  });

  it("create requires the ref positional", async () => {
    await run(["create", "--stars", "5"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage");
    expect(fakeClient.createReview).not.toHaveBeenCalled();
  });

  // ----- respond -----------------------------------------------------------

  it("respond forwards the response text", async () => {
    fakeClient.respondToReview.mockResolvedValue({ id: "rev_1" });
    await run(["respond", "rev_1", "--response", "Thanks!"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.respondToReview).toHaveBeenCalledWith("rev_1", "Thanks!");
  });

  it("respond --clear sends null", async () => {
    fakeClient.respondToReview.mockResolvedValue({ id: "rev_1" });
    await run(["respond", "rev_1", "--clear"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.respondToReview).toHaveBeenCalledWith("rev_1", null);
  });

  it("respond rejects both --response and --clear", async () => {
    await run(["respond", "rev_1", "--response", "hi", "--clear"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("mutually exclusive");
    expect(fakeClient.respondToReview).not.toHaveBeenCalled();
  });

  it("respond requires one of --response or --clear", async () => {
    await run(["respond", "rev_1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("required");
    expect(fakeClient.respondToReview).not.toHaveBeenCalled();
  });

  // ----- report ------------------------------------------------------------

  it("report forwards the review id and reason", async () => {
    fakeClient.reportReview.mockResolvedValue({
      report_id: "rep_1",
      review_id: "rev_1",
    });
    await run(["report", "rev_1", "--reason", "spam"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.reportReview).toHaveBeenCalledWith("rev_1", "spam");
  });

  it("report requires --reason", async () => {
    await run(["report", "rev_1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--reason");
    expect(fakeClient.reportReview).not.toHaveBeenCalled();
  });

  // ----- remove / unhold ---------------------------------------------------

  it("remove calls removeReview", async () => {
    fakeClient.removeReview.mockResolvedValue({
      id: "rev_1",
      status: "removed",
    });
    await run(["remove", "rev_1"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.removeReview).toHaveBeenCalledWith("rev_1");
  });

  it("unhold calls unholdReview", async () => {
    fakeClient.unholdReview.mockResolvedValue({
      id: "rev_1",
      status: "visible",
    });
    await run(["unhold", "rev_1"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.unholdReview).toHaveBeenCalledWith("rev_1");
  });

  it("remove requires the review id", async () => {
    await run(["remove"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage");
    expect(fakeClient.removeReview).not.toHaveBeenCalled();
  });

  // ----- error path + verb guards -----------------------------------------

  it("surfaces a relay error via failFromError", async () => {
    fakeClient.createReview.mockRejectedValue(
      new HomespunApiError(403, "not_installed", "you have not installed this"),
    );
    await run(["create", "acme/todo", "--stars", "4"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("not_installed");
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
