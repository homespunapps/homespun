// Tests for the Homespun MCP tool layer.
//
// Two concerns, matching the repo's test style (vitest, mocked deps):
//   1. tool listing — the server advertises the expected tool set with
//      non-empty descriptions and input schemas (the descriptions are the
//      docs the LLM reads, so an empty one is a real bug).
//   2. mocked-core round trip — each handler maps its args onto the right
//      HomespunClient call and shapes the result/errors as the model expects.
//
// (The v1 homespun-lifecycle/events/records/participant/share/query tools —
// and their listing/schema/round-trip coverage — were removed along with
// the rest of the v1 app API. Per-tool Zod-shape validation for the
// remaining v2 tools lives in the "v2 tool schema validation" describe
// block further down.)

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HomespunApiError } from "@homespunapps/core";
import { TOOLS } from "./tools.js";

/** Find a tool by name (throws if absent — keeps the tests honest). */
function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool '${name}' not registered`);
  return t;
}

/** A HomespunClient stub: every method is a vi.fn; cast to satisfy the handler. */
function fakeClient(overrides: Record<string, unknown> = {}) {
  return overrides as unknown as Parameters<
    (typeof TOOLS)[number]["handler"]
  >[0];
}

/** The full v2-only tool set. */
const EXPECTED_TOOLS = [
  // v2 app lifecycle + data (discrete, hot-path)
  "deploy_app",
  "list_rows",
  "get_row",
  "upsert_row",
  "update_row",
  "delete_row",
  "get_feed_events",
  // consolidated action-enum tools
  "apps",
  "members",
  "grants",
  "ingest",
  "attachments",
  "taste",
  "key",
  "feedback",
  "agent",
  "community",
  "publisher",
  "review",
  // single-purpose
  "get_skill",
];

describe("tool listing", () => {
  it("exposes exactly the expected tool set", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(
      EXPECTED_TOOLS.slice().sort(),
    );
  });

  it("has no duplicate tool names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("consolidated tools require an `action` field", () => {
    for (const name of [
      "attachments",
      "taste",
      "key",
      "feedback",
      "agent",
      "apps",
      "members",
      "grants",
      "ingest",
      "community",
      "publisher",
      "review",
    ]) {
      expect("action" in tool(name).inputSchema).toBe(true);
    }
  });

  it("every tool has a non-empty description and an input schema", () => {
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
      expect(typeof t.inputSchema).toBe("object");
      // The shape must be a Zod raw shape (record of ZodType).
      expect(Object.keys(t.inputSchema).length).toBeGreaterThan(0);
    }
  });

  it("registers exactly 20 tools", () => {
    // Pinned so the directory-readiness annotation sweep can't silently lose or
    // duplicate a tool.
    expect(TOOLS).toHaveLength(20);
  });

  it("every tool carries a Title-Case title and behavioural hints", () => {
    for (const t of TOOLS) {
      // A human-friendly title is mandatory for connector-directory readiness.
      expect(typeof t.annotations.title).toBe("string");
      expect(t.annotations.title!.length).toBeGreaterThan(0);
      // First char of the title is upper-case (Title Case).
      expect(t.annotations.title![0]).toBe(
        t.annotations.title![0]!.toUpperCase(),
      );
      // Exactly one of readOnly / destructive describes the tool's privilege.
      const ro = t.annotations.readOnlyHint === true;
      const destructive = t.annotations.destructiveHint === true;
      expect(ro || destructive).toBe(true);
      // A read-only tool must not ALSO claim to be destructive.
      if (ro) expect(destructive).toBe(false);
    }
  });

  it("pure-read tools are readOnly and never destructive", () => {
    const READ_ONLY = ["get_skill", "list_rows", "get_row", "get_feed_events"];
    for (const name of READ_ONLY) {
      const a = tool(name).annotations;
      expect(a.readOnlyHint, name).toBe(true);
      expect(a.destructiveHint, name).not.toBe(true);
    }
  });

  it("mutating + consolidated tools are destructive and not readOnly", () => {
    const DESTRUCTIVE = [
      // discrete mutators
      "deploy_app",
      "upsert_row",
      "update_row",
      "delete_row",
      // consolidated action-enum tools (most-privileged action is a write/delete)
      "attachments",
      "taste",
      "key",
      "feedback",
      "agent",
      "apps",
      "members",
      "grants",
      "ingest",
    ];
    for (const name of DESTRUCTIVE) {
      const a = tool(name).annotations;
      expect(a.destructiveHint, name).toBe(true);
      expect(a.readOnlyHint, name).toBe(false);
    }
  });

  it("idempotent mutators set idempotentHint", () => {
    for (const name of ["upsert_row", "update_row", "delete_row", "apps"]) {
      expect(tool(name).annotations.idempotentHint, name).toBe(true);
    }
  });

  it("open-world (human-facing / external-delivery) tools set openWorldHint", () => {
    for (const name of ["attachments", "deploy_app"]) {
      expect(tool(name).annotations.openWorldHint, name).toBe(true);
    }
    // A row-internal CRUD tool is closed-world.
    expect(tool("update_row").annotations.openWorldHint).toBe(false);
  });

  it("representative annotation sample is exactly correct", () => {
    // Read-only.
    expect(tool("list_rows").annotations).toEqual({
      title: "List Rows",
      readOnlyHint: true,
      openWorldHint: false,
    });
    // Destructive + idempotent + closed-world.
    expect(tool("delete_row").annotations).toEqual({
      title: "Delete Row",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    // Consolidated action-enum tool (CAN delete → destructive).
    expect(tool("apps").annotations).toEqual({
      title: "Manage Apps",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Consolidated tools — per-action coverage
// ---------------------------------------------------------------------------

describe("attachments tool", () => {
  it("steers toward presign and warns about the inline token cost (report finding: image upload token spike)", () => {
    const t = tool("attachments");
    // The tool-level description names the model-context token cost and the
    // preference for presign on any real image.
    expect(t.description.toLowerCase()).toContain("model context");
    expect(t.description.toLowerCase()).toContain("proportional to file size");
    expect(t.description.toLowerCase()).toContain("presign");
    // The content_base64 field doc carries the same warning so a client that
    // only reads field docs still sees it.
    const contentDoc = (
      t.inputSchema["content_base64"] as { description?: string }
    ).description;
    expect(contentDoc?.toLowerCase()).toContain("model context");
    expect(contentDoc?.toLowerCase()).toContain("proportional to file size");
  });

  it("upload rejects scope=app without app_id", async () => {
    const uploadBlob = vi.fn();
    const res = await tool("attachments").handler(fakeClient({ uploadBlob }), {
      action: "upload",
      file_path: "/tmp/whatever",
      scope: "app",
    });
    expect(res.isError).toBe(true);
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it("upload with `content_base64` calls the relay inline path, no filesystem read", async () => {
    const bytes = Buffer.from("inline image bytes");
    const base64 = bytes.toString("base64");
    const uploadBlobInline = vi
      .fn()
      .mockResolvedValue({ attachment_id: "att_inline", mime: "image/png" });
    const uploadBlob = vi.fn();
    const res = await tool("attachments").handler(
      fakeClient({ uploadBlobInline, uploadBlob }),
      {
        action: "upload",
        content_base64: base64,
        filename: "generated.png",
        mime: "image/png",
      },
    );
    expect(res.isError).toBeUndefined();
    // The base64 is forwarded verbatim to the inline route (never decoded /
    // written to disk locally), and the multipart path is not touched.
    expect(uploadBlobInline).toHaveBeenCalledWith(base64, {
      scope: "agent",
      appId: undefined,
      filename: "generated.png",
      mime: "image/png",
    });
    expect(uploadBlob).not.toHaveBeenCalled();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.attachment_id).toBe("att_inline");
  });

  it("upload accepts `content` as a silent alias for `content_base64`", async () => {
    const base64 = Buffer.from("legacy bytes").toString("base64");
    const uploadBlobInline = vi
      .fn()
      .mockResolvedValue({ attachment_id: "att_alias" });
    const res = await tool("attachments").handler(
      fakeClient({ uploadBlobInline, uploadBlob: vi.fn() }),
      { action: "upload", content: base64 },
    );
    expect(res.isError).toBeUndefined();
    expect(uploadBlobInline).toHaveBeenCalledWith(base64, {
      scope: "agent",
      appId: undefined,
      filename: undefined,
      mime: undefined,
    });
  });

  it("upload prefers `content_base64` over `file_path` when both are given", async () => {
    const uploadBlobInline = vi
      .fn()
      .mockResolvedValue({ attachment_id: "att_inline" });
    const uploadBlob = vi.fn();
    // The file_path points nowhere; if the handler tried to read it, it would
    // error. `content_base64` winning proves it never touches the filesystem.
    const res = await tool("attachments").handler(
      fakeClient({ uploadBlobInline, uploadBlob }),
      {
        action: "upload",
        content_base64: Buffer.from("bytes").toString("base64"),
        file_path: "/nonexistent/does-not-exist.bin",
      },
    );
    expect(res.isError).toBeUndefined();
    expect(uploadBlobInline).toHaveBeenCalledTimes(1);
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it("upload errors clearly when neither `content_base64` nor `file_path` is given", async () => {
    const uploadBlob = vi.fn();
    const uploadBlobInline = vi.fn();
    const res = await tool("attachments").handler(
      fakeClient({ uploadBlob, uploadBlobInline }),
      { action: "upload" },
    );
    expect(res.isError).toBe(true);
    expect(uploadBlob).not.toHaveBeenCalled();
    expect(uploadBlobInline).not.toHaveBeenCalled();
  });

  it("upload's file_path read error explains the relay-host filesystem caveat", async () => {
    const uploadBlob = vi.fn();
    const res = await tool("attachments").handler(
      fakeClient({ uploadBlob, uploadBlobInline: vi.fn() }),
      { action: "upload", file_path: "/nonexistent/does-not-exist.bin" },
    );
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.message).toContain("content_base64");
    expect(body.message).toContain("relay host");
    expect(uploadBlob).not.toHaveBeenCalled();
  });

  it("upload rejects file_path (no filesystem read) when env.hostFsReads is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-upload-deny-"));
    const filePath = join(dir, "secret.bin");
    writeFileSync(filePath, "SECRET");
    const uploadBlob = vi.fn();
    const res = await tool("attachments").handler(
      fakeClient({ uploadBlob, uploadBlobInline: vi.fn() }),
      { action: "upload", file_path: filePath },
      { hostFsReads: false },
    );
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.message).toContain("file_path is not available");
    expect(body.message).toContain("content_base64");
    // The file exists and is readable; the guard must deny before any read.
    expect(uploadBlob).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upload still reads file_path when env.hostFsReads is explicitly true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-upload-allow-"));
    const filePath = join(dir, "data.bin");
    writeFileSync(filePath, "hello-bytes");
    const uploadBlob = vi.fn().mockResolvedValue({ attachment_id: "att_up" });
    const res = await tool("attachments").handler(
      fakeClient({ uploadBlob, uploadBlobInline: vi.fn() }),
      { action: "upload", file_path: filePath },
      { hostFsReads: true },
    );
    expect(res.isError).toBeUndefined();
    expect(uploadBlob).toHaveBeenCalledTimes(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("presign forwards mime/size/sha256 + returns { put_url, attachment_id }", async () => {
    const presignBlob = vi.fn().mockResolvedValue({
      attachment_id: "att_pre",
      upload_url: "https://storage.example/att_pre?sig=x",
      expires_at: "2030-01-01T00:00:00.000Z",
    });
    const res = await tool("attachments").handler(fakeClient({ presignBlob }), {
      action: "presign",
      mime: "video/mp4",
      size: 1048576,
      sha256: "a".repeat(64),
      scope: "agent",
    });
    expect(res.isError).toBeUndefined();
    expect(presignBlob).toHaveBeenCalledWith({
      mime: "video/mp4",
      size: 1048576,
      sha256: "a".repeat(64),
      scope: "agent",
      appId: undefined,
      filename: undefined,
    });
    const body = JSON.parse(res.content[0]!.text);
    // Surfaced as put_url, the name the flow docs use for the out-of-band PUT.
    expect(body.put_url).toBe("https://storage.example/att_pre?sig=x");
    expect(body.attachment_id).toBe("att_pre");
    expect(body.expires_at).toBe("2030-01-01T00:00:00.000Z");
  });

  it("presign requires mime, size, and sha256", async () => {
    const presignBlob = vi.fn();
    const res = await tool("attachments").handler(
      fakeClient({ presignBlob }),
      { action: "presign", mime: "video/mp4" }, // missing size + sha256
    );
    expect(res.isError).toBe(true);
    expect(presignBlob).not.toHaveBeenCalled();
  });

  it("presign rejects scope=app without app_id", async () => {
    const presignBlob = vi.fn();
    const res = await tool("attachments").handler(fakeClient({ presignBlob }), {
      action: "presign",
      mime: "video/mp4",
      size: 100,
      sha256: "b".repeat(64),
      scope: "app",
    });
    expect(res.isError).toBe(true);
    expect(presignBlob).not.toHaveBeenCalled();
  });

  it("finalize forwards the attachment_id to finalizeBlob", async () => {
    const finalizeBlob = vi
      .fn()
      .mockResolvedValue({ attachment_id: "att_pre", status: "ready" });
    const res = await tool("attachments").handler(
      fakeClient({ finalizeBlob }),
      { action: "finalize", attachment_id: "att_pre" },
    );
    expect(res.isError).toBeUndefined();
    expect(finalizeBlob).toHaveBeenCalledWith("att_pre");
    const body = JSON.parse(res.content[0]!.text);
    expect(body.status).toBe("ready");
  });

  it("finalize requires attachment_id", async () => {
    const finalizeBlob = vi.fn();
    const res = await tool("attachments").handler(
      fakeClient({ finalizeBlob }),
      { action: "finalize" },
    );
    expect(res.isError).toBe(true);
    expect(finalizeBlob).not.toHaveBeenCalled();
  });

  it("download returns base64 when no out_path", async () => {
    const bytes = new TextEncoder().encode("hello");
    const downloadBlob = vi.fn().mockResolvedValue(bytes.buffer);
    const res = await tool("attachments").handler(
      fakeClient({ downloadBlob }),
      {
        action: "download",
        attachment_id: "att_1",
      },
    );
    const body = JSON.parse(res.content[0]!.text);
    expect(Buffer.from(body.base64, "base64").toString("utf8")).toBe("hello");
  });

  it("download rejects out_path (no filesystem write) when env.hostFsReads is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-download-deny-"));
    const outPath = join(dir, "out.bin");
    const bytes = new TextEncoder().encode("hello");
    const downloadBlob = vi.fn().mockResolvedValue(bytes.buffer);
    const res = await tool("attachments").handler(
      fakeClient({ downloadBlob }),
      { action: "download", attachment_id: "att_1", out_path: outPath },
      { hostFsReads: false },
    );
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.message).toContain("out_path is not available");
    expect(body.message).toContain("base64");
    // No file must be written to the relay host.
    expect(existsSync(outPath)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("download still writes out_path when env.hostFsReads is explicitly true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-download-allow-"));
    const outPath = join(dir, "out.bin");
    const bytes = new TextEncoder().encode("hello");
    const downloadBlob = vi.fn().mockResolvedValue(bytes.buffer);
    const res = await tool("attachments").handler(
      fakeClient({ downloadBlob }),
      { action: "download", attachment_id: "att_1", out_path: outPath },
      { hostFsReads: true },
    );
    expect(res.isError).toBeUndefined();
    expect(readFileSync(outPath, "utf8")).toBe("hello");
    rmSync(dir, { recursive: true, force: true });
  });

  it("mint_token forwards ttl + once", async () => {
    const mintBlobToken = vi.fn().mockResolvedValue({ token: "t" });
    await tool("attachments").handler(fakeClient({ mintBlobToken }), {
      action: "mint_token",
      attachment_id: "att_1",
      ttl_seconds: 60,
      once: true,
    });
    expect(mintBlobToken).toHaveBeenCalledWith("att_1", {
      ttlSeconds: 60,
      once: true,
    });
  });
});

describe("taste / key / feedback / agent tools", () => {
  it("taste set rejects empty notes", async () => {
    const setTaste = vi.fn();
    const res = await tool("taste").handler(fakeClient({ setTaste }), {
      action: "set",
      taste: "   ",
    });
    expect(res.isError).toBe(true);
    expect(setTaste).not.toHaveBeenCalled();
  });

  it("taste clear returns cleared", async () => {
    const clearTaste = vi.fn().mockResolvedValue(undefined);
    const res = await tool("taste").handler(fakeClient({ clearTaste }), {
      action: "clear",
    });
    expect(JSON.parse(res.content[0]!.text).cleared).toBe(true);
  });

  it("key revoke requires confirm", async () => {
    const listKeys = vi.fn().mockResolvedValue({ agent_id: "ag_1" });
    const revokeKey = vi.fn().mockResolvedValue(undefined);
    const blocked = await tool("key").handler(
      fakeClient({ listKeys, revokeKey }),
      { action: "revoke" },
    );
    expect(blocked.isError).toBe(true);
    expect(revokeKey).not.toHaveBeenCalled();

    await tool("key").handler(fakeClient({ listKeys, revokeKey }), {
      action: "revoke",
      confirm: true,
    });
    expect(revokeKey).toHaveBeenCalledWith("ag_1");
  });

  it("key mint calls mintKey and returns the once-only sibling key", async () => {
    const mintKey = vi.fn().mockResolvedValue({
      agent_id: "agt_sibling",
      api_key: "hs_deadbeef",
      key_prefix: "hs_deadb",
      name: "agent",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    const res = await tool("key").handler(fakeClient({ mintKey }), {
      action: "mint",
    });
    expect(res.isError).toBeUndefined();
    expect(mintKey).toHaveBeenCalledTimes(1);
    // mintKey takes no target argument — it can only ever mint for the caller.
    expect(mintKey).toHaveBeenCalledWith();
    const body = JSON.parse(res.content[0]!.text);
    expect(body.agent_id).toBe("agt_sibling");
    expect(body.api_key).toBe("hs_deadbeef");
  });

  it("feedback create requires type + message", async () => {
    const submitFeedback = vi.fn();
    const res = await tool("feedback").handler(fakeClient({ submitFeedback }), {
      action: "create",
      type: "bug",
    });
    expect(res.isError).toBe(true);
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it("agent whoami needs no client and no network", async () => {
    const res = await tool("agent").handler(fakeClient({}), {
      action: "whoami",
    });
    const body = JSON.parse(res.content[0]!.text);
    expect(typeof body.url).toBe("string");
    expect("api_key_present" in body).toBe(true);
  });

  it("agent claim forwards the code", async () => {
    const claimAgent = vi
      .fn()
      .mockResolvedValue({ ok: true, owner_human_id: "h1" });
    await tool("agent").handler(fakeClient({ claimAgent }), {
      action: "claim",
      code: "abc123",
    });
    expect(claimAgent).toHaveBeenCalledWith("abc123");
  });
});

// ---------------------------------------------------------------------------
// v2 app lifecycle + data tools (deploy_app, row CRUD, get_feed_events, apps)
// ---------------------------------------------------------------------------

describe("deploy_app tool", () => {
  it("creates when app_id is omitted", async () => {
    const deployApp = vi.fn().mockResolvedValue({
      app_id: "app_1",
      slug: "grocery-x7k2m9",
      visibility: "private",
      url: "https://grocery-x7k2m9.homespunapps.com/",
      version: 1,
      created: true,
    });
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html: "<html></html>",
      manifest: { "x-homespun-manifest": { app: { name: "Grocery" } } },
    });
    expect(deployApp).toHaveBeenCalledWith({
      html: "<html></html>",
      manifest: { "x-homespun-manifest": { app: { name: "Grocery" } } },
      visibility: undefined,
      slug: undefined,
    });
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({
      app_id: "app_1",
      created: true,
    });
  });

  it("allows a slug with omitted visibility (resolves to private, which accepts an owner-chosen slug)", async () => {
    const deployApp = vi.fn().mockResolvedValue({
      app_id: "app_1",
      slug: "my-slug",
      visibility: "private",
      url: "https://my-slug.homespunapps.com/",
      version: 1,
      created: true,
    });
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html: "<html></html>",
      manifest: {},
      slug: "my-slug",
    });
    expect(res.isError).toBeUndefined();
    expect(deployApp).toHaveBeenCalledWith({
      html: "<html></html>",
      manifest: {},
      visibility: undefined,
      slug: "my-slug",
    });
  });

  it("rejects a slug together with explicit visibility 'link'", async () => {
    const deployApp = vi.fn();
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html: "<html></html>",
      manifest: {},
      visibility: "link",
      slug: "my-slug",
    });
    expect(res.isError).toBe(true);
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("redeploys when app_id is given", async () => {
    const redeployApp = vi
      .fn()
      .mockResolvedValue({ app_id: "app_1", version: 2, compat: "clean" });
    const res = await tool("deploy_app").handler(fakeClient({ redeployApp }), {
      app_id: "app_1",
      html: "<html>v2</html>",
      manifest: {},
      force: true,
    });
    expect(redeployApp).toHaveBeenCalledWith("app_1", {
      html: "<html>v2</html>",
      manifest: {},
      force: true,
    });
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      app_id: "app_1",
      version: 2,
      compat: "clean",
    });
  });

  it("rejects slug/visibility on redeploy", async () => {
    const redeployApp = vi.fn();
    const res = await tool("deploy_app").handler(fakeClient({ redeployApp }), {
      app_id: "app_1",
      html: "<html></html>",
      manifest: {},
      visibility: "public",
    });
    expect(res.isError).toBe(true);
    expect(redeployApp).not.toHaveBeenCalled();
  });

  // Defense in depth: a harness that stringifies the manifest object still works.
  it("accepts a stringified-JSON manifest object (parses it before the relay)", async () => {
    const deployApp = vi
      .fn()
      .mockResolvedValue({ app_id: "app_1", created: true });
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html: "<html></html>",
      manifest: JSON.stringify({ app: { name: "Grocery" } }),
    });
    expect(res.isError).toBeUndefined();
    expect(deployApp).toHaveBeenCalledWith({
      html: "<html></html>",
      manifest: { app: { name: "Grocery" } },
      visibility: undefined,
      slug: undefined,
    });
  });

  it("rejects a manifest string that is not valid JSON with invalid_args", async () => {
    const deployApp = vi.fn();
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html: "<html></html>",
      manifest: "not json at all",
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error).toBe("invalid_args");
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("still accepts a proper manifest object unchanged", async () => {
    const deployApp = vi
      .fn()
      .mockResolvedValue({ app_id: "app_1", created: true });
    await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html: "<html></html>",
      manifest: { app: { name: "Grocery" } },
    });
    expect(deployApp).toHaveBeenCalledWith({
      html: "<html></html>",
      manifest: { app: { name: "Grocery" } },
      visibility: undefined,
      slug: undefined,
    });
  });

  it("reads html_path from the MCP-server host and deploys its contents inline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-deploy-"));
    const htmlPath = join(dir, "index.html");
    writeFileSync(htmlPath, "<html>from-disk</html>");
    const deployApp = vi
      .fn()
      .mockResolvedValue({ app_id: "app_1", created: true });
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html_path: htmlPath,
      manifest: {},
    });
    expect(res.isError).toBeUndefined();
    expect(deployApp).toHaveBeenCalledWith({
      html: "<html>from-disk</html>",
      manifest: {},
      visibility: undefined,
      slug: undefined,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("inline html wins when both html and html_path are given (no filesystem read)", async () => {
    const deployApp = vi
      .fn()
      .mockResolvedValue({ app_id: "app_1", created: true });
    // html_path points nowhere; if the handler read it, it would error. Inline
    // html winning proves html_path is never touched here.
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html: "<html>inline</html>",
      html_path: "/nonexistent/does-not-exist.html",
      manifest: {},
    });
    expect(res.isError).toBeUndefined();
    expect(deployApp).toHaveBeenCalledWith({
      html: "<html>inline</html>",
      manifest: {},
      visibility: undefined,
      slug: undefined,
    });
  });

  it("errors clearly when neither html nor html_path is given", async () => {
    const deployApp = vi.fn();
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      manifest: {},
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("html");
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("an unreadable html_path errors with the relay-host filesystem caveat", async () => {
    const deployApp = vi.fn();
    const res = await tool("deploy_app").handler(fakeClient({ deployApp }), {
      html_path: "/nonexistent/does-not-exist.html",
      manifest: {},
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.message).toContain("html_path is read on the MCP server");
    expect(body.message).toContain("pass the HTML inline");
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("rejects html_path (no filesystem read) when env.hostFsReads is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-deploy-deny-"));
    const htmlPath = join(dir, "secret.html");
    writeFileSync(htmlPath, "<html>SECRET</html>");
    const deployApp = vi.fn();
    const res = await tool("deploy_app").handler(
      fakeClient({ deployApp }),
      { html_path: htmlPath, manifest: {} },
      { hostFsReads: false },
    );
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0]!.text);
    expect(body.message).toContain("html_path is not available");
    expect(body.message).toContain("`html`");
    // The file exists and is readable, but the guard must short-circuit BEFORE
    // any read, so the deploy never happens.
    expect(deployApp).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("still reads html_path when env.hostFsReads is explicitly true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-deploy-allow-"));
    const htmlPath = join(dir, "index.html");
    writeFileSync(htmlPath, "<html>from-disk</html>");
    const deployApp = vi
      .fn()
      .mockResolvedValue({ app_id: "app_1", created: true });
    const res = await tool("deploy_app").handler(
      fakeClient({ deployApp }),
      { html_path: htmlPath, manifest: {} },
      { hostFsReads: true },
    );
    expect(res.isError).toBeUndefined();
    expect(deployApp).toHaveBeenCalledWith({
      html: "<html>from-disk</html>",
      manifest: {},
      visibility: undefined,
      slug: undefined,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("dry_run:true on a create routes to checkDeploy, not deployApp", async () => {
    const checkDeploy = vi.fn().mockResolvedValue({ ok: true, warnings: [] });
    const deployApp = vi.fn();
    const res = await tool("deploy_app").handler(
      fakeClient({ checkDeploy, deployApp }),
      { html: "<html></html>", manifest: {}, dry_run: true },
    );
    expect(res.isError).toBeUndefined();
    expect(checkDeploy).toHaveBeenCalledWith({
      html: "<html></html>",
      manifest: {},
      assets: undefined,
    });
    expect(deployApp).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0]!.text).ok).toBe(true);
  });

  it("check:true (alias) on a redeploy routes to checkDeploy with the app id + force", async () => {
    const checkDeploy = vi.fn().mockResolvedValue({
      ok: false,
      warnings: [],
      compat: "incompatible",
      breaks: [{ path: "collections.old", message: "removed" }],
    });
    const redeployApp = vi.fn();
    const res = await tool("deploy_app").handler(
      fakeClient({ checkDeploy, redeployApp }),
      {
        app_id: "app_1",
        html: "<html>v2</html>",
        manifest: {},
        check: true,
      },
    );
    expect(res.isError).toBeUndefined();
    expect(checkDeploy).toHaveBeenCalledWith({
      app_id: "app_1",
      html: "<html>v2</html>",
      manifest: {},
      force: undefined,
      assets: undefined,
    });
    expect(redeployApp).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0]!.text).compat).toBe("incompatible");
  });
});

describe("row CRUD tools", () => {
  it("list_rows forwards since/limit", async () => {
    const listAppRows = vi
      .fn()
      .mockResolvedValue({ rows: [], next_cursor: null, has_more: false });
    await tool("list_rows").handler(fakeClient({ listAppRows }), {
      app_id: "app_1",
      collection: "items",
      since: "c1",
      limit: 10,
    });
    expect(listAppRows).toHaveBeenCalledWith("app_1", "items", {
      since: "c1",
      limit: 10,
    });
  });

  it("get_row fetches a single row via the dedicated route", async () => {
    const getAppRow = vi
      .fn()
      .mockResolvedValue({ row: { key: "milk", data: { name: "Milk" } } });
    const res = await tool("get_row").handler(fakeClient({ getAppRow }), {
      app_id: "app_1",
      collection: "items",
      key: "milk",
    });
    expect(getAppRow).toHaveBeenCalledWith("app_1", "items", "milk");
    expect(JSON.parse(res.content[0]!.text).row.key).toBe("milk");
  });

  it("upsert_row passes key through and reports deduped", async () => {
    const upsertAppRow = vi
      .fn()
      .mockResolvedValue({ row: { key: "milk" }, deduped: true });
    const res = await tool("upsert_row").handler(fakeClient({ upsertAppRow }), {
      app_id: "app_1",
      collection: "items",
      key: "milk",
      data: { name: "Milk" },
    });
    expect(upsertAppRow).toHaveBeenCalledWith("app_1", "items", {
      key: "milk",
      data: { name: "Milk" },
    });
    expect(JSON.parse(res.content[0]!.text).deduped).toBe(true);
  });

  it("update_row forwards data + if_match", async () => {
    const updateAppRow = vi
      .fn()
      .mockResolvedValue({ row: { key: "milk", version: 2 } });
    await tool("update_row").handler(fakeClient({ updateAppRow }), {
      app_id: "app_1",
      collection: "items",
      key: "milk",
      data: { name: "Whole Milk" },
      if_match: 1,
    });
    expect(updateAppRow).toHaveBeenCalledWith("app_1", "items", "milk", {
      data: { name: "Whole Milk" },
      if_match: 1,
    });
  });

  it("upsert_row parses a stringified-JSON data object before the relay", async () => {
    const upsertAppRow = vi.fn().mockResolvedValue({ row: { key: "milk" } });
    await tool("upsert_row").handler(fakeClient({ upsertAppRow }), {
      app_id: "app_1",
      collection: "items",
      data: JSON.stringify({ name: "Milk" }),
    });
    expect(upsertAppRow).toHaveBeenCalledWith("app_1", "items", {
      data: { name: "Milk" },
    });
  });

  it("update_row rejects a data string that is not valid JSON with invalid_args", async () => {
    const updateAppRow = vi.fn();
    const res = await tool("update_row").handler(fakeClient({ updateAppRow }), {
      app_id: "app_1",
      collection: "items",
      key: "milk",
      data: "definitely not json",
    });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0]!.text).error).toBe("invalid_args");
    expect(updateAppRow).not.toHaveBeenCalled();
  });

  it("delete_row returns { deleted: true, key }", async () => {
    const deleteAppRow = vi.fn().mockResolvedValue(undefined);
    const res = await tool("delete_row").handler(fakeClient({ deleteAppRow }), {
      app_id: "app_1",
      collection: "items",
      key: "milk",
    });
    expect(deleteAppRow).toHaveBeenCalledWith("app_1", "items", "milk", {});
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      deleted: true,
      key: "milk",
    });
  });
});

describe("get_feed_events tool", () => {
  it("forwards since/limit/wait and returns the page", async () => {
    const getAppFeed = vi.fn().mockResolvedValue({
      entries: [{ seq: 1, op: "create" }],
      cursor: 1,
      truncated: false,
    });
    const res = await tool("get_feed_events").handler(
      fakeClient({ getAppFeed }),
      { app_id: "app_1", since: 0, wait: 25 },
    );
    expect(getAppFeed).toHaveBeenCalledWith("app_1", {
      since: 0,
      limit: undefined,
      wait: 25,
    });
    expect(JSON.parse(res.content[0]!.text).cursor).toBe(1);
  });

  it("defaults since to 0 when omitted", async () => {
    const getAppFeed = vi
      .fn()
      .mockResolvedValue({ entries: [], cursor: 0, truncated: false });
    await tool("get_feed_events").handler(fakeClient({ getAppFeed }), {
      app_id: "app_1",
    });
    expect(getAppFeed).toHaveBeenCalledWith("app_1", {
      since: 0,
      limit: undefined,
      wait: undefined,
    });
  });
});

describe("apps tool actions", () => {
  it("list forwards status/limit/cursor/slug", async () => {
    const listApps = vi
      .fn()
      .mockResolvedValue({ items: [], next_cursor: null });
    await tool("apps").handler(fakeClient({ listApps }), {
      action: "list",
      status: "active",
      limit: 10,
    });
    expect(listApps).toHaveBeenCalledWith({ status: "active", limit: 10 });
  });

  it("show requires app_id", async () => {
    const getApp = vi.fn();
    const res = await tool("apps").handler(fakeClient({ getApp }), {
      action: "show",
    });
    expect(res.isError).toBe(true);
    expect(getApp).not.toHaveBeenCalled();
  });

  it("show forwards app_id", async () => {
    const getApp = vi.fn().mockResolvedValue({ id: "app_1", slug: "s" });
    await tool("apps").handler(fakeClient({ getApp }), {
      action: "show",
      app_id: "app_1",
    });
    expect(getApp).toHaveBeenCalledWith("app_1");
  });

  it("update requires visibility or timezone", async () => {
    const updateApp = vi.fn();
    const res = await tool("apps").handler(fakeClient({ updateApp }), {
      action: "update",
      app_id: "app_1",
    });
    expect(res.isError).toBe(true);
    expect(updateApp).not.toHaveBeenCalled();
  });

  it("update forwards app_id + visibility", async () => {
    const updateApp = vi.fn().mockResolvedValue({
      id: "app_1",
      visibility: "private",
      timezone: null,
    });
    await tool("apps").handler(fakeClient({ updateApp }), {
      action: "update",
      app_id: "app_1",
      visibility: "private",
    });
    expect(updateApp).toHaveBeenCalledWith("app_1", { visibility: "private" });
  });

  it("update forwards a timezone-only change", async () => {
    const updateApp = vi.fn().mockResolvedValue({
      id: "app_1",
      visibility: "private",
      timezone: "Europe/Berlin",
    });
    await tool("apps").handler(fakeClient({ updateApp }), {
      action: "update",
      app_id: "app_1",
      timezone: "Europe/Berlin",
    });
    expect(updateApp).toHaveBeenCalledWith("app_1", {
      timezone: "Europe/Berlin",
    });
  });

  it("delete returns { app_id, deleted: true }", async () => {
    const deleteApp = vi.fn().mockResolvedValue(undefined);
    const res = await tool("apps").handler(fakeClient({ deleteApp }), {
      action: "delete",
      app_id: "app_1",
    });
    expect(deleteApp).toHaveBeenCalledWith("app_1");
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      app_id: "app_1",
      deleted: true,
    });
  });

  it("wake forwards app_id", async () => {
    const wakeApp = vi
      .fn()
      .mockResolvedValue({ id: "app_1", status: "active" });
    await tool("apps").handler(fakeClient({ wakeApp }), {
      action: "wake",
      app_id: "app_1",
    });
    expect(wakeApp).toHaveBeenCalledWith("app_1");
  });

  it("rejects an unknown action", async () => {
    const res = await tool("apps").handler(fakeClient({}), {
      action: "bogus",
    });
    expect(res.isError).toBe(true);
  });
});

describe("members tool actions", () => {
  it("add forwards app_id + email (member response shape)", async () => {
    const addAppMember = vi.fn().mockResolvedValue({
      member: {
        humanId: "hum_1",
        email: "a@b.test",
        role: "member",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const res = await tool("members").handler(fakeClient({ addAppMember }), {
      action: "add",
      app_id: "app_1",
      email: "a@b.test",
    });
    expect(addAppMember).toHaveBeenCalledWith("app_1", { email: "a@b.test" });
    expect(JSON.parse(res.content[0]!.text).member.humanId).toBe("hum_1");
  });

  it("add forwards --role and returns the invited shape", async () => {
    const addAppMember = vi.fn().mockResolvedValue({
      ok: true,
      invited: "new@b.test",
      expires_at: "2026-01-08T00:00:00.000Z",
    });
    await tool("members").handler(fakeClient({ addAppMember }), {
      action: "add",
      app_id: "app_1",
      email: "new@b.test",
      role: "member",
    });
    expect(addAppMember).toHaveBeenCalledWith("app_1", {
      email: "new@b.test",
      role: "member",
    });
  });

  it("add requires email", async () => {
    const addAppMember = vi.fn();
    const res = await tool("members").handler(fakeClient({ addAppMember }), {
      action: "add",
      app_id: "app_1",
    });
    expect(res.isError).toBe(true);
    expect(addAppMember).not.toHaveBeenCalled();
  });

  it("surfaces the relay 503 (EMAIL_PROVIDER=none) as an error result", async () => {
    const addAppMember = vi
      .fn()
      .mockRejectedValue(
        new HomespunApiError(
          503,
          "auth_provider_unavailable",
          "no email provider",
        ),
      );
    const res = await tool("members").handler(fakeClient({ addAppMember }), {
      action: "add",
      app_id: "app_1",
      email: "new@b.test",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("auth_provider_unavailable");
  });

  it("list forwards app_id", async () => {
    const listAppMembers = vi.fn().mockResolvedValue({ members: [] });
    await tool("members").handler(fakeClient({ listAppMembers }), {
      action: "list",
      app_id: "app_1",
    });
    expect(listAppMembers).toHaveBeenCalledWith("app_1");
  });

  it("roles forwards app_id and returns the summary", async () => {
    const listAppRoles = vi.fn().mockResolvedValue({
      roles: [
        {
          name: "reviewer",
          label: "Reviewer",
          description: null,
          collections: [
            {
              name: "submissions",
              member_access: {
                read: "all",
                create: "all",
                update: "none",
                delete: "own",
              },
              grant_access: {
                read: "own",
                create: "all",
                update: "none",
                delete: "own",
              },
              append_only: false,
            },
          ],
          member_count: 3,
          active_grant_count: 7,
        },
      ],
    });
    const res = await tool("members").handler(fakeClient({ listAppRoles }), {
      action: "roles",
      app_id: "app_1",
    });
    expect(listAppRoles).toHaveBeenCalledWith("app_1");
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed.roles[0].member_count).toBe(3);
    expect(parsed.roles[0].collections[0].grant_access.read).toBe("own");
  });

  it("remove requires human_id and returns a receipt", async () => {
    const removeAppMember = vi.fn().mockResolvedValue(undefined);
    const blocked = await tool("members").handler(
      fakeClient({ removeAppMember }),
      { action: "remove", app_id: "app_1" },
    );
    expect(blocked.isError).toBe(true);
    expect(removeAppMember).not.toHaveBeenCalled();

    const res = await tool("members").handler(fakeClient({ removeAppMember }), {
      action: "remove",
      app_id: "app_1",
      human_id: "hum_2",
    });
    expect(removeAppMember).toHaveBeenCalledWith("app_1", "hum_2");
    expect(JSON.parse(res.content[0]!.text)).toEqual({
      app_id: "app_1",
      human_id: "hum_2",
      removed: true,
    });
  });

  it("surfaces the owner-cannot-be-removed 409 as an error result", async () => {
    const removeAppMember = vi
      .fn()
      .mockRejectedValue(
        new HomespunApiError(409, "conflict", "cannot remove the app owner"),
      );
    const res = await tool("members").handler(fakeClient({ removeAppMember }), {
      action: "remove",
      app_id: "app_1",
      human_id: "hum_owner",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain("owner");
  });

  it("requires app_id for every action", async () => {
    const res = await tool("members").handler(fakeClient({}), {
      action: "list",
    });
    expect(res.isError).toBe(true);
  });

  it("rejects an unknown action", async () => {
    const res = await tool("members").handler(fakeClient({}), {
      action: "bogus",
      app_id: "app_1",
    });
    expect(res.isError).toBe(true);
  });
});

describe("v2 tool schema validation", () => {
  it("deploy_app requires manifest; html is optional at the schema level (html/html_path enforced by the handler)", () => {
    const schema = z.object(tool("deploy_app").inputSchema);
    // manifest is still required by the schema.
    expect(schema.safeParse({ html: "<html></html>" }).success).toBe(false);
    // html is now OPTIONAL at the schema level (an html_path-only call is valid
    // to the SDK); the handler enforces "html or html_path".
    expect(
      schema.safeParse({ manifest: {}, html_path: "/abs/index.html" }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ html: "<html></html>", manifest: {} }).success,
    ).toBe(true);
  });

  it("get_feed_events caps wait at 30", () => {
    const schema = z.object(tool("get_feed_events").inputSchema);
    expect(schema.safeParse({ app_id: "a", wait: 25 }).success).toBe(true);
    expect(schema.safeParse({ app_id: "a", wait: 60 }).success).toBe(false);
  });

  it("apps requires a valid action enum value", () => {
    const schema = z.object(tool("apps").inputSchema);
    expect(schema.safeParse({ action: "list" }).success).toBe(true);
    expect(schema.safeParse({ action: "bogus" }).success).toBe(false);
  });
});

describe("community publish PII warning (marketplace PR 10)", () => {
  // The publishing agent reads these schema strings, so the PII warning must be
  // impossible to miss: it lives on the tool preamble, the publish action
  // description, AND the attest_example_only field description.
  it("warns that content + seed rows become public in the tool + action + field descriptions", () => {
    const t = tool("community");
    const preamble = t.description.toLowerCase();
    expect(preamble).toContain("public");
    expect(preamble).toContain("seed rows");
    expect(preamble).toContain("attest_example_only");

    const actionDoc = (
      t.inputSchema["action"] as { description?: string }
    ).description?.toLowerCase();
    expect(actionDoc).toContain("public");
    expect(actionDoc).toContain("seed rows");
    expect(actionDoc).toContain("personal data");
    expect(actionDoc).toContain("example-only");

    const attestDoc = (
      t.inputSchema["attest_example_only"] as { description?: string }
    ).description?.toLowerCase();
    expect(attestDoc).toContain("public");
    expect(attestDoc).toContain("no real personal data");
  });

  it("passes attest_example_only through to the publish client call", async () => {
    const publishCommunityTemplate = vi.fn().mockResolvedValue({
      snapshot_id: "s1",
      review_status: "pending",
      attest_example_only: true,
    });
    const client = fakeClient({ publishCommunityTemplate });
    await tool("community").handler(client, {
      action: "publish",
      app_id: "app1",
      attest_example_only: true,
    });
    expect(publishCommunityTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ appId: "app1", attestExampleOnly: true }),
    );
  });

  it("omits attestExampleOnly when the attestation arg is absent", async () => {
    const publishCommunityTemplate = vi.fn().mockResolvedValue({
      snapshot_id: "s2",
      review_status: "pending",
      attest_example_only: null,
    });
    const client = fakeClient({ publishCommunityTemplate });
    await tool("community").handler(client, {
      action: "publish",
      app_id: "app2",
    });
    const arg = publishCommunityTemplate.mock.calls[0]![0] as {
      attestExampleOnly?: boolean;
    };
    expect(arg.attestExampleOnly).toBeUndefined();
  });
});
