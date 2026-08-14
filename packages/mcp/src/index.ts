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
//
// This module is a pure library: no top-level side effects, so it can be
// imported by a test (or by bin.ts) without starting a stdio server. The
// process entry point lives in bin.ts, which is what `package.json`'s `bin`
// field points at.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { TOOLS } from "./tools.js";
import { VERSION } from "./version.js";

// Derived from TOOLS so the banner can never drift from what the server
// actually registers (it did, silently, for months, see #1659). Wrapped by
// hand rather than left as one long line, since a flat 25-name line is
// harder to scan than a handful of short ones.
export function wrapToolNames(names: string[], width: number): string {
  const words = names.map((name, i) =>
    i < names.length - 1 ? `${name},` : `${name}.`,
  );
  const lines: string[] = [];
  let current = "Tools exposed:";
  for (const word of words) {
    const next = `${current} ${word}`;
    if (next.length > width && current !== "Tools exposed:") {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  lines.push(current);
  return lines.join("\n");
}

const TOOLS_EXPOSED = wrapToolNames(
  TOOLS.map((t) => t.name),
  74,
);

export const HELP = `homespun-mcp ${VERSION}: Homespun Model Context Protocol server (stdio)

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

${TOOLS_EXPOSED}

See https://docs.homespun.dev for docs.
`;

export async function main(): Promise<void> {
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
  // loop would otherwise stay open only because of the stdin reader, which is
  // the intended behaviour. Nothing more to do here.
}
