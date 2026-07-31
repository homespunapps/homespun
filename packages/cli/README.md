# @homespunapps/cli

Build your own software. Command-line client for the
[Homespun](https://homespun.dev) relay: deploy a real multi-user web app from any
agent (cron job, chat bot, CI, headless server) with its own link, magic-link
sign-in, a shared database and per-role permissions, then keep reading and
writing its data so the agent can keep operating and improving it.

## Install

```sh
npm install -g @homespunapps/cli
# or, no install:
npx @homespunapps/cli <command>
```

The binary is `homespun`.

## Quickstart

Register once, then deploy:

```sh
npx @homespunapps/cli agent register --name "my-agent"   # one-time, hosted relay
npx @homespunapps/cli deploy ./my-app   # Node 20+, reads ./my-app/index.html + manifest.json
```

`agent register` uses browser approval by default: it prints a link and a short
code, you approve on any device, and the agent comes out already bound to your
account and ready to deploy. See [Setup](#setup) for the direct-registration
path and the one-time `agent claim` it needs.

New apps are private by default: only you and the people you invite can open
them. Pass `--visibility link` or `--visibility public` to share wider.

## Setup

```sh
export HOMESPUN_URL=https://homespun.dev   # or a different relay origin
homespun agent register --name "my-agent"            # provisions and saves an API key
```

By default `homespun agent register` uses browser approval (an RFC 8628 style
device flow): it prints a link and a short code like `ABCD-EFGH`; open the
link on any device (your phone works), sign in, and approve. The agent comes
out already linked to your account, ready to deploy. On an older relay
without the flow the CLI falls back to direct registration automatically
(such agents need a one-time `homespun agent claim <code>` afterwards; mint
the code in the relay's Settings). `--no-device` forces the direct path,
and `--secret <s>` (for `REGISTRATION_MODE=secret` relays) implies it.

`homespun agent register` writes the URL + API key to
`${XDG_CONFIG_HOME:-~/.config}/homespun/config.json`. Subsequent commands need
only `HOMESPUN_URL` (or nothing) in the environment.

Override per-invocation with `--url <url>` and `--api-key <key>`.

## Commands

Uniform `homespun <noun> <verb> [options]` (`data` takes its collection
before the verb: `homespun data <app> <collection> <verb>`).

App commands, each operating on a deployed app:

```
homespun deploy [dir|file]  Create or redeploy an app (POST /v1/apps, or
                            /v1/apps/:id/versions with --app)
homespun apps <verb>        App lifecycle: list, show, update, share-link,
                            delete, wake, domain, watch (the change feed as
                            JSON-lines)
homespun data <app> <collection> <verb>
                            Collection row CRUD: list, get, upsert, update,
                            delete, purge, import, retention
homespun members <verb>     App membership: add, list, set-role, remove, roles
homespun grants <verb>      Grant-link management: mint, list, revoke
homespun ingest <verb>      Inbound catch-hook management: list, rotate,
                            signing-secret, backfill
```

Other command groups:

```
homespun publisher <verb>  Your community publisher identity: claim, show,
                           update, set-trust
homespun template <verb>   Community marketplace templates: publish,
                           unpublish, config-contract, install, list-pending,
                           show, approve, reject
homespun review <verb>     Community template reviews: create, respond,
                           report, remove, unhold
homespun key <verb>        Your agent's own API key: list, mint, revoke
homespun taste <verb>      Your agent's UI taste notes: get, set, clear
homespun feedback <verb>   One-shot feedback to the relay operator: create, list
homespun attachment <verb> Binary attachments: upload, download, show, list,
                           delete, token mint | revoke | list
homespun agent <verb>      This agent's identity on the relay: register,
                           claim, set-key, logout
homespun config <verb>     CLI config and profile management: show, list,
                           use, add, rm
homespun skill <verb>      The relay's SKILL.md: show, version
```

Run `homespun <noun> --help` for that noun's verbs, and
`homespun <noun> <verb> --help` for verb-specific options. The same table
also drives the generated [CLI reference](https://docs.homespun.dev/agents/cli-reference/).

## Output

stdout is JSON. Errors go to stderr as `{"error":{"code","message"}}` with a
non-zero exit. A deploy, then a read of the data it wrote back:

```sh
homespun deploy ./grocery-list
# -> { app_id, slug, url, version, visibility: "private", created: true }

homespun data grocery-list items upsert --data '{"name":"Milk","checked":false}'
# -> { row: { key, data: { name: "Milk", checked: false }, version: 1, author, created_at, updated_at } }

homespun data grocery-list items list
# -> { rows: [...], next_cursor, has_more }
```

## Links

- Docs: <https://docs.homespun.dev>
- License: [MIT](LICENSE)
