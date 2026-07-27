// Tests for `homespun template` — drives real command dispatch (publish/
// config-contract/install/list-pending/show/approve/reject) against a fake
// client stubbed via vi.mock on ../config.js, mirroring members.test.ts.
// Covers each verb calling the right SDK method with the right args, app-ref
// resolution and JSON flag parsing on publish, the JSON --config on install,
// reject's required --note, and a relay error surfaced via failFromError.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HomespunApiError } from "@homespunapps/core";

const fakeClient = {
  getApp: vi.fn(),
  listApps: vi.fn(),
  publishCommunityTemplate: vi.fn(),
  getCommunityConfigContract: vi.fn(),
  installCommunityTemplate: vi.fn(),
  listCommunitySubmissions: vi.fn(),
  getCommunitySubmission: vi.fn(),
  reviewCommunitySubmission: vi.fn(),
};

vi.mock("../config.js", () => ({
  makeClient: () => fakeClient,
  resolveConfig: () => ({ url: "http://relay.test", apiKey: "test-key" }),
}));

import { runTemplate } from "./template.js";
import { parseArgs, type ParsedArgs } from "../argv.js";

const TEMPLATE_TEST_BOOLS = new Set(["help", "attest-example-only"]);

function makeArgs(tokens: string[]): ParsedArgs {
  return parseArgs(tokens, TEMPLATE_TEST_BOOLS);
}

describe("runTemplate dispatch", () => {
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
      await runTemplate(makeArgs(tokens));
    } catch (e) {
      if (!(e instanceof Error && e.message.startsWith("__exit_"))) throw e;
    }
  }

  // ----- publish -----------------------------------------------------------

  it("publish resolves the app and forwards flags, tags JSON, and the attest bool", async () => {
    fakeClient.getApp.mockResolvedValue({ id: "appabcdefghijklmnopqrstu" });
    fakeClient.publishCommunityTemplate.mockResolvedValue({
      snapshot_id: "snap_1",
      review_status: "pending",
    });

    await run([
      "publish",
      "appabcdefghijklmnopqrstu",
      "--title",
      "My Template",
      "--tags",
      '["home","budget"]',
      "--version",
      "2.0.0",
      "--attest-example-only",
    ]);

    expect(exitCode).toBeUndefined();
    expect(fakeClient.publishCommunityTemplate).toHaveBeenCalledWith({
      appId: "appabcdefghijklmnopqrstu",
      title: "My Template",
      tags: ["home", "budget"],
      version: "2.0.0",
      attestExampleOnly: true,
    });
    expect(JSON.parse(stdout).snapshot_id).toBe("snap_1");
  });

  it("publish resolves a slug via listApps", async () => {
    fakeClient.listApps.mockResolvedValue({ items: [{ id: "app_resolved" }] });
    fakeClient.publishCommunityTemplate.mockResolvedValue({
      snapshot_id: "snap_2",
    });

    await run(["publish", "my-app"]);

    expect(fakeClient.listApps).toHaveBeenCalledWith({
      status: "all",
      slug: "my-app",
      limit: 1,
    });
    expect(fakeClient.publishCommunityTemplate).toHaveBeenCalledWith({
      appId: "app_resolved",
    });
  });

  it("publish requires the app positional", async () => {
    await run(["publish"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("usage");
    expect(fakeClient.publishCommunityTemplate).not.toHaveBeenCalled();
  });

  // ----- config-contract ---------------------------------------------------

  it("config-contract passes the ref straight through", async () => {
    fakeClient.getCommunityConfigContract.mockResolvedValue({
      snapshot_id: "snap_1",
      config_steps: [],
    });
    await run(["config-contract", "acme/todo"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.getCommunityConfigContract).toHaveBeenCalledWith(
      "acme/todo",
    );
  });

  // ----- install -----------------------------------------------------------

  it("install forwards the ref and parsed --config JSON", async () => {
    fakeClient.installCommunityTemplate.mockResolvedValue({
      app_id: "app_new",
      slug: "todo",
      url: "https://todo.test",
    });
    await run(["install", "acme/todo", "--config", '{"title":"My Todos"}']);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.installCommunityTemplate).toHaveBeenCalledWith(
      "acme/todo",
      { title: "My Todos" },
    );
  });

  it("install works without --config (undefined config)", async () => {
    fakeClient.installCommunityTemplate.mockResolvedValue({
      app_id: "app_new",
    });
    await run(["install", "acme/todo"]);
    expect(fakeClient.installCommunityTemplate).toHaveBeenCalledWith(
      "acme/todo",
      undefined,
    );
  });

  // ----- list-pending ------------------------------------------------------

  it("list-pending forwards limit and cursor", async () => {
    fakeClient.listCommunitySubmissions.mockResolvedValue({
      items: [],
      next_cursor: null,
    });
    await run(["list-pending", "--limit", "10", "--cursor", "c1"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.listCommunitySubmissions).toHaveBeenCalledWith({
      limit: 10,
      cursor: "c1",
    });
  });

  // ----- show --------------------------------------------------------------

  it("show fetches one submission by snapshot id", async () => {
    fakeClient.getCommunitySubmission.mockResolvedValue({ snapshot_id: "s1" });
    await run(["show", "s1"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.getCommunitySubmission).toHaveBeenCalledWith("s1");
  });

  // ----- approve / reject --------------------------------------------------

  it("approve reviews the submission with an approve decision", async () => {
    fakeClient.reviewCommunitySubmission.mockResolvedValue({
      snapshot_id: "s1",
      review_status: "approved",
    });
    await run(["approve", "s1"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.reviewCommunitySubmission).toHaveBeenCalledWith("s1", {
      decision: "approve",
    });
  });

  it("reject reviews the submission with a reject decision and note", async () => {
    fakeClient.reviewCommunitySubmission.mockResolvedValue({
      snapshot_id: "s1",
      review_status: "rejected",
    });
    await run(["reject", "s1", "--note", "needs work"]);
    expect(exitCode).toBeUndefined();
    expect(fakeClient.reviewCommunitySubmission).toHaveBeenCalledWith("s1", {
      decision: "reject",
      note: "needs work",
    });
  });

  it("reject requires --note", async () => {
    await run(["reject", "s1"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--note");
    expect(fakeClient.reviewCommunitySubmission).not.toHaveBeenCalled();
  });

  // ----- error path + verb guards -----------------------------------------

  it("surfaces a relay error via failFromError", async () => {
    fakeClient.getCommunityConfigContract.mockRejectedValue(
      new HomespunApiError(404, "not_found", "no such template"),
    );
    await run(["config-contract", "acme/nope"]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr).error.code).toBe("not_found");
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
