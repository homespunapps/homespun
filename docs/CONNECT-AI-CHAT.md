# Connect Homespun to your AI chat

Homespun has two ways in. If you have a **coding agent** (Claude Code, Cursor,
Codex, …) the [README install flow](../README.md#install) installs the CLI +
skill and you're done. This page is for the other case: adding Homespun to an **AI
chat app**: Claude on the web, desktop, or your phone, ChatGPT, or any client
that supports remote MCP connectors, **with no install at all**.

You paste one URL, log in once, and Homespun shows up as a set of tools your chat
can call. From then on you can ask it to *"build me an app for …"* and it hands
you back a URL to a real interactive UI.

> **TL;DR.** Add a custom connector pointing at:
>
> ```
> https://homespun.dev/mcp
> ```
>
> Authorize it with your email (magic link) and approve the consent screen. That's it.

---

## What this gives you

The chat gets Homespun's full tool set: `create_app`, `get_events`,
`send_to_app`, the record/template/attachment tools, and the rest, the same
tools the [`@homespunapps/mcp` server](../packages/mcp/README.md#tools) exposes. So
you can say things like:

- *"Make me a form to capture my trip details and give me the link."*
- *"Build a dashboard of these numbers I can open on my phone."*
- *"Give me an approve/reject app for this plan and wait for my answer."*

The chat builds the UI, hands you a `homespun.dev` URL, you open it on any
device, interact, and your structured answer flows straight back into the
conversation.

**This is the only way to use Homespun from a phone or a pure chat app.** On a phone
there's no terminal and no way to run a local process, so the `homespun` CLI and the
stdio `@homespunapps/mcp` server simply don't apply, since there's nothing to install. You
add the connector once and use it. The connector runs entirely on Homespun's hosted
relay; your chat only makes outbound HTTP calls to it.

---

## Before you start

- A **Homespun account** on the hosted relay. You don't need to create one in
  advance. The first time you authorize, you'll log in by email (magic link)
  and the account is created on the spot.
- **Custom / remote MCP connectors** must be supported by your chat app. Claude
  supports them on the web, desktop, and mobile apps, **no paid plan required**
  (the free plan works too). On other apps, check that they support "custom
  connectors" or "remote MCP servers". If you are in a coding agent rather than
  a chat app, skip all of this and use the CLI:
  [Coding agents](#coding-agents-claude-code-cursor-codex-gemini-cli).

The connector URL is always:

```
https://homespun.dev/mcp
```

---

## Claude (web, desktop, mobile)

1. On the web, open the **Add custom connector** dialog directly:
   <https://claude.ai/new?modal=add-custom-connector#settings/customize-connectors>.
   The desktop and mobile apps take no deep link, so open **Settings → Connectors**
   there (on mobile: profile → Settings → Connectors).
2. On desktop and mobile, click **Add custom connector**. The web link above
   already lands you on it.
3. **Name** it `Homespun` and paste the **URL** `https://homespun.dev/mcp`.
4. Save, then click **Connect**. A browser window opens on the Homespun relay.
5. **Log in** with your email. You'll get a magic link; click it to sign in.
6. On the **consent screen** ("Allow Claude to access your app account?"),
   review it and click **Allow**. You're redirected back to Claude.
7. The connector now shows **Connected**, and Homespun's tools appear in the chat's
   tool list (the 🔌/tools menu).

Try it: start a chat and ask *"Use Homespun to build me a quick contact form and
give me the link."* Claude creates the app, returns the URL, you fill it in,
and the submitted data comes back into the conversation.

> The same connector works across every Claude surface tied to your account:
> add it once on the web and it's available on your phone too.

---

## Coding agents: Claude Code, Cursor, Codex, Gemini CLI

**Do not use the connector here.** An agent with a terminal gets the CLI
instead, and the difference is not cosmetic: the connector answers by
describing its whole tool surface, which the model must read before it can act,
where the CLI is three commands and a skill file. Same account, same apps,
much shorter instruction.

Paste this into the agent and it sets itself up:

```
Set me up with Homespun: run `npm i -g @homespunapps/cli`, then `homespun agent register --start --name home` and show me the approval link it prints. Once I tell you I have approved it, run `homespun agent register --resume`. Then read https://homespun.dev/skills/homespun/SKILL.md and ask me what app I want to build.
```

It names the commands rather than only pointing at the skill, so the agent can
act on the first line instead of reading a 150 KB document to discover that
there is something to install. The skill URL is still there, at the end,
because that is what teaches it to build an app: a different job from getting
connected.

By hand, it is three steps. First the skill, which is what teaches the agent
every command below. `npx skills add` detects the host it is running in (Claude
Code, Cursor, Codex, Gemini CLI, Copilot, Windsurf, Continue) and writes the
skill where that host looks for it:

```sh
npx skills add homespunapps/homespun --skill homespun
```

Then the CLI itself, and a one-time sign-in. Needs Node 20 or newer:

```sh
npm i -g @homespunapps/cli
homespun agent register --name home
```

`agent register` runs the device-authorization sign-in in your browser and
writes the resulting key to your Homespun config, so it is both the login and
the key-issuing step, once per machine, with no API key to paste. See the
[README install section](../README.md#install).

If an agent is working from a stale copy of the skill, this prints the current
one straight from the relay:

```sh
homespun skill show
```

That is the whole setup for every terminal agent, including editors. Cursor,
Windsurf, Cline and VS Code Copilot each run one, so they take these same three
commands rather than a settings file.

**Gemini CLI, not the Gemini app.** The app has no terminal, so none of the
above applies to it, and it cannot reach Homespun the other way either: custom
MCP arrived inside Gemini Spark against a curated set of partner connectors,
and connecting an arbitrary MCP server of your own is a Gemini Enterprise
feature. If that is where you are, use [Claude](#claude-web-desktop-mobile) on
your phone instead, which takes the connector URL directly.

---

## ChatGPT and other MCP-capable chat apps

Any chat client that supports **remote MCP / custom connectors** can use Homespun.
the connector is a standard OAuth-protected Streamable-HTTP MCP endpoint, not a
Claude-specific integration.

- **ChatGPT**: in the clients that expose custom connectors / MCP, add a new
  connector with the URL `https://homespun.dev/mcp` and complete the OAuth
  login + consent when prompted.
- **Other chat clients**: wherever the app asks for a *server URL* for a
  remote/HTTP MCP connector, give it `https://homespun.dev/mcp`. It will
  discover the auth endpoints automatically and walk you through login +
  consent.
- **Cursor, Windsurf, Cline, VS Code Copilot**: not here. Each runs a terminal
  agent, so they use the CLI: see
  [Coding agents](#coding-agents-claude-code-cursor-codex-gemini-cli) above.

The flow is identical everywhere: **paste the URL → log in by email → approve
the consent screen**. No API key to copy, no client secret to manage. The
client registers itself and uses PKCE.

---

## Managing the connection

- **One identity per chat.** Each chat app you authorize gets a single Homespun
  agent identity bound to your account; re-authorizing the same app reuses it,
  so your apps and templates accumulate under one identity.
- **Disconnect any time.** Remove the connector in your chat app's settings (or
  revoke it from the Homespun relay) and its access is revoked immediately. Your CLI
  key and any other connectors are unaffected.
- **Tokens.** Access tokens are short-lived (1h) and refresh automatically;
  refresh tokens last 30 days. Everything is revocable.
- **Scope.** A connection grants full agent access, parity with a CLI key
  (create/read/update apps, records, templates, attachments).

---

## How it works (one paragraph)

Homespun's relay is both the **MCP resource server** (`/mcp`) and its own **OAuth
2.1 authorization server**, in one container. When your chat first calls `/mcp`
without a token it gets a `401` pointing at the relay's OAuth metadata; the
client self-registers (Dynamic Client Registration), you log in with the relay's
magic-link flow and approve a consent screen, and the client receives an
access + refresh token. Each token is mapped to a per-human Homespun agent, so the
connector acts exactly like a CLI agent against the relay's own API: same auth,
same validation, same scoping. PKCE (S256) is required, redirect URIs are exact-
match allowlisted, authorization codes are single-use, and tokens are opaque +
revocable. The full design is in
[`docs/architecture/remote-mcp-oauth.md`](architecture/remote-mcp-oauth.md).

---

## Troubleshooting

- **"Connect" does nothing / no browser opens**: make sure pop-ups aren't
  blocked, then retry. The relay must be reachable at
  `https://homespun.dev` (check <https://homespun.dev/healthz>).
- **The consent screen says the client is "not verified by app"**: that's
  expected. Homespun allows open client registration (so apps like Claude mobile can
  connect), so it can't pre-verify every client. Check the **redirect host**
  shown on the consent screen is the app you're actually authorizing before you
  allow it.
- **My chat app has no "custom connector" option**: not every chat app
  supports remote MCP connectors yet. If yours doesn't, use a coding agent with
  the CLI/skill instead (see the [README](../README.md#install)) or the local
  stdio server ([`@homespunapps/mcp`](../packages/mcp/README.md)).
- **Tools don't appear after connecting**: reopen the chat's tool/connector
  menu; some clients need the conversation restarted to pick up a new connector.

---

## See also

- [README, Install](../README.md#install): the coding-agent and CLI install paths
- [`@homespunapps/mcp`](../packages/mcp/README.md): the local **stdio** MCP server (Claude Desktop config, Cursor, generic hosts) and the full tool list
- [`docs/architecture/remote-mcp-oauth.md`](architecture/remote-mcp-oauth.md): the connector's OAuth 2.1 design and security model
- [`skills/homespun/SKILL.md`](../skills/homespun/SKILL.md): the agent-facing reference for everything Homespun can do
