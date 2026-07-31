# @homespunapps/mcp

A thin **stdio [Model Context Protocol](https://modelcontextprotocol.io) server** for [Homespun](https://homespun.dev). It lets any MCP client (Claude Desktop, Cursor, Windsurf, Cline, your own host) deploy a real multi-user web app in one call and keep operating its data afterwards: hosting on its own URL, magic-link identity, a shared realtime database with per-role permissions, email notifications and file attachments, all included.

It is a wrapper, not a reimplementation: all relay I/O goes through [`@homespunapps/core`](https://www.npmjs.com/package/@homespunapps/core), and config is shared with the [`homespun` CLI](https://www.npmjs.com/package/@homespunapps/cli) (`~/.config/homespun/config.json`), so the CLI and this server use the **same agent identity**.

## Runtime requirement: Node.js >= 20

The binary is `homespun-mcp`. It speaks MCP over stdio and is meant to be launched by an MCP host, not run interactively.

## Quickstart

No global install needed: point your MCP client at `npx @homespunapps/mcp`. On first use, if no API key is configured, the server auto-registers a fresh agent against the hosted relay and saves the key to the shared CLI store; nothing else to set up.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "homespun": {
      "command": "npx",
      "args": ["-y", "@homespunapps/mcp"]
    }
  }
}
```

To pin an existing agent key instead of auto-registering, add an `env` block:

```json
{
  "mcpServers": {
    "homespun": {
      "command": "npx",
      "args": ["-y", "@homespunapps/mcp"],
      "env": { "HOMESPUN_API_KEY": "hs_..." }
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "homespun": {
      "command": "npx",
      "args": ["-y", "@homespunapps/mcp"],
      "env": { "HOMESPUN_API_KEY": "hs_..." }
    }
  }
}
```

### Generic MCP host

Any client that takes a `command` + `args` + `env` works the same way:

```json
{
  "mcpServers": {
    "homespun": {
      "command": "npx",
      "args": ["-y", "@homespunapps/mcp"],
      "env": {
        "HOMESPUN_URL": "https://homespun.dev",
        "HOMESPUN_API_KEY": "hs_..."
      }
    }
  }
}
```

If you'd rather install it globally (`npm i -g @homespunapps/mcp`), use `"command": "homespun-mcp"` with no `args`.

## Configuration

All environment variables are optional; the defaults target the hosted relay and auto-register on first use.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOMESPUN_URL` | `https://homespun.dev` | Relay base URL. Set to point at a different relay. |
| `HOMESPUN_API_KEY` | _(auto-registered)_ | Agent API key. If unset, the server registers an agent on first use and saves the key to `~/.config/homespun/config.json` (shared with the CLI). |
| `HOMESPUN_TOKEN` | _(none)_ | Alias for `HOMESPUN_API_KEY` (for hosts that name secrets `*_TOKEN`). `HOMESPUN_API_KEY` wins if both are set. |
| `HOMESPUN_AGENT_NAME` | `homespun-mcp` | Display name for the auto-registered agent. |
| `HOMESPUN_REGISTER_SECRET` | _(none)_ | Registration secret, only for relays running `REGISTRATION_MODE=secret`. |

Config precedence mirrors the CLI: env vars win over the saved profile, which falls back to the default relay URL.

## Tools

This server has **full parity with the [`homespun` CLI](https://www.npmjs.com/package/@homespunapps/cli)**: every capability the CLI exposes is reachable here.

MCP tools are request/response, so there is no long-lived "watch". To see what changed you **poll** `get_feed_events` with the cursor from the previous call (pass `wait` to long-poll, 0 to 30 seconds); to watch one collection, re-call `list_rows` with the prior `next_cursor` as `since`. Each tool description spells out the pattern for the model.

To keep the tool list compact (a flat 50+ tools would bloat client context and degrade selection), **hot-path nouns stay discrete tools** while **multi-verb management nouns collapse into one tool each with a required `action` enum**.

### Hot-path (discrete) tools

| Tool | What it does |
| --- | --- |
| `deploy_app` | Deploy a v2 app: an HTML document plus a capability manifest, hosted at its own URL. Omit `app_id` to create, pass it to redeploy in place (same URL, same data, same members). Takes `html` or `html_path`, optional `assets`, `visibility`, `slug`, `dry_run`, `force`. |
| `list_rows` | List rows in a collection. Doubles as the poll for a collection's current state: pass the prior `next_cursor` as `since`. |
| `get_row` | Fetch one row by `key` (a dedicated relay route, not a client-side scan). |
| `upsert_row` | Create a row, or return the existing one if `key` is already present (`deduped: true`), or `row_not_found` when the collection's `read` list does not reach that row for you. The only create-shaped verb. |
| `update_row` | Replace an existing row's `data`. Optional `if_match` optimistic lock. |
| `delete_row` | Soft-delete a row. Optional `if_match`. |
| `get_feed_events` | Poll the app's change feed for row creates/updates/deletes from any writer, human or agent. Optional `wait` (0-30s) long-poll. |

### Consolidated tools (one tool, required `action`)

| Tool | Actions |
| --- | --- |
| `apps` | `list` · `show` · `update` · `share_link_rotate` · `delete` · `wake` · `domain_set` · `domain_status` · `domain_remove` |
| `members` | `add` · `list` · `set_role` · `remove` · `roles` |
| `grants` | `mint` · `list` · `revoke` |
| `ingest` | `list` · `rotate` · `set_signing_secret` · `clear_signing_secret` |
| `attachments` | `upload` · `fetch` · `presign` · `finalize` · `download` · `show` · `list` · `delete` · `mint_token` · `revoke_token` · `list_tokens` |
| `taste` | `get` · `set` · `clear` |
| `key` | `list` · `mint` · `revoke` |
| `feedback` | `create` · `list` |
| `agent` | `whoami` · `claim` · `logout` |
| `community` | `publish` · `unpublish` · `get_config_contract` · `install` · `list_pending` · `get_submission` · `approve` · `reject` · `set_trust_level` |
| `publisher` | `claim` · `get` · `update` |
| `review` | `create` · `respond` · `report` · `remove` · `unhold` |

### Single-purpose tools

| Tool | What it does |
| --- | --- |
| `get_skill` | Fetch the relay's auto-updating guide (unauthenticated) to self-teach the workflow. |

**Attachments** take and return file paths: `upload` reads an absolute `file_path`; `download` writes to an absolute `out_path` (or returns base64 when omitted). For real media, `presign` then PUT then `finalize` avoids moving bytes through the tool call.

**One data primitive.** Everything an app stores is a **collection**: a named, mutable, queryable set of rows, each with a `key`, a `data` payload, an optimistic-lock `version` and an `author`. Every write also lands on the app's ordered **change feed**. Declare a collection `appendOnly: true` in the manifest when you want a journal (an audit trail, a submission log) rather than mutable state.

### Not exposed (and why)

- The CLI's `config show` is replaced by `agent` → `whoami` (resolved relay URL, active profile, and whether a key is set; no secrets).
- `agent register` is not a tool. The server auto-registers on first use and shares the CLI's key store; `agent` → `claim` binds it to a human afterwards.
- `demo` (the interactive terminal tour) and the CLI self-updater are terminal concerns with no agent use; omitted.

## Typical flow

1. `deploy_app` with your HTML plus an `x-homespun-manifest` declaring the app's collections and which roles may read, write and delete each. Returns `{ app_id, url, ... }`.
2. Give the `url` to the owner, and invite anyone else with `members` (`action: add`).
3. `get_feed_events` with `wait: 25` in a loop, passing the prior `cursor` as `since`, to see what people do.
4. Read and write the same data with `list_rows` / `upsert_row` / `update_row`, and ship changes with `deploy_app` again, passing `app_id`.

## MCP registry

`server.json` (in this package) carries the metadata for the [official MCP registry](https://registry.modelcontextprotocol.io). Publishing there is a follow-up step for the maintainer.

## License

MIT, see [LICENSE](./LICENSE).
