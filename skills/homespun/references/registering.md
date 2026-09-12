<!-- homespun skill reference: registering -->

# Registering and claiming

A reference section of the homespun skill. Read this the FIRST time you use
homespun on a machine, to obtain an agent API key, and again if a deploy is
refused with `agent_not_claimed`. Once you hold a claimed key you never need
this again.

## Registering

If you weren't handed an API key, provision one yourself, **once**, with:

```sh
homespun agent register --name "<short-descriptive-agent-name>"
```

Pick a stable, descriptive name: it's how a human tells your agent apart from
other agents on the relay (e.g. `claude-code-lalit-macbook`, `ci-pr-review-bot`,
`telegram-helper`), and it's what the approval screen shows. If omitted, the
CLI defaults it to `cli-<hostname>`.

Targeting a relay other than the hosted default (local dev, staging)? Add
`--url "$HOMESPUN_URL"` (or set `HOMESPUN_URL`) to target it.

**If you are an agent, use the two-phase form.** Plain `homespun agent register`
BLOCKS for up to 15 minutes waiting for a human to approve, and you cannot show
anyone the link until the command returns. Your harness will kill the call
first, and the key is issued only to the process that is still polling, so your
human approves, sees success, and ends up with nothing. Do this instead:

```sh
homespun agent register --start --name "<short-descriptive-agent-name>"
```

It returns immediately with JSON on stdout:

```json
{
  "state": "pending_approval",
  "verification_uri_complete": "https://homespun.dev/device?code=ABCD-EFGH",
  "user_code": "ABCD-EFGH",
  "expires_in": 900
}
```

1. **Show your human the link and the code**, and say they can open it on any
   device, their phone included. Then stop and wait for them to tell you they
   approved it. Do not poll in a loop, and do not sleep: ask, and wait for the
   answer like any other question.
2. When they say they are done:

   ```sh
   homespun agent register --resume
   ```

   On approval it saves the key to
   `${XDG_CONFIG_HOME:-~/.config}/homespun/config.json` (mode 0600) and prints
   the same `"registered_via": "device"` envelope, and every later command
   picks the key up from that file automatically.
3. If `--resume` exits with `not_approved_yet`, they have not finished. Show
   the link again, and try once more when they say so. The approval waits on
   the relay for the code's full 15 minutes, so a gap between the two commands
   costs nothing.

**Interactive humans can use the blocking form.** Someone typing into their own
terminal sees the link appear and approves it without a second command, so
plain `homespun agent register` is still right for them. It runs the same RFC
8628 device-authorization flow, printing the URL and code to stderr and polling
`POST /v1/device/token` until they approve.

Either way, a device-flow agent is **already owned** by the human who approved
it: no separate claim step is needed, and `homespun deploy` works immediately.

**Fallback: direct registration.** When the relay predates the device flow
(404 on `/v1/device/code`), the CLI falls back to plain `POST /v1/register`
with a note on stderr (and `"registered_via": "direct"`). Pass `--no-device`
to force this path (e.g. CI with no human), or `--secret <s>` /
`HOMESPUN_REGISTER_SECRET` for a `REGISTRATION_MODE=secret` relay (a secret
implies the direct path). Whether direct registration works depends on the
relay's `REGISTRATION_MODE`:

- `closed` (the default): the endpoint returns 404. The operator must hand
  you a key directly; self-registration is disabled. (The device flow is NOT
  gated by this mode; it requires an explicit human approval instead.)
- `secret`: pass the operator-shared registration secret with `--secret <s>`
  or the `HOMESPUN_REGISTER_SECRET` env var. A missing/wrong secret is a 401.
- `open` (the hosted relay's mode): public; works with no secret.

The key is not printed by default (pass `--print-key` if you need it echoed),
and the relay rate-limits both `/v1/register` and `/v1/device/code` per IP.

## Claiming: your app needs a human owner

**Device-flow agents are born claimed; direct-registered agents are not.**
An agent registered through the browser-approval flow above already belongs
to the human who approved it, so skip this section. A DIRECT `POST /v1/register`
mints an agent with no human attached at all; this is true even if a human ran
`homespun agent register --no-device` themselves and handed you the resulting key;
direct registration and ownership are two separate steps no matter who typed
the command. Every app row (`App.ownerHumanId`) is owned by a human, so
creating a new app via `homespun deploy` rejects with `agent_not_claimed` until
your agent has been **claimed** by a human. Do this once, before your first
deploy:

1. **The human mints a one-shot claim code.** In the relay's UI: Account menu →
   "My agents" → "Claim a new agent" → "Generate claim code". This calls
   `POST /v1/self/claim-codes` and shows the human a code like `cc_...`
   (15-minute TTL, single use). Ask the human to do this and hand you the
   code out-of-band (paste it into the chat, an env var, however you two are
   talking).
2. **You claim yourself with the code:**

   ```sh
   homespun agent claim <code>
   ```

   This calls `POST /v1/agents/claim`, which sets `Agent.ownerHumanId` to that
   human and migrates ownership of anything the agent already created. Output:
   `{ ok: true, owner_human_id, claimed_at }`.
3. **This is one-way.** An already-claimed agent re-running `homespun agent claim`
   gets `agent_already_claimed` (409): there's no unclaim/re-claim in v1. To
   change owners, register a fresh agent and have the new human claim that one.

If `homespun deploy` fails with `agent_not_claimed`, stop and ask the human to
mint you a claim code; don't guess at a workaround.
