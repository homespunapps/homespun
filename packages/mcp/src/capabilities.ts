// Register app's MCP prompt + resource on an McpServer.
//
// Both the stdio server (packages/mcp/src/server.ts) and the relay's HTTP MCP
// server call this so an MCP-native client can discover the conceptual guide
// without a tool call:
//
//   - prompt   `homespun_guide`   — surfaces the guide as a prompt the client can
//                               insert into context ("teach me app").
//   - resource `homespun://guide`  — the same guide as a readable resource.
//
// The guide text is supplied by the host: the relay composes it in-process
// (MCP-INVOCATION.md + the core extracted from SKILL.md); the stdio server
// fetches it from the relay over HTTP and falls back to a short pointer when
// the relay is unreachable at registration time (registration must not block on
// the network — the get_skill tool is the always-fresh path).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const GUIDE_RESOURCE_URI = "homespun://guide";
export const GUIDE_PROMPT_NAME = "homespun_guide";

/**
 * Register the `homespun_guide` prompt and the `homespun://guide` resource on `server`.
 * `getGuide()` returns the current MCP-flavoured guide markdown (called lazily
 * on each read so a relay can serve an updated guide without re-registering).
 */
export function registerGuideCapabilities(
  server: McpServer,
  getGuide: () => string | Promise<string>,
): void {
  server.registerResource(
    GUIDE_PROMPT_NAME,
    GUIDE_RESOURCE_URI,
    {
      title: "Homespun usage guide",
      description:
        "The app conceptual guide for MCP clients: when to use app, events vs records, schema design, the house style, and the round-trip mental model — with MCP tool-call invocation grammar.",
      mimeType: "text/markdown",
    },
    async () => {
      const text = await getGuide();
      return {
        contents: [
          { uri: GUIDE_RESOURCE_URI, mimeType: "text/markdown", text },
        ],
      };
    },
  );

  server.registerPrompt(
    GUIDE_PROMPT_NAME,
    {
      title: "Homespun usage guide",
      description:
        "Insert the app usage guide (MCP invocation + conceptual core) into the conversation so the model knows how to drive app's tools.",
    },
    async () => {
      const text = await getGuide();
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text },
          },
        ],
      };
    },
  );
}
