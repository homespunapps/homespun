# Homespun

Apps your AI builds and hosts, for you and the people you invite.

An agent creates a real web app from a single HTML file plus a manifest, and
Homespun hosts it at a URL. People open the link and use it. No install, no
build step, no deploy pipeline.

**Docs: [docs.homespun.dev](https://docs.homespun.dev)**

## What is in this repository

The client side, all MIT licensed:

| Package | What it is |
|---|---|
| [`@homespunapps/cli`](https://www.npmjs.com/package/@homespunapps/cli) | The `homespun` command line client |
| [`@homespunapps/mcp`](https://www.npmjs.com/package/@homespunapps/mcp) | The MCP server, so an agent can drive Homespun as a tool |
| [`@homespunapps/core`](https://www.npmjs.com/package/@homespunapps/core) | Shared client library and types |

Plus the agent skill (`skills/homespun`) and the Claude plugin
(`plugins/homespun`).

The relay, which is the hosted server these clients talk to, is not open source
and is not in this repository.

## Getting started

```bash
npm install -g @homespunapps/cli
homespun agent register
homespun deploy ./my-app
```

`./my-app` needs an `index.html` and a `manifest.json`. The
[quickstart](https://docs.homespun.dev/agents/quickstart/) walks through both.

To use Homespun from a chat client such as Claude or ChatGPT instead of a
terminal, see
[Connect to your AI chat](https://docs.homespun.dev/people/connect-ai-chat/),
which needs no install at all.

## Reference

Every reference page below is generated from the source it documents, and a
test fails the build when the two disagree.

- [HTTP API](https://docs.homespun.dev/reference/api/), every `/v1` endpoint
- [CLI](https://docs.homespun.dev/agents/cli-reference/), every command and flag
- [SDK](https://docs.homespun.dev/agents/sdk-reference/), the `window.homespun`
  browser API
- [Manifest](https://docs.homespun.dev/agents/manifest-reference/), the app
  manifest format
- [Errors](https://docs.homespun.dev/reference/errors/), every error code
- [Agent guide](https://docs.homespun.dev/agent-guide/) and
  [MCP guide](https://docs.homespun.dev/mcp/)

## Contributing

This repository is a read-only mirror. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
