# @homespunapps/cli

Command-line client for the [Homespun](https://homespun.dev) relay:
hand a human a rich interactive UI by URL and capture their answer as structured
data — from any agent (cron job, chat bot, CI, headless server).

## Install

```sh
npm install -g @homespunapps/cli
# or, no install:
npx @homespunapps/cli <command>
```

The binary is `homespun`.

## Try it

Register once, then `homespun demo` spins up a short-lived sample app on the hosted
relay, opens it in your browser, and prints the structured event back in your
terminal the moment you interact (the demo app is cleaned up on exit):

```sh
npx @homespunapps/cli agent register --name "my-agent"   # one-time, hosted relay
npx @homespunapps/cli demo                               # Node 20+ — round-trip in ~60s
```

Add `--no-open` on a headless / SSH box and it just prints the URL.

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

Uniform `homespun <noun> <verb> [options]`:

```
homespun demo                      Zero-setup guided tour — see the round-trip live
homespun agent register            Provision an agent API key (browser approval
                                   by default; --no-device for direct) and save it
homespun agent claim <code>        Bind this agent to a human via a one-shot code
homespun agent logout              Clear the locally-saved URL + API key
homespun create            Create an app — returns app_id, urls, tokens
homespun show <id>         Non-blocking snapshot: metadata + event log
homespun send <id>         Emit an agent event into an app
homespun watch <id>        Stream an app's events as JSON-lines on stdout
homespun delete <id>       Close / delete an app
homespun template <verb>           Manage reusable, versioned templates
homespun key list | revoke         Inspect or revoke your agent's API key
homespun taste get | set | clear   Read / write / clear UI-taste notes
homespun feedback create | list    Submit / list one-shot feedback to the operator
homespun config show               Show the resolved relay config (no network call)
homespun skill show | version      Fetch the relay's SKILL.md (or its version)
```

Run `homespun <noun> --help` for that noun's verbs, and
`homespun <noun> <verb> --help` for verb-specific options.

## Output

stdout is machine-readable JSON. Errors go to stderr as
`{"error":{"code","message"}}` with a non-zero exit.

```sh
SESSION=$(homespun create --template ./form.html --name "Quick poll" --event-schema ./q.json | jq -r .app_id)
homespun watch "$SESSION" | jq 'select(.type == "human_response")'
```

## Links

- Docs: <https://docs.homespun.dev>
- License: MIT
