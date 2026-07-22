// End-to-end MCP handshake test: a real MCP Client speaks to the Homespun server
// over an in-memory transport pair. Exercises initialize → tools/list →
// tools/call exactly as a host (Claude Desktop / Cursor) would, against an
// injected fake HomespunClient so no network or config store is touched.

import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HomespunClient } from "@homespunapps/core";
import { buildServer } from "./server.js";

/** Wire a Client to a freshly-built server over a linked in-memory pair. */
async function connect(client: HomespunClient) {
  const server = buildServer({ client });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    mcpClient.connect(clientTransport),
  ]);
  return mcpClient;
}

function fakeClient(overrides: Record<string, unknown>): HomespunClient {
  return overrides as unknown as HomespunClient;
}

describe("MCP handshake", () => {
  it("lists every Homespun tool over tools/list", async () => {
    const mcp = await connect(fakeClient({}));
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    // v2 app lifecycle + data tools.
    expect(names).toContain("deploy_app");
    expect(names).toContain("list_rows");
    expect(names).toContain("upsert_row");
    expect(names).toContain("get_feed_events");
    // Consolidated management tools.
    expect(names).toContain("apps");
    expect(names).toContain("attachments");
    expect(names).toContain("get_skill");
    expect(names).toContain("members");
    expect(names).toContain("community");
    expect(names).toContain("grants");
    expect(names).toContain("ingest");
    expect(names).toContain("publisher");
    expect(names).toContain("review");
    expect(names).toHaveLength(20);
    // Each advertised tool carries a description + JSON-schema inputSchema the
    // host shows to the model.
    for (const t of tools) {
      expect(t.description && t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeTruthy();
    }
  });

  it("tools/list carries annotations over the (stdio-style) transport", async () => {
    // The annotations the directory reads MUST survive registerTool → the
    // transport → tools/list (not just live on the in-memory ToolDef).
    const mcp = await connect(fakeClient({}));
    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));

    // Every tool has a title + a privilege hint over the wire.
    for (const t of tools) {
      expect(t.annotations, t.name).toBeTruthy();
      expect(typeof t.annotations!.title, t.name).toBe("string");
      const ro = t.annotations!.readOnlyHint === true;
      const destructive = t.annotations!.destructiveHint === true;
      expect(ro || destructive, t.name).toBe(true);
    }

    // Read-only sample.
    expect(byName.get("list_rows")!.annotations).toMatchObject({
      title: "List Rows",
      readOnlyHint: true,
    });
    // Destructive sample.
    expect(byName.get("delete_row")!.annotations).toMatchObject({
      title: "Delete Row",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    // Consolidated action-enum sample.
    expect(byName.get("apps")!.annotations).toMatchObject({
      title: "Manage Apps",
      readOnlyHint: false,
      destructiveHint: true,
    });
  });

  it("rejects tools/call with invalid arguments before hitting core", async () => {
    const deployApp = vi.fn();
    const mcp = await connect(fakeClient({ deployApp }));
    // Missing required `manifest` — the SDK validates against the input
    // schema and returns an isError result without ever invoking the handler.
    const result = (await mcp.callTool({
      name: "deploy_app",
      arguments: { html: "<html></html>" },
    })) as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/validation|manifest/i);
    expect(deployApp).not.toHaveBeenCalled();
  });

  it("round-trips deploy_app through to the injected client", async () => {
    const deployApp = vi.fn().mockResolvedValue({
      app_id: "app_rt",
      slug: "app-rt",
      url: "https://app-rt.example.com",
      version: 1,
      visibility: "private",
      created: true,
    });
    const mcp = await connect(fakeClient({ deployApp }));
    const result = (await mcp.callTool({
      name: "deploy_app",
      arguments: { html: "<form></form>", manifest: {} },
    })) as { content: { type: string; text: string }[]; isError?: boolean };

    expect(result.isError).toBeFalsy();
    expect(deployApp).toHaveBeenCalledTimes(1);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.app_id).toBe("app_rt");
    expect(body.url).toBe("https://app-rt.example.com");
  });
});

// The advertised JSON Schema is what a client harness reads to decide how to
// serialize each argument. An object-valued param declared as z.unknown()
// emits NO `type` keyword, so a harness has no signal an object is expected and
// may send a JSON string - the reported deploy_app `manifest` bug. These tests
// render the ACTUAL tool list the server advertises over tools/list (the same
// SDK serialization path a real host uses) and assert the emitted types.
describe("advertised input schema types", () => {
  async function advertisedSchemas() {
    const mcp = await connect(fakeClient({}));
    const { tools } = await mcp.listTools();
    return new Map(tools.map((t) => [t.name, t.inputSchema]));
  }

  it("deploy_app manifest advertises type:object", async () => {
    const schemas = await advertisedSchemas();
    const manifest = (schemas.get("deploy_app") as Record<string, unknown>)
      .properties as Record<string, { type?: string }>;
    expect(manifest.manifest.type).toBe("object");
  });

  it("upsert_row + update_row data advertise an explicit typed anyOf (never a bare no-type schema)", async () => {
    const schemas = await advertisedSchemas();
    for (const name of ["upsert_row", "update_row"]) {
      const props = (schemas.get(name) as Record<string, unknown>)
        .properties as Record<string, Record<string, unknown>>;
      const data = props.data;
      // Not a bare `{}` (no-type) schema: it carries an anyOf whose branches
      // are each typed, and one of them is an object.
      expect(Array.isArray(data.anyOf), name).toBe(true);
      const branches = data.anyOf as { type?: string }[];
      expect(
        branches.every((b) => typeof b.type === "string"),
        name,
      ).toBe(true);
      expect(
        branches.some((b) => b.type === "object"),
        name,
      ).toBe(true);
    }
  });
});
