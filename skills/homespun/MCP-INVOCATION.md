<!-- homespun skill v1.6.60 -->

# homespun (MCP)

`homespun` deploys real software for the people you work for. You author an HTML
page plus a manifest, the relay puts it live as a multi-user web app at its own
link with magic-link sign-in, a shared database with a live change feed,
per-role permissions, email notifications and file uploads. You keep read and
write access to that app's data afterwards, so you can keep operating and
improving it in later conversations.

You are talking to Homespun over the **Model Context Protocol**, so every
operation is an MCP **tool call**, not a `homespun ...` shell command. The
conceptual core below (when to deploy an app, the collection model, schema
design, permissions, the house style) is identical regardless of how you invoke
it. This section is the thin invocation layer: which tool to call for each step.

## The loop, as tool calls

1. **`deploy_app`** puts the app live and gives you a URL. Pass `manifest` plus
   either `html` (inline) or `html_path`. Omit `app_id` to create; pass `app_id`
   to redeploy the same app to the same URL. Add `dry_run: true` to validate the
   bundle without shipping it.
   **On a redeploy, send only what changed.** Every content field is optional
   once `app_id` is given, and an omitted one keeps what is live: omit
   `manifest` for an HTML-only change, omit `html` for a manifest-only change,
   omit `assets` to keep the current files. That is the whole saving, because an
   omitted field costs no output tokens at all, so a one-line edit should never
   resend the document and a manifest edit should never resend it either.
   `assets: []` clears the asset set, and omitting all three is refused (there
   would be nothing to change). A create requires both `html` and `manifest`:
   there is nothing to inherit yet.
2. **Give the URL to the owner**, and have them invite anyone else with
   **`members`** (`action: add`) or mint a link with **`grants`**.
3. **Read and write the app's data** with `list_rows`, `get_row`, `upsert_row`,
   `update_row` and `delete_row`. This is the same data the page sees, live.
4. **`get_feed_events`** tells you what changed, from any writer, human or
   agent.
5. Iterate: call `deploy_app` again with `app_id` to ship a new version. The URL,
   the members and the data all survive.

## Tool map

| You want to...                                     | MCP tool call |
|----------------------------------------------------|---------------|
| Deploy an app, or redeploy one in place             | `deploy_app` (omit `app_id` to create, pass it to redeploy) |
| List / show / update / delete apps, wake a dormant one, manage a custom domain | `apps` (action: `list`/`show`/`update`/`share_link_rotate`/`delete`/`wake`/`domain_set`/`domain_status`/`domain_remove`) |
| List rows in a collection, or poll it for changes   | `list_rows` |
| Read one row by key                                 | `get_row` |
| Create a row (or get back the existing one)         | `upsert_row` |
| Replace a row's data                                | `update_row` |
| Soft-delete a row                                   | `delete_row` |
| See what changed, across all collections            | `get_feed_events` |
| Invite people, list them, change or remove a role   | `members` (action: `add`/`list`/`set_role`/`remove`/`roles`) |
| Mint, list or revoke a capability link              | `grants` (action: `mint`/`list`/`revoke`) |
| Mint, list, pause, resume, rotate or revoke a scoped service credential (point your own backend at an app) | `credentials` (action: `mint`/`list`/`pause`/`resume`/`rotate`/`revoke`) |
| Create, list or delete an outbound webhook connection | `connections` (action: `create`/`list`/`delete`/`consent_url`) |
| Manage inbound catch-hooks                          | `ingest` (action: `list`/`rotate`/`set_signing_secret`/`clear_signing_secret`) |
| Upload / fetch / download binary attachments        | `attachments` (action: `upload`/`fetch`/`presign`/`finalize`/`download`/`show`/`list`/`delete`/`mint_token`/`revoke_token`/`list_tokens`) |
| Read / write the owner's UI taste notes             | `taste` (action: `get`/`set`/`clear`) |
| Inspect, mint or revoke your API key                | `key` (action: `list`/`mint`/`revoke`) |
| Report a problem with homespun itself, or ask for something missing | `feedback` (action: `create`/`list`), see "Reporting a problem with homespun itself" below |
| Identity: whoami / claim / logout                   | `agent` (action: `whoami`/`claim`/`logout`) |
| Publish, unpublish or install a community template  | `community` (action: `publish`/`unpublish`/`get_config_contract`/`install`/...) |
| Manage your public publisher handle and profile     | `publisher` (action: `claim`/`get`/`update`) |
| Rate, review or respond to community templates      | `review` (action: `create`/`respond`/`report`/`remove`/`unhold`) |
| Re-read this guide, or just its version             | `get_skill` (unauthenticated) |

There is no `create_app`, `get_events`, `send_to_app`, `list_records`,
`participant`, `share`, `template`, `trash` or `run_query` tool. Those were the
v1 surface and they are gone. If you remember them, use the table above.

## Before you author: two cheap calls that improve every app

- **`get_skill`** (this guide) carries the collection model, the manifest
  grammar (`x-homespun-manifest`, with its `collections` map and its role
  lists), and the house style. You are reading it now; re-read the core below
  before designing a non-trivial app.
- **`taste` (action: get)** returns the owner's recorded presentation
  preferences ("denser tables", "always dark"). They **override** the default
  house style. When you get presentation feedback, persist it with
  `taste` (action: set), which is a whole-document replace, not an append.

## Search before you generate

Before writing an app from scratch, call **`community`** (`action: install` on a
`ref` you already know, or browse the template gallery) to see whether a
suitable template already exists. Installing a template gives the owner a
working app immediately, which you can then redeploy with your own changes.
Author from scratch when nothing fits.

## Watching for changes (no streaming in MCP)

MCP is request/response, so there is no persistent `watch`. Two cursor-poll
loops replace it:

- **The change feed.** `get_feed_events` with no `since` first; keep the
  returned `cursor`, then call again with `since: <cursor>` and `wait: 25` so
  the relay long-polls (`wait` is 0 to 30 seconds, and it is the only
  long-polling parameter in the whole surface). A `since` older than the
  retention floor comes back as `resync_required`; recover by re-listing with
  `list_rows`.
- **One collection.** `list_rows` with the prior `next_cursor` as `since`
  returns only newer or changed rows. `list_rows` has no `wait` parameter, so
  poll it on your own schedule.

If you run under a harness that can hold a long-lived process (Claude Code, for
instance), prefer the `homespun` CLI's `homespun apps watch` for true streaming.
Over a pure MCP transport, long-poll as above.

## Attachments, in brief

`attachments` (action: upload) reads an absolute `file_path`; action: download
writes to an absolute `out_path` or returns base64. For real media, prefer
`presign` then a direct PUT then `finalize`, which avoids moving bytes through
the tool call. To let a browser fetch bytes without your API key, `attachments`
(action: mint_token) returns a `/b/<token>` URL; put it in row data and point an
`<img src>` at it. See the attachment section in the core guide for the
declare-then-reference pattern and the inline-bytes warning.

---

The rest of this document is the **transport-agnostic core**, the same
conceptual material the CLI skill carries, with the command grammar stripped.
Read it before authoring.
