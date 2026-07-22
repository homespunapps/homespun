#!/usr/bin/env node
// `homespun-mcp` — a thin stdio Model Context Protocol server wrapping Homespun.
//
// Speaks MCP over stdio so any MCP client (Claude Desktop, Cursor, …) can use
// Homespun: create apps, push updates, and poll for the human's response. All
// relay I/O goes through @homespunapps/core (no duplicated transport logic), and
// config is shared with the `homespun` CLI (~/.config/homespun/config.json) — so the
// CLI and this server use the same agent identity.
//
// Config (all optional — sensible defaults; auto-registers an agent on first
// use if no key is found):
//   HOMESPUN_URL              relay base URL (default https://homespun.dev)
//   HOMESPUN_API_KEY          agent API key (or use the shared CLI store)
//   HOMESPUN_TOKEN            alias for HOMESPUN_API_KEY (for MCP host "*_TOKEN" config)
//   HOMESPUN_AGENT_NAME       label for the auto-registered agent
//   HOMESPUN_REGISTER_SECRET  registration secret (REGISTRATION_MODE=secret relays)

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  // --version / --help are answered locally without starting the transport, so
  // a human poking at the binary gets a useful response instead of a hung
  // stdio session waiting for JSON-RPC.
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`homespun-mcp ${VERSION}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  const server = buildServer({
    agentName: process.env.HOMESPUN_AGENT_NAME,
    registerSecret: process.env.HOMESPUN_REGISTER_SECRET,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stdio MCP servers run until the host closes stdin; keep the process alive.
  // The transport resolves connect() immediately, so without this the event
  // loop would otherwise stay open only because of the stdin reader — which is
  // the intended behaviour. Nothing more to do here.
}

const HELP = `homespun-mcp ${VERSION} — Homespun Model Context Protocol server (stdio)

Run by an MCP client over stdio; not meant to be invoked interactively. Add it
to your MCP client config, e.g. Claude Desktop / Cursor:

  {
    "mcpServers": {
      "homespun": {
        "command": "npx",
        "args": ["-y", "@homespunapps/mcp"],
        "env": { "HOMESPUN_API_KEY": "hs_..." }
      }
    }
  }

Environment:
  HOMESPUN_URL              Relay base URL (default https://homespun.dev)
  HOMESPUN_API_KEY          Agent API key. If unset, the server auto-registers an
  HOMESPUN_TOKEN            agent on first use and saves the key to the shared CLI
                        store (~/.config/homespun/config.json). HOMESPUN_TOKEN is an
                        alias for HOMESPUN_API_KEY.
  HOMESPUN_AGENT_NAME       Display name for the auto-registered agent.
  HOMESPUN_REGISTER_SECRET  Registration secret (REGISTRATION_MODE=secret relays).

Tools exposed: deploy_app, list_rows, get_row, upsert_row, update_row,
delete_row, get_feed_events, apps, members, attachments, taste, key,
feedback, agent, get_skill.

See https://docs.homespun.dev for docs.
`;

main().catch((e) => {
  process.stderr.write(
    `homespun-mcp: fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
