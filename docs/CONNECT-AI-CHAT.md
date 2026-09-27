# Connect Homespun to your AI chat

Choose the client you use on the [connection guide](https://homespun.dev/connect). The public homepage keeps its general setup prompt available, and its Works with marks open these guides. In the signed-in console, you can select a client, save a first app idea, and copy a tailored prompt. Selection is optional.

The setup route depends on what your client can actually do. Existing working Homespun connections should be reused. A terminal, network access, and an authenticated Homespun identity are separate capabilities; a shell by itself does not mean the CLI can be installed or reach the service. A successful authenticated Homespun operation is the evidence that a connection works. A button click or OAuth return alone is not verification.

## Claude on web, desktop, or mobile

Claude can connect through the hosted remote MCP endpoint. Add a custom connector named Homespun with this URL:

```
https://homespun.dev/mcp
```

On the web, this [prefilled connector link](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Homespun&connectorUrl=https%3A%2F%2Fhomespun.dev/mcp) fills in the name and URL. In the apps, open Settings → Connectors → Add custom connector. On mobile, the settings entry may be under your profile. Save the connector, sign in to Homespun by email, and approve the consent screen. Then try a small request and confirm that Claude successfully calls Homespun.

The web deep link may open the Claude app on a phone. If it does, use the Settings path above or copy the URL into a browser. File and shell tools available in a chat session do not guarantee that the session can reach an upload destination; use the normal inline Homespun workflow if file transfer is unavailable.

## Coding agents

Claude Code, Cursor, and Codex have dedicated guides at [/connect/claude-code](https://homespun.dev/connect/claude-code), [/connect/cursor](https://homespun.dev/connect/cursor), and [/connect/codex](https://homespun.dev/connect/codex). Follow the guide for the client you selected. Reuse an existing authenticated Homespun connection when it works. Otherwise check whether the client can run shell commands, whether Node 20 or newer is available, and whether network access allows installation and sign-in.

The generic prompt is:

```
Set me up with Homespun: run `npm i -g @homespunapps/cli`, then `homespun agent register --start --name home` and show me the approval link it prints. Once I tell you I have approved it, run `homespun agent register --resume`. Then read https://homespun.dev/skills/homespun/SKILL.md and ask me what app I want to build.
```

By hand, the CLI setup facts are:

```sh
npx skills add homespunapps/homespun --skill homespun
npm i -g @homespunapps/cli
homespun agent register --name home
```

`homespun skill show` prints the skill served by the relay. Do not create another Homespun identity if the selected client already has a working connection.

## Antigravity, OpenCode, and other clients

Use the generic guide at [/connect/other](https://homespun.dev/connect/other) while client-specific setup is unverified. Antigravity and Gemini CLI are distinct clients; this guide does not claim that one replaced the other. Do not report that a client is connected until an authenticated Homespun operation succeeds.

For a client without a usable shell, look for its supported remote MCP connector flow and use the hosted endpoint above. Client features, plans, sandbox networking, and available tools differ, so check the actual client rather than inferring capabilities from its name or device.

## Managing and troubleshooting a connection

Remove the connector in your AI client or revoke it in Homespun to disconnect. Other connected agents remain available. Review the client and redirect host on the consent screen before approving access.

If the sign-in window does not open, allow pop-ups and retry. If tools do not appear after authorization, reopen the client's connector menu or start a fresh conversation. If the client has no custom connector option, use a supported coding environment or the generic connection guide.

For tool details see the [MCP package](../packages/mcp/README.md); for authorization details see the [remote MCP design](architecture/remote-mcp-oauth.md). The [Homespun skill](../skills/homespun/SKILL.md) explains app authoring, validation and deployment.
