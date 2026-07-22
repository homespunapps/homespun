// Unit tests for HomespunClient.call, exercised through the `fetch` override.

import { describe, it, expect } from "vitest";
import { HomespunClient, HomespunApiError } from "./client.js";

/** Build a client with a stubbed fetch. */
function clientWith(fetchImpl: typeof fetch): HomespunClient {
  return new HomespunClient({
    url: "https://relay.test/",
    apiKey: "k_test",
    fetch: fetchImpl,
  });
}

/** Minimal Response-like stub for the fields HomespunClient.call reads. */
function res(opts: { status: number; ok?: boolean; body?: string }): Response {
  return {
    status: opts.status,
    ok: opts.ok ?? (opts.status >= 200 && opts.status < 300),
    text: async () => opts.body ?? "",
  } as unknown as Response;
}

describe("HomespunClient.call", () => {
  it("parses a 2xx JSON body", async () => {
    const c = clientWith(async () =>
      res({ status: 200, body: JSON.stringify({ hello: "world" }) }),
    );
    const r = await c.call("GET", "/v1/x");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.data).toEqual({ hello: "world" });
  });

  it("handles a 204 with no body", async () => {
    const c = clientWith(async () => res({ status: 204 }));
    const r = await c.call("DELETE", "/v1/x");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(204);
    expect(r.data).toBeNull();
  });

  it("returns status 0 on a network failure", async () => {
    const c = clientWith(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await c.call("GET", "/v1/x");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect((r.data as { error: { code: string } }).error.code).toBe(
      "fetch_error",
    );
    expect((r.data as { error: { message: string } }).error.message).toContain(
      "ECONNREFUSED",
    );
  });

  it("captures a non-JSON body instead of discarding it", async () => {
    const c = clientWith(async () =>
      res({ status: 502, ok: false, body: "<html>Bad Gateway</html>" }),
    );
    const r = await c.call("GET", "/v1/x");
    expect(r.ok).toBe(false);
    const err = (
      r.data as { error: { code: string; details: { body: string } } }
    ).error;
    expect(err.code).toBe("non_json_response");
    expect(err.details.body).toContain("Bad Gateway");
  });

  it("sends bearer auth and JSON content-type when a body is present", async () => {
    let seen: RequestInit | undefined;
    const c = clientWith(async (_url, init) => {
      seen = init;
      return res({ status: 200, body: "{}" });
    });
    await c.call("POST", "/v1/x", { a: 1 });
    const headers = seen!.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer k_test");
    expect(headers["content-type"]).toBe("application/json");
    expect(seen!.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("sends x-homespun-cli-version when cliVersion is supplied", async () => {
    // Drives the relay's version-skew check. The CLI passes its own VERSION
    // here so a relay can return 426 cli_upgrade_required when the CLI is
    // too old to talk to it.
    let seen: RequestInit | undefined;
    const c = new HomespunClient({
      url: "https://relay.test/",
      apiKey: "k_test",
      cliVersion: "0.0.5",
      fetch: async (_url, init) => {
        seen = init;
        return res({ status: 200, body: "{}" });
      },
    });
    await c.call("GET", "/v1/x");
    const headers = seen!.headers as Record<string, string>;
    expect(headers["x-homespun-cli-version"]).toBe("0.0.5");
  });

  it("omits x-homespun-cli-version when cliVersion is not supplied", async () => {
    // The header MUST be absent (not "" or "unknown") when no version was
    // passed — the relay distinguishes "old CLI" from "library / non-CLI
    // caller" by header presence.
    let seen: RequestInit | undefined;
    const c = clientWith(async (_url, init) => {
      seen = init;
      return res({ status: 200, body: "{}" });
    });
    await c.call("GET", "/v1/x");
    const headers = seen!.headers as Record<string, string>;
    expect("x-homespun-cli-version" in headers).toBe(false);
  });
});

describe("HomespunClient typed operations", () => {
  it("throws HomespunApiError on a non-2xx response", async () => {
    const c = clientWith(async () =>
      res({
        status: 404,
        ok: false,
        body: JSON.stringify({ error: { code: "not_found", message: "nope" } }),
      }),
    );
    await expect(c.listKeys()).rejects.toMatchObject({
      name: "HomespunApiError",
      status: 404,
      code: "not_found",
    });
  });

  it("populates hint/retryable/docsUrl from the relay error envelope", async () => {
    const c = clientWith(async () =>
      res({
        status: 429,
        ok: false,
        body: JSON.stringify({
          error: {
            code: "rate_limited",
            message: "slow down",
            hint: "wait and retry",
            retryable: true,
            docs_url: "https://example.test/docs#rate",
          },
        }),
      }),
    );
    const err = await c.listKeys().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HomespunApiError);
    const e = err as HomespunApiError;
    expect(e.code).toBe("rate_limited");
    expect(e.hint).toBe("wait and retry");
    expect(e.retryable).toBe(true);
    expect(e.docsUrl).toBe("https://example.test/docs#rate");
  });

  it("leaves the new fields undefined when the relay omits them", async () => {
    const c = clientWith(async () =>
      res({
        status: 404,
        ok: false,
        body: JSON.stringify({ error: { code: "not_found" } }),
      }),
    );
    const err = (await c
      .listKeys()
      .catch((e: unknown) => e)) as HomespunApiError;
    expect(err.hint).toBeUndefined();
    expect(err.retryable).toBeUndefined();
    expect(err.docsUrl).toBeUndefined();
  });

  it("throws invalid_response when a 2xx body is not an object", async () => {
    const c = clientWith(async () => res({ status: 200, body: "null" }));
    await expect(c.listKeys()).rejects.toBeInstanceOf(HomespunApiError);
    await expect(c.listKeys()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("returns the parsed body on success", async () => {
    const c = clientWith(async () =>
      res({
        status: 200,
        body: JSON.stringify({ agent_id: "ag_x", name: "Test" }),
      }),
    );
    const s = await c.listKeys();
    expect(s.agent_id).toBe("ag_x");
  });
});

describe("HomespunClient app-member operations", () => {
  /** Capture the request method/path/body of a single call. */
  function capturingClient(body: string, status = 200) {
    let seen: { method: string; url: string; body: unknown } | undefined;
    const c = clientWith(async (url, init) => {
      seen = {
        method: (init?.method as string) ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      return res({ status, body });
    });
    return { c, seen: () => seen! };
  }

  it("addAppMember POSTs /v1/apps/:id/members and returns the member shape", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({
        member: {
          humanId: "hum_1",
          email: "a@b.test",
          role: "member",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    const out = await c.addAppMember("app_1", { email: "a@b.test" });
    expect(out).toEqual({
      member: {
        humanId: "hum_1",
        email: "a@b.test",
        role: "member",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(seen().method).toBe("POST");
    expect(seen().url).toBe("https://relay.test/v1/apps/app_1/members");
    expect(seen().body).toEqual({
      email: "a@b.test",
      role: undefined,
      custom_role: undefined,
    });
  });

  it("addAppMember passes an optional custom_role through to the body", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({
        member: {
          humanId: "hum_1",
          email: "a@b.test",
          role: "member",
          customRole: "editor",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    await c.addAppMember("app_1", { email: "a@b.test", customRole: "editor" });
    expect(seen().body).toEqual({
      email: "a@b.test",
      role: undefined,
      custom_role: "editor",
    });
  });

  it("addAppMember returns the invited-magic-link shape (202) when no human exists", async () => {
    // The relay returns 202 Accepted for the invite branch (an email is queued,
    // not a member row created) — pin that here so the 2xx contract is the
    // real status, not just "any 2xx asObject happens to accept".
    const { c } = capturingClient(
      JSON.stringify({
        ok: true,
        invited: "new@b.test",
        expires_at: "2026-01-08T00:00:00.000Z",
      }),
      202,
    );
    const out = await c.addAppMember("app_1", {
      email: "new@b.test",
      role: "member",
    });
    expect(out).toEqual({
      ok: true,
      invited: "new@b.test",
      expires_at: "2026-01-08T00:00:00.000Z",
    });
  });

  it("addAppMember surfaces the relay 503 (EMAIL_PROVIDER=none) as a HomespunApiError", async () => {
    const c = clientWith(async () =>
      res({
        status: 503,
        ok: false,
        body: JSON.stringify({
          error: {
            code: "auth_provider_unavailable",
            message: "human-side login is disabled on this relay",
          },
        }),
      }),
    );
    await expect(
      c.addAppMember("app_1", { email: "new@b.test" }),
    ).rejects.toMatchObject({
      name: "HomespunApiError",
      status: 503,
      code: "auth_provider_unavailable",
    });
  });

  it("listAppMembers GETs /v1/apps/:id/members", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({
        members: [{ humanId: "hum_1", email: "a@b.test", role: "owner" }],
      }),
    );
    const out = await c.listAppMembers("app_1");
    expect(out.members).toHaveLength(1);
    expect(out.members[0]!.role).toBe("owner");
    expect(seen().method).toBe("GET");
    expect(seen().url).toBe("https://relay.test/v1/apps/app_1/members");
  });

  it("listAppRoles GETs /v1/apps/:id/roles", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({
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
            member_count: 2,
            active_grant_count: 1,
          },
        ],
      }),
    );
    const out = await c.listAppRoles("app_1");
    expect(out.roles).toHaveLength(1);
    expect(out.roles[0]!.member_count).toBe(2);
    expect(out.roles[0]!.collections[0]!.member_access.read).toBe("all");
    expect(out.roles[0]!.collections[0]!.grant_access.read).toBe("own");
    expect(seen().method).toBe("GET");
    expect(seen().url).toBe("https://relay.test/v1/apps/app_1/roles");
  });

  it("removeAppMember DELETEs /v1/apps/:id/members/:humanId and resolves on 204", async () => {
    const { c, seen } = capturingClient("", 204);
    await expect(c.removeAppMember("app_1", "hum_2")).resolves.toBeUndefined();
    expect(seen().method).toBe("DELETE");
    expect(seen().url).toBe("https://relay.test/v1/apps/app_1/members/hum_2");
  });

  it("removeAppMember surfaces the owner-cannot-be-removed 409 conflict", async () => {
    const c = clientWith(async () =>
      res({
        status: 409,
        ok: false,
        body: JSON.stringify({
          error: {
            code: "conflict",
            message: "cannot remove the app owner",
          },
        }),
      }),
    );
    await expect(c.removeAppMember("app_1", "hum_owner")).rejects.toMatchObject(
      {
        name: "HomespunApiError",
        status: 409,
        code: "conflict",
      },
    );
  });
});

// (The "HomespunClient.createApp" body-passthrough regression describe that
// used to live here was removed along with the rest of the v1 app API.)

describe("HomespunClient key operations", () => {
  /** Capture the request method/path of a single call. */
  function capturingClient(opts: { status: number; body?: string }) {
    let seen: { method: string; url: string } | undefined;
    const c = clientWith(async (url, init) => {
      seen = { method: (init?.method as string) ?? "GET", url: String(url) };
      return res({ status: opts.status, body: opts.body });
    });
    return { c, seen: () => seen! };
  }

  it("listKeys GETs /v1/keys and returns the key info", async () => {
    const { c, seen } = capturingClient({
      status: 200,
      body: JSON.stringify({
        agent_id: "agt_1",
        name: "agent",
        key_prefix: "pk_abc1234",
        created_at: "2026-01-01T00:00:00.000Z",
        last_used_at: null,
        revoked_at: null,
      }),
    });
    const out = await c.listKeys();
    expect(out.agent_id).toBe("agt_1");
    expect(out.key_prefix).toBe("pk_abc1234");
    expect(seen().method).toBe("GET");
    expect(seen().url).toBe("https://relay.test/v1/keys");
  });

  it("revokeKey DELETEs /v1/keys/:id and handles a 204 without throwing", async () => {
    const { c, seen } = capturingClient({ status: 204 });
    await expect(c.revokeKey("agt_1")).resolves.toBeUndefined();
    expect(seen().method).toBe("DELETE");
    expect(seen().url).toBe("https://relay.test/v1/keys/agt_1");
  });

  it("revokeKey throws HomespunApiError on a 403 (revoking another agent's key)", async () => {
    const c = clientWith(async () =>
      res({
        status: 403,
        ok: false,
        body: JSON.stringify({ error: { code: "forbidden" } }),
      }),
    );
    await expect(c.revokeKey("agt_other")).rejects.toMatchObject({
      name: "HomespunApiError",
      status: 403,
      code: "forbidden",
    });
  });

  it("mintKey POSTs /v1/keys and returns the once-only sibling key", async () => {
    const { c, seen } = capturingClient({
      status: 201,
      body: JSON.stringify({
        agent_id: "agt_sibling",
        api_key: "hs_deadbeef",
        key_prefix: "hs_deadb",
        name: "agent",
        created_at: "2026-01-01T00:00:00.000Z",
      }),
    });
    const out = await c.mintKey();
    expect(seen().method).toBe("POST");
    expect(seen().url).toBe("https://relay.test/v1/keys");
    expect(out.agent_id).toBe("agt_sibling");
    expect(out.api_key).toBe("hs_deadbeef");
  });
});

describe("HomespunClient.checkDeploy (dry run)", () => {
  /** Capture method/url/body of one call and return a canned response. */
  function capturing(opts: { status: number; body?: string }) {
    let seen: { method: string; url: string; body: unknown } | undefined;
    const c = clientWith(async (url, init) => {
      seen = {
        method: (init?.method as string) ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      return res({ status: opts.status, body: opts.body });
    });
    return { c, seen: () => seen! };
  }

  it("a create check POSTs /v1/apps with dry_run:true (no app id, no force)", async () => {
    const { c, seen } = capturing({
      status: 200,
      body: JSON.stringify({ ok: true, warnings: [] }),
    });
    const out = await c.checkDeploy({ html: "<html></html>", manifest: {} });
    expect(seen().method).toBe("POST");
    expect(seen().url).toBe("https://relay.test/v1/apps");
    expect(seen().body).toEqual({
      html: "<html></html>",
      manifest: {},
      dry_run: true,
    });
    expect(out.ok).toBe(true);
  });

  it("a redeploy check POSTs /v1/apps/:id/versions with dry_run:true + force", async () => {
    const { c, seen } = capturing({
      status: 200,
      body: JSON.stringify({
        ok: true,
        warnings: [],
        compat: "forced",
        breaks: [{ path: "collections.old", message: "removed" }],
      }),
    });
    const out = await c.checkDeploy({
      app_id: "app_1",
      html: "<html></html>",
      manifest: {},
      force: true,
    });
    expect(seen().url).toBe("https://relay.test/v1/apps/app_1/versions");
    expect(seen().body).toEqual({
      html: "<html></html>",
      manifest: {},
      dry_run: true,
      force: true,
    });
    expect(out.compat).toBe("forced");
    expect(out.breaks).toHaveLength(1);
  });
});

describe("HomespunClient attachment operations", () => {
  /** Capture the request method/path/body of a single call. */
  function capturingClient(body: string, status = 200) {
    let seen: { method: string; url: string; body: unknown } | undefined;
    const c = clientWith(async (url, init) => {
      seen = {
        method: (init?.method as string) ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      return res({ status, body });
    });
    return { c, seen: () => seen! };
  }

  it("getBlob GETs /v1/attachments/:id/metadata and returns the full AttachmentRef", async () => {
    // Regression: pre-fix `getBlob` issued a HEAD request and synthesised
    // a AttachmentRef from response headers — `sha256` came back blank, `scope`
    // was a placeholder, timestamps were missing. The metadata endpoint
    // returns the same shape POST /v1/attachments returns; getBlob must
    // forward it verbatim.
    const fullRef = {
      attachment_id: "ckxxx123",
      scope: "agent",
      mime: "image/jpeg",
      size: 4321,
      sha256: "a".repeat(64),
      filename: "hero.jpg",
      width: 640,
      height: 480,
      status: "ready",
      app_id: null,
      created_at: "2026-05-21T10:00:00.000Z",
      confirmed_at: "2026-05-21T10:00:01.000Z",
      deleted_at: null,
    };
    const { c, seen } = capturingClient(JSON.stringify(fullRef));
    const out = await c.getBlob("ckxxx123");
    expect(out).toEqual(fullRef);
    expect(out.sha256).toBe("a".repeat(64));
    expect(out.scope).toBe("agent");
    expect(out.filename).toBe("hero.jpg");
    expect(seen().method).toBe("GET");
    expect(seen().url).toBe(
      "https://relay.test/v1/attachments/ckxxx123/metadata",
    );
  });

  it("getBlob throws HomespunApiError on a 404 (attachment_not_found)", async () => {
    const c = clientWith(async () =>
      res({
        status: 404,
        ok: false,
        body: JSON.stringify({ error: { code: "attachment_not_found" } }),
      }),
    );
    await expect(c.getBlob("ckmissing")).rejects.toMatchObject({
      name: "HomespunApiError",
      status: 404,
      code: "attachment_not_found",
    });
  });

  it("uploadBlobInline POSTs a JSON base64 body to /v1/attachments", async () => {
    const ref = {
      attachment_id: "ckinline1",
      scope: "app",
      mime: "image/png",
      size: 12,
      sha256: "b".repeat(64),
    };
    const { c, seen } = capturingClient(JSON.stringify(ref), 201);
    const out = await c.uploadBlobInline("aGVsbG8=", {
      scope: "app",
      appId: "app_1",
      filename: "pic.png",
      mime: "image/png",
    });
    expect(out).toEqual(ref);
    expect(seen().method).toBe("POST");
    expect(seen().url).toBe("https://relay.test/v1/attachments");
    // The base64 rides in `content_base64`; scope/app_id/filename/mime map onto
    // the relay's inline body fields (mime advisory: the relay sniffs regardless).
    expect(seen().body).toEqual({
      content_base64: "aGVsbG8=",
      scope: "app",
      app_id: "app_1",
      filename: "pic.png",
      mime: "image/png",
    });
  });

  it("uploadBlobInline omits optional fields when not provided", async () => {
    const { c, seen } = capturingClient(
      JSON.stringify({ attachment_id: "ckinline2" }),
      201,
    );
    await c.uploadBlobInline("QUJD");
    expect(seen().body).toEqual({ content_base64: "QUJD" });
  });
});

describe("HomespunClient.wsBaseUrl", () => {
  it("maps https to wss", () => {
    expect(
      new HomespunClient({ url: "https://relay.test", apiKey: "k" }).wsBaseUrl,
    ).toBe("wss://relay.test");
  });
  it("maps http to ws", () => {
    expect(
      new HomespunClient({ url: "http://relay.test", apiKey: "k" }).wsBaseUrl,
    ).toBe("ws://relay.test");
  });
});
