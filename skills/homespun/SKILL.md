---
name: homespun
description: >-
  Deploy a real multi-user web app from this conversation, then keep operating
  it. You author an HTML page plus a manifest; `homespun deploy` puts it live on
  its own URL with magic-link sign-in, a shared realtime database, per-role
  read/write/delete permissions, email notifications and file uploads. Owners
  invite other people, who sign in and use it together. You keep read and write
  access to the app's data and its change feed afterwards, so you can query it,
  write to it, watch it and redeploy it in later conversations. Use when the work
  deserves a persistent app people can return to and share, rather than a reply.
  Drives the `homespun` CLI: deploy, read/write data, watch for changes.
---

<!-- homespun skill v1.6.37 -->

# homespun

`homespun` deploys real web apps for you and keeps you connected to them. You
author an HTML page plus a manifest (what data it stores, who may read and write
each part of it), `homespun deploy` puts it live on its own URL, and the relay
supplies the parts you would otherwise have to build: sign-in, a shared database
with a live change feed, per-role permissions, email notifications and file
uploads. The owner invites whoever should have access, and they use it together.

You stay a first-class participant afterwards. Through the exact same collection
API the page itself uses, you can read the app's data, write to it, watch its
feed, and redeploy a new version to the same URL in a later conversation. The app
does not end when this conversation does.

## When to use this

Use `homespun` when the interaction is richer than a text reply, OR when it
should **persist**, OR when **more than one person** needs it: a dashboard
someone reopens next month, a list a household or a team edits together, an
intake form whose submissions you keep reading, a tool that outlives this
conversation. For a one-shot question, just ask in text.

There is no separate "form" primitive: a single-collection app with one page is
how you do the small case, and it is still a real app with a URL, sign-in and
data you can come back to.

## Setup

**This section is first for a reason.** Everything below it assumes a working
`homespun` command and a key. If you were pointed here to "set up Homespun",
this is the whole of it: two commands, then "Registering" for the sign-in.

If the `homespun` command isn't on your PATH yet, install it first:
`npm i -g @homespunapps/cli`.

The hosted relay (`https://homespun.dev`) is the default: `homespun agent register`
works out of the box. The CLI needs:

- **An agent API key.** Either pre-provided by the operator (as
  `HOMESPUN_API_KEY`), or obtained yourself via `homespun agent register` (see
  "Registering" below). Once registered, the key is saved to the config file
  and you don't need `HOMESPUN_API_KEY` at all.
- **A relay URL.** Only relevant for self-hosters: set `HOMESPUN_URL` (or pass
  `--url`) to point at a non-hosted relay. Note this is the **control-plane**
  URL (where `deploy`/`apps`/`data` talk); the *deployed app itself* is
  served on its own domain (see "Serving and security" below), not under
  this URL.

Output is JSON on stdout. Errors are `{"error":{"code","message"}}` on stderr
with a non-zero exit.

<!-- homespun:core:start -->

## The data model: collections and the change feed

An app's *storage* is built from one primitive. Everything an app stores is a
**collection**, a named, mutable, queryable set of rows, each with a `key`, a
`data` payload, an optimistic-lock `version`, and an `author`. Every write
(create, update, delete) also lands on the app's **change feed**, an ordered log
you and the page can both subscribe to. One data primitive, one feed. There is no
separate "event" type and no template/app split: an app IS its HTML plus its
manifest plus its collections.

That covers storage only. An app also has an identity layer (sign-in, an owner,
members and roles), permissions expressed per collection and per operation, email
notification rules, scheduled sends, inbound webhooks and binary attachments. All
of those are declared in the same manifest and documented below.

**Append-only collections are how you get "events."** If you want an
audit trail or a one-shot journaled fact ("this happened") rather than a
mutable row, declare the collection `appendOnly: true` in the manifest (see
below) and only ever `create` into it, never `update`/`delete`. You get
exactly what a v1 "event" gave you (an ordered, immutable, replayable log),
expressed through the same collection API instead of a second primitive.

The three things you build:

1. **A manifest**, which declares the app's collections (with row schema and
   which roles may read, write and delete each), who the app is visible to,
   which email notifications it sends, which external hosts its page may fetch
   from, and whether it may load CDN scripts/styles.
2. **An HTML page**, which talks to its own data exclusively through
   `window.homespun.collections.*` and `window.homespun.feed`, injected by the
   relay at runtime, and reads who is signed in from `window.homespun.session`.
3. **Deploys**: `homespun deploy` puts the app live; `homespun deploy --app <id>`
   redeploys it in place, same URL.

After that, you (the agent) read and write the same collections the page
reads and writes, via `homespun data`, and watch the app's live feed via
`homespun apps watch`. You see the same data the people using the app see, from
the CLI.

**`homespun.collections` is a FLAT API, not per-collection objects.** Every
method takes the collection NAME as its first argument. There is NO
`homespun.collections.<collectionName>` object: `homespun.collections.bookings`
is `undefined`. Always pass the name as a string:

```js
homespun.collections.create("bookings", { name, slot });   // server mints the key
homespun.collections.snapshot("bookings");                 // returns the rows (array)
homespun.collections.get("bookings", key);                 // one row, or undefined
homespun.collections.on("bookings", (delta) => { ... });   // live deltas; returns unsubscribe
homespun.collections.update("bookings", key, data);        // optimistic-locked update
homespun.collections.delete("bookings", key);              // soft-delete (tombstone)
```

So `homespun.collections.snapshot("bookings")` returns the rows, but
`homespun.collections.bookings.snapshot()` throws (there is no `.bookings`
object to call `.snapshot()` on). Same for every method: the name is an
argument, never a property.

**Querying a collection server-side (`list`).** `snapshot` returns the whole
in-memory mirror; `homespun.collections.list(name, { where, sort, limit })` is a
NETWORK read that asks the relay to **filter and order DB-side** and return a
page - use it to fetch just a subset (a status, a date range) without pulling
everything into the mirror. `where` is an **AND** of `{ field, op, value }`
conditions; `op` is one of `eq` / `neq` / `in` / `notIn` / `gt` / `lt` / `gte` /
`lte`, with the **same pinned comparison semantics as a notify `when`** (same-
type only, no coercion, dates compared as ISO-8601 strings; `in`/`notIn` take a
non-empty array). `sort` is a `{ field, dir }` list (`dir` `"asc"`/`"desc"`).

```js
const page = await homespun.collections.list("tasks", {
  where: [
    { field: "status", op: "in", value: ["open", "blocked"] },
    { field: "due", op: "lte", value: "2026-01-31" },
  ],
  sort: [{ field: "due", dir: "asc" }],
  limit: 50,
});
// page.rows, page.next_cursor, page.has_more
```

The agent side is the same query over the CLI: `homespun data <app> <coll> list
--where '<json-array>' --sort '<json-array>'`. Two rules to know:

- **The filter never widens what you can read.** Read permission + any row
  scoping are applied FIRST, then the filter - so a filtered list is always a
  **subset** of what you could already read. A caller who cannot read the
  collection is refused (`collection_read_forbidden`) whether or not a filter is
  present. **Field names are restricted** to simple identifiers (letters,
  digits, `_`) and both field names and values are passed to the database as
  bound parameters, so a query can never be used for injection.
- **Pagination.** A `where` filter works with the normal `since`/`next_cursor`
  cursor. A custom `sort` returns a single page (raise `limit` to see more) and
  cannot be combined with `since` in this version. Arbitrary-field filtering is
  currently unindexed, so keep collections that you filter heavily modest in
  size.

**The row shape you read back.** Every row the page reads (via
`homespun.collections.snapshot(name)`, `homespun.collections.get(name, key)`,
and the `row` on an `upsert` delta from `homespun.collections.on(name, ...)`)
is a `HomespunRow` with exactly these fields, camelCase, translated from the
snake_case wire at the SDK boundary:

```ts
{
  key: string;        // server-minted row id
  data: unknown;      // the payload you wrote
  version: number;    // optimistic-lock counter
  author: { kind: "human" | "agent" | "grant" | "visitor" | "anon"; id: string };
  createdAt: string;  // ISO 8601 timestamp (camelCase, NOT created_at)
  updatedAt: string;  // ISO 8601 timestamp (camelCase, NOT updated_at)
}
```

The row's `author` is **server-stamped and tamper-proof**, but read the name
carefully: it records who wrote the row **LAST, not who created it**. Every
update rewrites it, so a row Alice created and Bob (or your own agent) later
edited comes back with Bob as its `author`, and Alice is not recorded anywhere
on the row afterwards. `createdAt` tells you WHEN a row was created; nothing on
the wire tells you by WHOM. If you need "the person who created this row" as a
permission boundary, that is the `creator` subject in the manifest (see "Who may
change a row" below), enforced server-side, not a field you read back here.

Its `kind` is one of `"human"`, `"agent"`, `"grant"` (a grant-link holder),
`"visitor"` (a recognised anonymous visitor on a public/link app, see "Visitors:
recognising someone with no account"), or `"anon"` (the sentinel for a writer
with no identity at all: an app that mints no visitor identity, and every row
written before visitor identities existed). **That is a DIFFERENT enum from
`homespun.session.kind`**, whose values are `"owner"`, `"member"`, and
`"anonymous"`. So do not special-case `row.author.kind === "anonymous"` to
mirror the session enum: it silently never matches, because a row author uses
`"anon"`. Resolve an author to a display name with
`homespun.members.nameFor(row.author)`.

Storing a self-declared name is fine and is not the same thing as attribution:
a guestbook, RSVP, or booking legitimately keeps the responder's stated name
in `data` (e.g. `data.name`), and you should render it as what they called
themselves. The one rule is that a self-declared field is never PROOF of who
wrote the row. Render `data.name` as their stated name and
`homespun.members.nameFor(row.author)` as who actually wrote it last
(server-stamped); never treat the former as the latter.

**Anonymous visitors on a PUBLIC (or LINK) app get a session automatically,
with no login.** The relay hands every visitor an anonymous session
(`homespun.session.kind === "anonymous"`), and a collection whose `write` list
includes `"anyone"` accepts writes from those anonymous visitors. That is what
makes public forms (bookings, RSVPs, contact submissions) work: any visitor
can `homespun.collections.create("bookings", ...)` with no per-visitor token,
no login, and no participant to mint first. (You will NOT see a `GET
/_hs/session` error for these visitors: on a public/link app that endpoint
answers 200 with an explicit anonymous marker rather than an alarming 401.)

**A PRIVATE app gates anonymous visitors with a sign-in page automatically. A
PUBLIC (or LINK) app does not: it serves the page straight to them, with no
sign-in prompt anywhere.** That is the point of public, but it has a
consequence you must design for: **if a public/link app has ANY owner-only or
member-only surface (a `read: ["owner","agent"]` collection, an admin panel,
a moderation view), the page MUST render its own sign-in control, or the owner
can never reach it.** They will open their own app, be handed an anonymous
session like everybody else, and stay `kind: "anonymous"` forever. Nothing in
the platform offers them a way in on a public app; only your page can.

The control is one line: `homespun.session.login()` (see "Recipe: public
submits, only the owner reads"). Note also that sessions are **per-origin**:
being signed in on the main site does NOT sign a person in to
`<slug>.<usercontent-domain>`. Only the `/authorize` hand-off `login()`
triggers creates an app session on the app's own origin.

**Email a person when a collection changes (`notify`).** Declare a `notify`
array in the manifest to have the relay send a plain-text email when a row is
created or updated. This is declarative: you write the rule, the relay resolves
the recipients and sends. In this phase the only recipients are **`owner`** (the
app's owner) and **`members`** (the app's non-owner members) - always resolved
to the *verified account email on file*, never an address from the manifest or
the row, so a manifest can never email an arbitrary stranger.

```json
"notify": [
  {
    "on": "create",
    "collection": "bookings",
    "to": ["owner"],
    "subject": "New booking: {{name}}",
    "body": "{{name}} booked {{slot}}."
  },
  {
    "on": "update",
    "collection": "bookings",
    "when": { "field": "status", "changedTo": "confirmed" },
    "to": ["owner", "members"],
    "subject": "Confirmed: {{name}}",
    "body": "{{name}}'s booking for {{slot}} is now confirmed."
  }
]
```

Rules of the road:

- **`on`** is `"create"` or `"update"`. **`collection`** must be one you declared.
- **`to`** is a non-empty array of **roles** - `"owner"`, `"members"`, and/or
  `"submitter"`. A literal email address is always rejected at deploy. `"owner"`
  and `"members"` resolve to *verified account emails*. `"submitter"` (see
  "Confirmation emails" below) emails the person who submitted the row, at the
  address they themselves entered - it is only allowed when the rule declares a
  `submitterEmailField`, and only when the operator has enabled the external
  path (otherwise the rule is rejected at deploy with `notify_submitter_not_enabled`).
- **`when`** is optional and holds exactly ONE operator besides `field`. The
  *level* forms fire whenever the after-write value satisfies the comparison:
  `equals` / `notEquals` (`{ "field": "x", "equals": "v" }`), `in` / `notIn`
  (`{ "field": "status", "in": ["paid", "shipped"] }`, a non-empty array), and
  `gt` / `lt` / `gte` / `lte` (`{ "field": "amount", "gte": 100 }`). The one
  *edge* form, `{ "field": "x", "changedTo": "v" }`, fires only on the
  *transition* into that value (`update` only) - so "status BECAME confirmed"
  emails once, not on every later save where it is already confirmed. Omit
  `when` to fire on every create/update.
  - **Comparison semantics (pinned).** Comparisons are **same-type only and
    never coerce**: a stored number never matches a string operand and vice
    versa. Numbers compare numerically; strings (and **dates written as ISO-8601
    strings**, e.g. `"2026-01-31"`) compare lexicographically. A **missing or
    null field never fires any operator** - including `notEquals`/`notIn`, so a
    row that lacks the field is never treated as "not equal".
  - **`field`** names one of the row's OWN top-level keys - the same single-row,
    top-level-only scope the `{{fieldKey}}` templates use. There are no nested
    paths (`a.b`), no array indexing, and no cross-row aggregates ("email me when
    there are 10 signups" is not expressible in a `notify` rule; count
    client-side or in the agent instead).
- **`subject`** / **`body`** are plain-text templates. The only dynamic piece is
  `{{fieldKey}}`, interpolating one top-level row field as literal text (a
  missing field renders empty; there are no expressions, paths, or HTML). Values
  are escaped, so a submitted value can never inject into the subject or a mail
  header.
- A burst of writes to one rule is **coalesced into a single digest email** per
  recipient, and each app has an hourly send cap - so a flood of public
  submissions can't bury an owner's inbox. A failed send never affects the
  write; the row is saved regardless.

**Confirmation emails to the submitter (`to: ["submitter"]`).** To email the
person who submitted a public form - an order/booking/signup confirmation - add
`"submitter"` to `to` and declare **`submitterEmailField`**, the name of the row
field that holds the email address they entered. The relay emails *that row's
own submitted address, and only that address*.

```json
"notify": [
  {
    "on": "create",
    "collection": "signups",
    "to": ["submitter"],
    "submitterEmailField": "email",
    "subject": "Thanks for signing up, {{name}}",
    "body": "We received your signup and will be in touch."
  }
]
```

How the consent + anti-abuse rules keep this safe:

- **Consent gate.** `"submitter"` is allowed **only** when the rule declares a
  `submitterEmailField`, and (when the collection has a schema) that field must
  be a real declared field of the collection. A `to: ["submitter"]` rule without
  `submitterEmailField` is a hard deploy error. The address is read from the row
  the submitter themselves wrote - the manifest can never *name* an address, so a
  confirmation can never be aimed at the owner, a member, or any third party.
- **Own-address-only.** The recipient is always the row's own
  `submitterEmailField` value. If that value is missing, blank, or not a plausible
  email, the confirmation is silently dropped (nothing is sent, nothing retries).
- **Single-use.** A given row is confirmed **at most once per rule**, even if the
  row is later updated - a row edit never re-spams the submitter. (Use two
  distinct rules if you want a separate confirmation-vs-update email.)
- **Per-app daily cap.** External confirmations are bounded by a per-app daily
  cap, separate from the owner/member hourly cap, so a flood of public
  submissions cannot spray unbounded confirmation mail.
- **Operator flag.** The whole external path is gated behind the relay's
  `NOTIFY_EXTERNAL_ENABLED` setting. While it is off (the default), any
  `to: ["submitter"]` rule is rejected at deploy. The hosted relay has it enabled.

**Email a reminder on a date (`schedules`).** Where `notify` fires on a change,
`schedules` fires on a **date**: declare a `schedules` array to have the relay
email the owner/members a set number of days before, on, or after a date stored
in a row. A once-a-day scan at **08:00 in the app's time zone** finds rows whose
`dateField + offsetDays` equals today and sends. Recipients resolve to verified
owner/member emails exactly like `notify`, and delivery reuses the same digest +
hourly cap, so a schedule can never email a stranger either.

```json
"schedules": [
  {
    "collection": "bills",
    "dateField": "dueDate",
    "offsetDays": -3,
    "to": ["owner"],
    "subject": "Bill due soon: {{name}}",
    "body": "{{name}} ({{amount}}) is due on {{dueDate}}."
  }
]
```

Rules of the road:

- **`collection`** must be one you declared; **`dateField`** must be a field of
  it holding a calendar date (an ISO `"YYYY-MM-DD"` string is ideal; a full ISO
  datetime or epoch-millis number is interpreted in the app's time zone; an
  unparseable/missing value is skipped, never fired).
- **`offsetDays`** is an integer: **negative = before** the date (`-3` = "3 days
  before"), **`0` = on the day**, **positive = after**. The reminder fires when
  `dateField + offsetDays` is today in the app's time zone.
- **`to`** is a non-empty array of `"owner"` and/or `"members"` (same closed role
  set as `notify`; `"submitter"` and literal addresses are rejected).
- **`when`** is an optional *level* condition evaluated against the row on the
  fire day - any of the level operators `equals` / `notEquals` / `in` / `notIn` /
  `gt` / `lt` / `gte` / `lte` (same pinned same-type, no-coercion, dates-as-ISO-
  strings semantics as `notify`), e.g. only remind while `status` is `"unpaid"`,
  or while `amount` is `{ "gte": 100 }`. (The `changedTo` *edge* form is not
  valid here, since a scheduled scan has no before-state.) Omit `when` to remind
  for every row.
- **`subject`** / **`body`** are the same `{{fieldKey}}` plain-text templates as
  `notify`.
- **Recurrence is client-driven**: the relay is a dumb date-matcher and fires a
  given row **exactly once per date** (a re-scan, restart, or replica never
  re-alerts). For a recurring reminder, have your page advance the date field
  after each occurrence (e.g. set `nextDue = lastDone + interval`); the next
  date then becomes the next reminder.
- The app's **time zone** is an IANA name like `Europe/Berlin`; unset means UTC,
  so every reminder fires at **08:00 UTC** until you set one. Deploying an app
  that declares `schedules` with no time zone set returns a `warnings[]` entry in
  the deploy result saying exactly that. Set the zone with `homespun apps update
  <app> --timezone <IANA zone>` (it then shows up under `homespun apps show`).
  Free apps have a per-day reminder cap and a rule-count cap, both modest by design.

**POST to a URL when a collection changes (`webhooks`).** The machine-consumer
sibling of `notify`: same trigger grammar, but instead of emailing a person the
relay fires a signed HTTP `POST` to a URL you name, so you can push row changes
to Slack, Zapier, or another agent. Declare a `webhooks` array in the manifest.

```json
"webhooks": [
  { "on": "create", "collection": "orders", "url": "https://hooks.slack.com/services/T00/B00/xxxx" },
  {
    "on": "update",
    "collection": "orders",
    "when": { "field": "status", "changedTo": "shipped" },
    "url": "https://api.example.com/hooks/orders"
  }
]
```

Rules of the road:

- **`on`** is `"create"` or `"update"`; **`collection`** must be one you declared;
  **`when`** is the SAME optional condition grammar as `notify` - the level forms
  (`equals` / `notEquals` / `in` / `notIn` / `gt` / `lt` / `gte` / `lte`) and the
  `changedTo` edge form (`update` only), with the same pinned comparison
  semantics. Omit `when` to fire on every create/update.
- **`url`** is required and must be a **public `https://` URL** with no
  `user:pass@` userinfo and no IP-literal host (a DNS name only). A path and
  query are allowed. At send time the relay re-resolves the host and refuses any
  target that resolves to a loopback / private / link-local / CGNAT / cloud-
  metadata address, and it never follows a redirect (a 3xx is a failed attempt) -
  so a webhook cannot be turned into a request against your internal network.
- The feature is **gated** (off until the operator flips `WEBHOOKS_ENABLED`) and,
  once on, delivery is **immediate** (no digest window), retried with exponential
  backoff, and bounded by a per-app hourly cap.

**The payload** is a JSON body:

```json
{
  "app_id": "app_…",
  "collection": "orders",
  "op": "create",
  "feed_seq": 42,
  "delivery_id": "whd_…",
  "row": { "key": "…", "data": { }, "version": 1, "author": { "kind": "human", "id": "…" }, "created_at": "…", "updated_at": "…" },
  "sent_at": "2026-07-14T12:00:00.000Z"
}
```

**Signing + verification.** Every request carries these headers:

- `X-Homespun-Signature: t=<unixSeconds>,v1=<hex>` where `<hex>` is
  `HMAC-SHA256(secret, "<t>.<rawBody>")`.
- `X-Homespun-Event` (the op), `X-Homespun-Collection`, `X-Homespun-Delivery`
  (a stable idempotency key), `Content-Type: application/json`,
  `User-Agent: Homespun-Webhooks/1`.

The **signing secret** (`whsec_…`) is minted the first time you deploy a
non-empty `webhooks` list and returned to you on the **deploy response** and the
owner/agent app-detail read (`GET /v1/apps/:id` → `webhook_secret`). It is never
shown on any public path and never rotated automatically. Configure it on your
receiver, then verify each request:

1. Read `t` and `v1` from `X-Homespun-Signature`.
2. Recompute `HMAC-SHA256(secret, t + "." + rawRequestBody)` and compare to `v1`
   with a **constant-time** compare (e.g. `crypto.timingSafeEqual`).
3. Reject if they differ, or if `t` is too old (say more than 5 minutes) to
   bound replay.

Delivery is **at-least-once**: a receiver can see the same `X-Homespun-Delivery`
id twice (a retry after a slow 2xx, or a relay worker that crashed after the
POST but before it recorded the outcome), so treat that header as an idempotency
key and dedupe on it. The id is the delivery row's own id and is stable across
every attempt, which is what makes it usable as the key.

Two things a receiver must not do instead:

- **Do not dedupe on a hash of the body.** The signature timestamp `t` and the
  envelope's `sent_at` are regenerated for each attempt, so two sends of the
  same delivery have different bytes.
- **Do not rely on `delivery_id` in the body when the rule sets a
  `bodyTemplate`.** A custom body is sent verbatim and carries only what the
  template renders, so for those rules the header is the only key.

**Authenticated webhooks (`connection` + `bodyTemplate`).** A webhook can also
authenticate to its target with a stored credential and send a **custom JSON
body**, so you can write rows straight into a static-token CRM (HubSpot,
Airtable, Pipedrive) without a middleman.

Two optional fields on a rule:

- **`connection`**: the NAME of a stored credential (created out-of-band, see
  below). At send time the relay attaches that credential's header to the
  request. The manifest carries the **name only, never the secret**.
- **`bodyTemplate`**: a custom JSON body with `{{field}}` placeholders (one
  top-level row field each). Each placeholder is replaced with the **JSON
  encoding** of the value, so a value can never break out of its JSON position
  (this is the injection defence). Put each placeholder in a value position,
  unquoted: `{"email": {{email}}}`, not `{"email": "{{email}}"}`. A missing
  field renders as `null`. When set, the rendered body replaces the standard
  envelope.

```json
"webhooks": [
  {
    "on": "create",
    "collection": "leads",
    "url": "https://api.hubapi.com/crm/v3/objects/contacts",
    "connection": "hubspot",
    "bodyTemplate": "{\"properties\": {\"email\": {{email}}, \"firstname\": {{name}}}}"
  }
]
```

**Connections API** (owner-cookie OR owning-agent-key, on the main domain):

```
POST   /v1/apps/:id/connections     static: { name, allowedHost, headerName, headerValue, provider?, label? }
                                     oauth2: { name, kind:"oauth2", authorizeUrl, tokenEndpoint, clientId, clientSecret, allowedHost, scopes?, authScheme?, instanceField?, authParams?, tokenParams?, label? }
GET    /v1/apps/:id/connections     -> metadata only (never the secret)
DELETE /v1/apps/:id/connections/:name
```

- `headerValue` (e.g. `"Bearer sk_live_..."`) is **encrypted at rest** and is
  **never returned** by any endpoint. `GET` lists only metadata plus a
  non-reversible `secretFingerprint`.
- **`allowedHost` is host-binding**, the exfiltration defence: the credential is
  attached **only** when the delivery URL host matches it (an exact host such as
  `api.hubapi.com`, or a single leftmost wildcard such as `*.zohoapis.com`). If a
  rule's `url` is later repointed to another host, the delivery **fails and the
  token is never sent**. Host-binding composes with the SSRF guard (which still
  blocks internal addresses and redirects).
- Per-app connection cap (`MAX_CONNECTIONS_PER_APP`, default 20).
- `kind` defaults to `"static"`.

**OAuth2 connections (`kind:"oauth2"`, ANY provider).** The relay is a **generic
OAuth2 client**: YOU supply the whole provider config as data, so it works with
any OAuth2 service (Google, GitHub, Notion, Slack, a CRM, a custom API). There
are **no presets and no provider allowlist**, and you bring your own client
credentials. One-time setup:

1. **Register your own OAuth2 app** with the provider and read these off its app
   registration: the **authorize URL** and **token URL** (both `https`), your
   **client ID** + **client secret**, and the **scopes** you need. In the app,
   register this exact redirect URI:
   `<your-homespun-domain>/oauth/connections/callback`.
2. **Create the connection** with that config:
   - `authorizeUrl`, `tokenEndpoint`: the provider's endpoints (`https` only; a
     URL that resolves to a private/loopback/metadata address is rejected).
   - `clientId`, `clientSecret`: your app's credentials (the secret is encrypted
     at rest and never returned).
   - `allowedHost`: the API host the token may be sent to (host-binding).
   - `scopes` (optional): space-delimited scopes for the authorize request.
   - `authScheme` (optional, default `Bearer`): the scheme the access token is
     sent under (set e.g. `Zoho-oauthtoken` for a non-Bearer provider).
   - `instanceField` (optional): the name of a token-response JSON field that
     holds the API base URL (e.g. `instance_url` or `api_domain`). When set, the
     relay reads it after consent, re-binds `allowedHost` to that host, and
     resolves relative rule urls against it.
   - `authParams` / `tokenParams` (optional): extra key/values merged into the
     authorize redirect / the token POST (e.g. `{ "access_type":"offline",
     "prompt":"consent" }` to be issued a refresh token). They are URL-encoded
     and can never override a protocol-reserved parameter.

   Example (placeholder values):
   ```
   { "name":"my-crm", "kind":"oauth2",
     "authorizeUrl":"https://accounts.example.com/oauth/authorize",
     "tokenEndpoint":"https://accounts.example.com/oauth/token",
     "clientId":"abc123", "clientSecret":"s3cr3t",
     "allowedHost":"api.example.com", "scopes":"read write",
     "authParams":{ "access_type":"offline" } }
   ```
   The row starts in `pending_auth` with no tokens.
3. **Complete consent in a browser** as the signed-in **owner** (an agent key
   cannot): open `GET /v1/apps/:id/connections/:name/authorize`. It redirects you
   to the provider (PKCE + `state`); after you approve, the relay captures the
   tokens, binds `allowedHost` (to the `instanceField` host when set, else your
   supplied host), and flips the connection to `active`.
4. **Reference it by name** from a webhook rule, exactly like a static connection
   (`"connection": "<name>"`). A relative rule `url` is resolved against the
   captured instance base (requires `instanceField`); an absolute `https` url is
   used as-is (still host-bound). The relay refreshes the access token on demand
   before it expires; a revoked refresh token flips the connection to
   `needs_reauth` and the delivery fails rather than sending a stale token.
   Tokens are never returned by any endpoint or logged.

**Inspecting outcomes.** The relay captures a capped slice of the target's
response so you can read the CRM's created-id (2xx) or its validation error (4xx)
after the fact:

```
GET /v1/apps/:id/webhooks/deliveries?collection=&status=&limit=
```

Returns recent deliveries: `{ id, collection, rowKey, op, url, status, attempts,
responseStatus, responseBody, error, createdAt, deliveredAt, lastAttemptAt }`.
The `url` is host + path only (the query string is dropped) and the response
**never** includes the auth header or the connection secret.

**No credential? Use a catch-hook.** If you would rather not store a CRM token on
the relay at all, point a plain (no-`connection`) webhook at a Zapier / Make /
n8n **catch-hook URL** and let that automation platform hold the CRM credentials.
Zero auth on the Homespun side, and the same signed envelope arrives at the
catch-hook.

<!-- homespun:core:end -->


## Keeping this skill up to date

This skill carries its version in an HTML comment near the top of the file:

```
<!-- homespun skill vX.Y.Z -->
```

**The skill version is the homespun package version** (`@homespunapps/relay`,
`@homespunapps/cli`, `@homespunapps/core`, all kept in lockstep by the release
script). `scripts/cut-release.sh` updates this comment alongside the
`package.json`s and the CLI's `VERSION` constant, so every release
bumps the skill version even if the SKILL.md content didn't change.
That keeps "what relay am I talking to" and "what skill do I have"
answered by one number.

The relay you talk to publishes its own version of this skill at
`GET /skills/homespun/SKILL.md/version`. **At conversation start, check whether your
local copy is behind, and if so refresh it.**

The check is a short shell snippet:

```sh
LOCAL_VER=$(grep -m1 -oE '<!-- homespun skill v[0-9]+\.[0-9]+\.[0-9]+' <path-to-your-local-skill> | grep -oE '[0-9]+\.[0-9]+\.[0-9]+$')
REMOTE_VER=$(homespun skill version --plain)
# If the relay is on an old image that lacks a version comment, the probe
# returns "0.0.0". Don't clobber a newer local copy with the older relay
# skill; skip the update and proceed with what's local.
if [ "$REMOTE_VER" = "0.0.0" ]; then
  : # nothing to do
elif [ "$LOCAL_VER" != "$REMOTE_VER" ]; then
  homespun skill show > <path-to-your-local-skill>   # overwrites with the relay's current skill
fi
```

Where `<path-to-your-local-skill>` is wherever YOUR runtime stores the
homespun skill (e.g. `~/.claude/skills/homespun/SKILL.md` for Claude Code,
`~/.cursor/rules/homespun.mdc` for Cursor, the relevant section of
`~/.codex/AGENTS.md` for Codex / Gemini-style concatenated files).

The two `grep`s above are intentionally strict:

- `-m1` stops at the first match in the file, so prose mentions of the
  pattern (this very section!) don't double-count.
- `[0-9]+\.[0-9]+\.[0-9]+` only matches a real semver triple, so a
  literal `<!-- homespun skill vX.Y.Z -->` in documentation is skipped.

Rules:

- If the local file has no `<!-- homespun skill v... -->` comment, treat it as
  stale and run `homespun skill show > <path>`.
- If `REMOTE_VER` is `0.0.0`, skip the update: the relay is on an old
  image without a version comment, and clobbering your (presumably newer)
  local copy with that would be a downgrade.
- If the network is unreachable or `homespun skill version` fails, **do not
  update**: proceed with the local skill you have.
- Don't loop. Check once at conversation start; if you've already refreshed in
  this run and it's still mismatched, stop and report the error to
  the human.
- If you've hand-edited the local skill (added your own notes), save your
  changes first, because `homespun skill show > <path>` is a clobbering write.

## Discover the CLI with `--help`

**Before using a command, run its help.** This skill summarizes the workflow,
but `--help` is the authoritative, always-current reference for every flag,
argument, and default:

- `homespun --help`: the command list and global options.
- `homespun <command> --help`: every flag and option for that command, e.g.
  `homespun deploy --help`, `homespun apps --help`, `homespun apps watch --help`,
  `homespun data --help`.

If a command errors or you are unsure of an option name, **run `--help`
instead of guessing**: the CLI is self-documenting and the help text reflects
the installed version, which this skill may not.

### If `homespun` exits 75 ("CLI upgrade required")

The relay you're talking to needs a newer `@homespunapps/cli` than you have
installed. The CLI signals this with **exit code 75** (`EX_TEMPFAIL`) and a
stderr message that starts with `homespun: this relay requires @homespunapps/cli >=
<version>`. If that message includes a `To upgrade: <command>` line, the
command is correct for how `homespun` was installed on this machine, so there's
nothing to guess.

What to do, in this order:

1. **Run the printed upgrade command once.** If no command is printed (the
   message says "vendored" or "unknown" install), stop and ask the human to
   bump `@homespunapps/cli`; don't try to install one yourself.
2. **Re-run your original `homespun` command once.** If it succeeds, continue.
3. **If it still fails with exit 75 after one upgrade + retry**, stop and
   report the error to the human. Do not loop: repeated upgrade attempts
   in the same run are a bug, not a recovery strategy.

## Registering

If you weren't handed an API key, provision one yourself, **once**, with:

```sh
homespun agent register --name "<short-descriptive-agent-name>"
```

Pick a stable, descriptive name: it's how a human tells your agent apart from
other agents on the relay (e.g. `claude-code-lalit-macbook`, `ci-pr-review-bot`,
`telegram-helper`), and it's what the approval screen shows. If omitted, the
CLI defaults it to `cli-<hostname>`.

Self-hosters add `--url "$HOMESPUN_URL"` (or set `HOMESPUN_URL`) to target a
non-hosted relay.

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

<!-- homespun:core:start -->

## Authoring an app: the manifest

The manifest is a plain JSON Schema 2020-12 document with one namespaced
extension key, `x-homespun-manifest`. It is the **whole consent surface**: what
it declares is exactly what the relay enforces at runtime, so be as precise
as you can: unknown keys are hard rejected (a typo is a deploy-time error,
never silently ignored), and there are no implicit grants: `owner`/`agent`
are never auto-added to a permission list.

**Visibility is not a manifest field.** Whether an app is `private`, `link`,
or `public` is a deploy-time flag (default `private`; with the CLI,
`homespun deploy --visibility <private|link|public>`), not something you
declare in this manifest. There is no visibility key here to set, so don't go
looking for one when building a public app. The manifest governs what data the
app stores and who may write it; visibility governs who may open the app at all
(see "Serving and security").

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$defs": {
    "GroceryItem": {
      "type": "object",
      "properties": {
        "name": { "type": "string", "maxLength": 200 },
        "checked": { "type": "boolean" }
      },
      "required": ["name"]
    },
    "AuditEntry": {
      "type": "object",
      "properties": {
        "action": { "type": "string" },
        "detail": { "type": "string" }
      },
      "required": ["action"]
    }
  },
  "x-homespun-manifest": {
    "app": {
      "name": "Grocery list",
      "description": "Shared household grocery list",
      "icon": "🛒"
    },
    "collections": {
      "items": {
        "schema": { "$ref": "#/$defs/GroceryItem" },
        "read": ["owner", "member", "agent"],
        "write": ["agent", "owner", "member"],
        "delete": ["agent", "owner", "member"]
      },
      "audit": {
        "schema": { "$ref": "#/$defs/AuditEntry" },
        "read": ["owner", "agent"],
        "write": ["agent"],
        "delete": ["owner"],
        "appendOnly": true
      }
    },
    "externalHosts": ["https://api.example.com"],
    "cdn": false
  }
}
```

> **SAFETY: `read` is MANDATORY on every collection.** A deploy that leaves it
> off is refused, `permission_role_invalid`, naming the collection. This is not
> paperwork: an ABSENT `read` never meant "nobody can read", it meant EVERYONE
> who can open the app reads every row, which on a `public` or `link` app is
> every anonymous visitor on the internet. That default was taken up by silence
> rather than by choice on most collections ever deployed, so silence stopped
> being an available answer. Say which you mean:
>
> - `"read": ["owner", "agent"]` for anything a person would not want shown to
>   strangers (names, emails, phone numbers, messages, orders, bookings, any
>   personal data). Add `"member"` when staff read it too.
> - `"read": ["creator"]` for "everyone sees only their own rows".
> - `"read": ["anyone"]` when the data really is public. This is exactly the old
>   absent-key behaviour, written down, and it is perfectly legal: a menu, a
>   published schedule, a price list.
> - `"read": []` when nobody reads the rows through the data API at all (an
>   agent-written audit log you only ever read as the owner, for instance, would
>   still list `"owner"`).
>
> Pick the narrowest one that works. Every visitor can hit the data API
> (`GET /_hs/c/<collection>`) directly, so the page is never what protects the
> rows, the `read` list is.
>
> **Rule of thumb: collecting data FROM the public? Restrict who can READ it.**
> The "public submits, only the owner reads" recipe below is exactly this shape:
> `orders` sets `read: ["owner", "agent"]` because the submissions are private,
> while `menu` sets `read: ["anyone"]` because it is meant to be world-readable.
>
> Adding a `read` list to a collection that never had one is **never** blocked
> by the redeploy compat check. Silence already granted the widest scope there
> is, so any list you write is at most as wide, and a narrowing needs no
> re-consent. Bringing an older app into compliance is a plain redeploy.
> (An app published to the community before the key became mandatory still
> installs and trials fine; only a new deploy is held to the rule.)

Fields, exactly:

- **`x-homespun-manifest.app`**: `name` (required, ≤80 chars), `description`
  (≤280 chars), `icon` (a single **pictographic** emoji: a geometric/symbol/
  letter/digit codepoint such as the half-circle "◐" is rejected with
  manifest_invalid, "icon must be an emoji, not a letter, digit, or symbol").
  Shown to the human as the app's display
  identity, and used to build the served page's head identity automatically:
  the relay injects a favicon (`icon` rendered as an SVG, falling back to the
  Homespun mark), a `<title>`/meta description, and Open Graph / Twitter
  share-preview tags (a generated 1200x630 card from the name, description,
  and icon) into every served document. Any of these tags you write in your
  own HTML win: the relay never duplicates or overrides an author-supplied
  `<title>`, meta description, icon link, or og/twitter tag. Two optional
  keys tune this:
  - **`indexable`**: boolean, default `false`. Search indexing is OPT-IN:
    every app ships `noindex` (robots meta + `X-Robots-Tag` header, and its
    host's robots.txt disallows crawling) until you set `indexable: true` on
    a **`public`** app, which flips the robots.txt to allow, drops the
    noindex signals, and lists the app in the platform sitemap. The flag has
    no effect on `link`/`private` apps: their visibility is the access
    control and they are never indexable.
  - **`ogImage`**: an `https://` URL (≤2048 chars) used as the share-preview
    image (`og:image`/`twitter:image`) instead of the generated card. The
    relay never fetches it; it is only emitted as the meta-tag value.
- **`x-homespun-manifest.collections`**: a map of collection name →
  `{ schema?, read, write, update?, delete, countRead?, relations?, keyClaim?,
  immutable?, appendOnly?, unique?, retention?, mirror?, seedOnInstall? }`.
  An app may declare zero collections (a purely presentational app).
  - **`schema`**: `{ "$ref": "#/$defs/<Name>" }` into the document's own
    `$defs`. Optional: omit it for a schemaless collection (rows validated
    only at your own discretion). Cross-document refs are not supported.
    **A declared schema is STRICTLY ENFORCED:** any `create`/`upsert`/`update`
    whose `data` fails the schema is rejected `422 row_schema_violation`, with
    the failing JSON Schema paths listed in the error's `details`. Nothing in
    this block is advisory: `schema`, `write`, `update`, `delete`, `read` and
    `appendOnly` are all enforced by the relay on every request, through the
    same door for browser visitors and for you as the agent. A non-conforming
    write never lands.
  - **`write`**: required, non-empty array of roles that may CREATE rows in
    this collection (`create`, and the create half of `upsert`). It ALSO gates
    updates unless the collection declares its own `update` list, so on a
    collection with no `update`, `write` means "may add rows **and** may
    overwrite every row already in the collection, including other people's".
    Read "Who may change a row" below before you leave it that way.
  - **`update`**: optional array of roles that may change an EXISTING row
    (`update`, and the update half of an `on:`-field upsert). **Omitted means
    "same as `write`"**, so a collection that leaves it off is governed by
    `write` for both halves. Declare it to split adding from editing:
    `write: ["anyone"]` plus `update: ["creator"]` is "anyone may add a row,
    only the person who created it may change it", which `write` alone cannot
    express. It takes the same subjects `delete` does, including the
    row-scoped `creator` / `editor` / `author`, because by the time it is
    checked a target row exists. An explicit `update: []` is legal and means
    nobody may update: rows can be created and deleted but never edited. (For
    "never edited AND never deleted", use `appendOnly` instead, and use it
    *alone*: declaring `appendOnly: true` alongside any `update` list, empty or
    not, is rejected at deploy as a contradiction.)
  - **`delete`**: required, non-empty array of roles that may delete rows.
  - **`read`**: **required** array of roles. **It IS enforced, server-side, on
    every read** (list, single-row get, and the live change feed), exactly the
    way `write` and `delete` are. Semantics:
    - **Omitted**: rejected at deploy, `permission_role_invalid`, naming the
      collection. It used to be optional, and an omitted list meant anyone who
      could open the app could read every row: on a public/link app, every
      anonymous visitor. Nothing about that default has changed for apps that
      already carry it, and a stored manifest is still re-validated leniently so
      an app published under the older rule keeps installing. What changed is
      that you can no longer arrive at it by saying nothing. Write
      `"read": ["anyone"]` if that is what you want.
    - **`[]` (empty)**: legal, and the opposite of omitting it. Nobody may read
      the rows through the data API. Note that this includes you: an agent that
      needs to read the collection must list `"agent"`.
    - **Declared, and the caller holds one of the listed roles**: the read is
      allowed and returns every row.
    - **Declared, and the caller holds none of them** (including an explicit
      empty `read: []`): the read is refused `403 collection_read_forbidden`,
      whose `hint` names the roles the collection requires. This applies to the
      data API itself, so a visitor calling the collection endpoint directly is
      refused just as the page would be.
    - **A row-scoped `read`** (`["creator"]`, `["editor"]`, or the older
      `["author"]`) scopes reads to the caller's *own* rows: a list returns only
      the rows that match, and a get on a row that does not returns `404
      row_not_found` (the same error a missing key returns) rather than a 403,
      deliberately, so a caller cannot probe which keys exist. **Every other
      verb answers the same way**: an update, a delete, and a keyed upsert that
      lands on an existing row all return `404 row_not_found` for a row `read`
      does not reach for you, rather than a 403 (or, for the upsert, rather than
      the row body). The write doors never confirm a key the read door refused
      to confirm. On a row you *can* read, a refused update or delete still
      returns the honest `403 collection_write_forbidden` /
      `collection_delete_forbidden` with the roles that were consulted. **Prefer
      `creator`**: `editor` and `author` both mean "wrote it last", so the first
      time anyone else touches a row it drops out of its original writer's view.
      An anonymous visitor to a public/link app satisfies these through the
      per-browser visitor identity, so `read: ["creator"]` means "each visitor
      sees their own rows" (see "Visitors: recognising someone with no
      account"). A caller with no identity at all, including a visitor on an app
      that declares nothing a visitor could reach, is refused `403` outright.
    - Matching is **literal, with no implicit grants**: `read: ["owner"]` does
      not silently include `agent`, and under a bare row-scoped read list even
      the owner and you are scoped to your own rows unless you also list
      `"owner"`/`"agent"`.
    - `read` is applied **on top of** app visibility, never instead of it: a
      `private` app still requires a signed-in session before any read role is
      even considered.
  - **`countRead`**: optional array of roles. Opts the collection into a
    **count-only public aggregate**: the roles listed may read the collection's
    live row COUNT without being able to read the rows. It is fully independent
    of `read`, so the common shape is `read: ["owner"]` + `countRead:
    ["anyone"]`: the owner reads the rows, everyone sees only how many there
    are (the "3 spots left" counter without exposing who signed up). Semantics:
    - **Omitted** (default): no one may read the count; the endpoint refuses
      `403 collection_count_forbidden`. A collection never leaks a count it did
      not opt into.
    - **Declared**: a caller holding one of the listed roles may `GET
      /_hs/count/<collection>` (or call `homespun.collections.count(name)`) and
      gets `{ "count": N }`, the number of live rows only, never any row data
      and no field values. A plain-role list is a whole-collection total with
      no filtering, which is the "3 spots left" shape.
    - **A row-scoped subject returns the caller's OWN count.** `countRead`
      takes the same vocabulary `read` does: `countRead: ["creator"]` is "how
      many rows have I added", and a declared relation is "how many name me".
      The count is filtered by exactly the predicate the same subject filters a
      *list* by, so it can never include a row the caller could not have
      listed. This replaces the two-collection split apps used to write to fake
      a personal counter. A caller with no identity at all is refused rather
      than handed a zero.
    - It does **not** relax `read`: the rows stay exactly as protected as
      before, so this is safe to add to a collection that captures private
      submissions.
    - **Known leak, and it is on you to avoid it:** a whole-collection
      `countRead: ["anyone"]` beside a row-scoped `read` is an existence
      oracle. The rows are private, but a polled total moves by one on every
      create and delete, so on a low-volume collection an outsider learns when
      individual rows appear and vanish. If the number is meant to be personal,
      scope it (`countRead: ["creator"]`); publish the whole-collection total
      only when the total itself is genuinely public.
  - **`relations`**: optional object mapping a relation NAME to `{ "field":
    "<top-level field>", "set": "caller"? }`. Names a row scope of the
    collection's own: "the caller whose principal id is the value in this row's
    `<field>`". A declared name is then a permission subject in `update`,
    `delete` and `read`, bare or as `<role>:<relation>`, and rejected in `write`
    and `countRead` exactly like `creator`. `set: "caller"` makes the server
    stamp the field on create and refuse every later change to it; omit it to
    let the writer choose whom the row belongs to (the agent-writes-for-a-human
    shape). At most 8 per collection, and the field must be a declared,
    string-capable property when the collection declares a schema. See "Rows
    that belong to a person" below, which is where the recipes are.
  - **`keyClaim`**: optional string, one of `"free"` (default), `"server"` or
    `"caller"`. Decides **which row key a caller may claim** when creating a
    row, which `write` says nothing about. `"free"` is today's behaviour and is
    what you get by saying nothing: any key, and the first caller to a guessable
    one owns that slot for good. `"server"` refuses a caller-supplied key
    outright, so every key is minted by the relay. `"caller"` requires the key
    to **be** the caller's own principal id, which makes a one-row-per-person
    collection squat-proof by construction. See "Who may CLAIM a row key" below,
    which is where the recipes are; it is the first thing to reach for on any
    per-user collection.
  - **`immutable`**: optional array of up to 16 top-level field names, settable
    when the row is created and **frozen** afterwards. An update that omits one
    carries the stored value forward; one that sends a *different* value is
    refused `400 invalid_request` and nothing lands; sending it back unchanged
    is fine. It applies to every caller, `owner` and `agent` included, because
    it is a fact about the row rather than about who is asking. Use it to pin
    anything a permission rule is keyed on: a relation field without
    `set: "caller"` is chosen by whoever `write` admits, and without a freeze
    they can keep choosing after the fact. When the collection declares a
    schema, every name must be a declared top-level property of it.
  - **`appendOnly`**: optional, either a boolean (default `false`) or
    `{ "except": [...] }`. Set `true` for a journal/event-shaped collection:
    rows can be created but never updated or deleted. **This is enforced, not
    advisory:** an update or delete against an append-only collection is refused
    `403 append_only` for *every* role, including `owner` and `agent`, and that
    check runs before the role match, so an append-only violation reports
    `append_only` rather than a misleading "forbidden". Model an edit as a new
    row. Because that check runs first, `appendOnly: true` and an `update` list
    contradict each other and the deploy is **rejected** if you declare both:
    there is nobody left for the `update` list to admit. Pick one.
    - **`{ "except": ["owner"] }`** keeps all of that for everyone the list does
      not name, and lets the named roles update and delete under the
      collection's ordinary rules. Only `owner` and `agent` may be named: they
      are the two that can already remove a row from an append-only collection
      with a purge, so this hands out no reach they did not have, it lets them
      **correct** a row instead of only destroying it. **Prefer it over a bare
      `true` whenever a wrong row would otherwise be stuck in the app for
      good**, which is most journals: a mistyped entry in a `true` collection
      cannot be fixed by anybody, ever. An excepted role still has to satisfy
      the collection's own `update` / `delete` list, so the exception opens the
      gate rather than granting the verb, and an `update` list beside it is
      legal and meaningful.
  - **`seedOnInstall`**: optional boolean (default `false`). Only meaningful on
    a *template* (a published/first-party snapshot someone installs). Set `true`
    to pre-fill this collection with the template's starter rows when the
    template is installed: the new app is born with those rows already in it.
    Leave it off (the default) for a collection whose content the users
    themselves submit, so it installs empty. The starter rows live alongside
    the template, not in the manifest (first-party templates author a
    `templates/<dir>/seed.json`); this flag only decides *which* collections
    receive them at install. It is read once, at install time, and has no
    effect on a live app's later redeploys or on normal writes. Seeded rows are
    real rows: they count against the installing owner's quota and carry a
    synthetic template author, so no human or agent holds the `author` role on
    them. **Privacy:** if you later publish that app as a community template, the
    LIVE rows of its `seedOnInstall` collections are captured and become PUBLIC
    to every platform user once approved. So keep example-only starter data in a
    `seedOnInstall` collection, never real personal data (names, emails,
    addresses, private messages). When you publish, pass `attest_example_only:
    true` on the `community` tool to attest you have checked this.
  - **Roles** (the full vocabulary): `agent` (you, the deploying/owning
    agent), `owner` (the human who owns the app), `member` (a human invited
    as a collaborator), `anyone` (any authenticated-or-not visitor, subject
    to the app's visibility), plus three **row-scoped** subjects decided per
    target row rather than carried by the caller: `creator` (created the row),
    `editor` (wrote the row last), and `author` (an older name for `editor`,
    still accepted, discouraged because the word reads like "creator" and does
    not mean it). All three are valid in `update`, `delete` and `read`, and
    rejected in `write` and `countRead`. **`creator` is the one to reach for**;
    see "Who may change a row" below for the full table and why the distinction
    is a security property, not a naming preference.
- **`x-homespun-manifest.externalHosts`**: an array of `https://` origins
  (DNS name, optional single leftmost `*.` wildcard, no path/query/IP
  literal) the page's `fetch`/`XMLHttpRequest` is allowed to reach. This is
  the **only** way a deployed app can talk to anything besides its own data
  API. See "Serving and security" below.
- **`x-homespun-manifest.cdn`**: boolean, default `false`. Set `true` to allow
  `<script src>`/`<link rel=stylesheet>` from any `https:` origin (a CDN).
  It does **not** widen what the page can `fetch()`; that's `externalHosts`
  only, kept separate on purpose so a page can load, say, a charting library
  from a CDN without also being able to exfiltrate data to arbitrary hosts.
- **`x-homespun-manifest.capabilities`**: optional array from a STRICT
  allowlist of 13 names. Each granted name flips its `Permissions-Policy`
  directive from denied to `self` on the served app document; everything you
  don't list stays denied, and an unknown value is a hard validation error. The
  allowlist, grouped by purpose:
  - **Media**: `"camera"` (getUserMedia video), `"microphone"` (getUserMedia
    audio), `"autoplay"` (play media without a user gesture), `"fullscreen"`
    (Fullscreen API), `"picture-in-picture"` (the app's own `<video>` in a PiP
    window), `"encrypted-media"` (EME / DRM playback of the app's own media).
  - **Device sensors and location**: `"geolocation"` (Geolocation API),
    `"accelerometer"`, `"gyroscope"`, `"magnetometer"` (the corresponding
    Sensor APIs).
  - **Interaction**: `"clipboard-write"` (write to the system clipboard),
    `"web-share"` (the Web Share API), `"display-capture"` (screen or window
    capture via getDisplayMedia).

  Example: `"capabilities": ["camera"]` lets the page call
  `getUserMedia({ video: true })`, while microphone stays blocked. Accuracy
  caveat: `"picture-in-picture"` and `"encrypted-media"` grant these features to
  the app's OWN media (its own `<video>`), not to an embedded cross-origin
  provider. Handing PiP or DRM to a framed YouTube player is gated by the embed
  origin, not by these grants, so declaring them does not enable those buttons
  on a third-party embed (see `embeds` below).
- **`x-homespun-manifest.embeds`**: optional array of `https://` origins
  (same rules as `externalHosts`: DNS name, optional single leftmost `*.`
  wildcard, no path/query/IP literal) the page may embed in an `<iframe>`,
  emitted as a `frame-src` grant. Display-only: it does **not** widen
  `connect-src` or `form-action`, so framing a site never lets the page send
  data to it. For a YouTube player use the privacy-preserving nocookie host:
  `"embeds": ["https://www.youtube-nocookie.com"]`. Declaring a non-empty
  `embeds` list also relaxes the document's `Referrer-Policy` from `no-referrer`
  to `strict-origin-when-cross-origin`, so the embed provider receives your
  app's origin (scheme + host only, never the path or query) as the `Referer`.
  YouTube and most providers require this to validate the embedder, and reject
  the player otherwise ("Error 153"). Apps that do not declare `embeds` keep
  `no-referrer`.

  Working YouTube example (declare the embed, then use the embed URL form and
  the `allow` list the player needs):

  ```html
  <!-- manifest: {"x-homespun-manifest":{"embeds":["https://www.youtube-nocookie.com"]}} -->
  <iframe
    src="https://www.youtube-nocookie.com/embed/VIDEO_ID?rel=0"
    title="Video"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
    allowfullscreen
  ></iframe>
  ```

  The `allow` attribute is what a video player uses to request playback
  features; keep it even though the app document currently denies most of these
  at the `Permissions-Policy` level. Clicking play works regardless. Two known
  limits today: the player's fullscreen and picture-in-picture buttons stay
  inert (the document `Permissions-Policy` grants those only to `self`, not to a
  cross-origin frame), and DRM-only videos that require `encrypted-media` will
  not play. Ordinary public videos play once `embeds` is declared. Use the same
  pattern for other providers (a map, a form, a calendar): declare the origin in
  `embeds`, then iframe it.

### Who may change a row: `update`, `creator`, `editor`

`write` is two capabilities wearing one name. It says who may ADD a row and,
unless you say otherwise, it also says who may CHANGE every row already there.
The `update` list is how you separate those two, and the row-scoped subjects are
how you say *whose* rows.

> **SECURITY: a `write` list is also an OVERWRITE list.** If a collection's
> `write` admits a caller, that same caller may overwrite **any** row in that
> collection, not just their own, unless an `update` list narrows it. So
> `write: ["anyone"]` on a per-user collection means every signed-in visitor may
> rewrite every other visitor's row, and since an update also restamps the row's
> `author`, the original writer's row can vanish from their own
> `read: ["author"]` view in the same request. **How reachable that is depends
> entirely on whether your row keys are guessable.** An app keyed on something
> predictable (`profile`, `settings`, a date like `2026-07-27`, a username, an
> email address) hands any signed-in user a working takeover: they call
> `homespun.collections.update("journal", "2026-07-27", ...)` and the row is
> theirs. An app that only ever calls `create()` gets server-generated keys, so
> it is protected by nobody being able to guess a key, which is secrecy, not
> authorization. Neither app is safe by construction. **Declare `update`.**

**Wrong**, and it looks careful: any signed-in visitor may rewrite any entry,
and the rewrite makes that entry theirs, so it drops out of its original
writer's `read: ["author"]` view at the same moment.

```json
"entries": {
  "write":  ["anyone"],
  "delete": ["author"],
  "read":   ["author"]
}
```

**Right:**

```json
"entries": {
  "write":  ["anyone"],
  "update": ["creator"],
  "delete": ["creator"],
  "read":   ["creator"]
}
```

Anyone signed in may add a row; only the person who created it may change,
remove or see it, and no later write by anyone, including the app's own agent,
can transfer that.

> **SECURITY: `creator` settles who OWNS a row, NOT which rows a caller may
> CLAIM. Declare `keyClaim`.** The recipe above closes the overwrite hole and
> leaves a land-grab open behind it, and the two are easy to mistake for one. A
> create is gated by `write` alone, so **by default** the first caller to
> `upsert("journal", "2026-07-27", ...)` a guessable key becomes its creator,
> permanently. Predictable keys (`profile`, `settings`, a username, an email
> address, today's date) are exactly the ones an app reaches for, and every one
> of them is claimable by whoever writes it first. Afterwards the person the
> slot was meant for is locked out of their own key: their update is denied by
> `update: ["creator"]`, and their create dedups onto the squatter's live row
> and hands its contents back instead. Deleting is not a way out either, because
> a create over a tombstoned key stamps a fresh creator, so the slot simply
> changes hands again. `unique` does not rescue this: it constrains a data
> field's values, and a collision is a hard `409`, so the legitimate user is
> denied all the same.
>
> **`keyClaim` is the fix, and it is one line.** See "Who may CLAIM a row key"
> immediately below. The advice this note used to give, "let the server mint the
> key", is still fine and is now spelled `keyClaim: "server"`, but it protects
> by unguessability rather than by authorization; `keyClaim: "caller"` is the
> stronger answer wherever the row belongs to one person.

#### Who may CLAIM a row key: `keyClaim`

`write` says who may add a row. `keyClaim` says **which** row. They are
different questions and a per-user collection needs both answered.

| Value | Means | Reach for it when |
|---|---|---|
| `"free"` (default) | any key the caller sends, first one wins the slot | the key is meaningless to fight over (a log line, an event) |
| `"caller"` | the key **must be** the caller's own principal id | one row per person: a profile, a preference set, a private bag |
| `"server"` | a caller-supplied key is refused; the relay mints every key | rows are found by listing or by a `unique` field, never by a composed name |

**`keyClaim: "caller"` is squat-proof by construction**, which is why it beats
an unguessable key: the only key anybody can claim is the one nobody else can
hold, so there is no race to lose. Omit the key and the relay fills in the
caller's own id (it is the only legal value); send a different one and the
create is refused `403`. It also survives the tombstone path that defeats every
other shape: delete your row and the slot is still only yours.

```json
"profiles": {
  "keyClaim": "caller",
  "write":  ["anyone"],
  "update": ["creator"],
  "delete": ["creator"],
  "read":   ["creator"]
}
```

```js
// The page does not compose the key at all. Both of these write the caller's
// own row, and neither can reach anybody else's.
await homespun.collections.create("profiles", { display: "Ada" });
await homespun.collections.upsert("profiles", homespun.session.humanId, { display: "Ada" });
```

The id to use is the caller's own: `homespun.session.humanId` for a signed-in
person, `homespun.session.visitorId` for an anonymous visitor on an app that
mints one. Under `"caller"` a principal with **no** identity cannot create at
all, which is deliberate: a row keyed on nothing is a row the collection's own
rules can never evaluate.

`keyClaim` never loosens anything. It is only ever an extra refusal on top of
`write`, so adding it to a live collection can only narrow what is accepted.
Loosening it back to `"free"` on a collection that had it is a compat break and
the redeploy is refused without `force`, because the land grab re-opens on rows
already written.

**The three row-scoped subjects, and why there are three:**

| Subject | Means | Use it? |
|---|---|---|
| `creator` | the identity that CREATED the row. Stamped once, never moves. | **Yes. Default to this one.** |
| `editor` | the identity that wrote the row LAST. Moves on every update. | Only when you genuinely mean "whoever touched it last". |
| `author` | the LAST writer, exactly like `editor`. The original name, accepted forever. | Discouraged in new manifests: it reads like "creator" and is not. |

All three are valid in `update`, `delete` and `read`, and rejected in `write`
and `countRead` (a create has no pre-existing row to scope against, and a count
is an aggregate, not a per-row view). If your app declares custom roles, the
suffix forms narrow one of them the same way: `<role>:own` limits it to the rows
that holder wrote LAST, and `<role>:creator` to the rows they CREATED.

**`editor` and `author` transfer; `creator` does not.** The moment anyone else
writes a row, including your own agent doing a routine cleanup or a status flip,
they become its editor. Under `update: ["author"]` the person who created the
row then loses the right to edit it, and under `read: ["author"]` loses sight of
it entirely. That is why `update: ["author", "agent"]`, which looks like the
natural shape for an agent-assisted per-user app, quietly locks the human out of
their own row the first time the agent touches it. Use `creator` for "this row
belongs to this person", and reserve `editor` for "the last person to touch
this".

**Anonymous visitors DO satisfy row-scoped subjects, on an app that asks for
it.** A visitor to a `public` or `link` app is given a stable per-app identity
automatically, and their rows are stamped with it rather than with the shared
`anon` sentinel. So `write: ["anyone"]` plus `update: ["creator"]` plus
`read: ["creator"]` does what it reads like: every visitor may add a row, and
each one may then edit and see only their own. This is the shape to reach for
whenever a public app needs per-person data and you do not want to force a
login. See "Visitors: recognising someone with no account" below for what it
costs and what it cannot do, and read that section before you rely on it,
because it identifies a **browser, not a person**.

Two cases still fall back to the `anon` sentinel, and in both of them nothing
is claimable by anybody:

- **An app that never declares a row-scoped permission a visitor could reach.**
  The identity is minted only for an app that declares one (the exact rule is in
  the section below), so an app with no such declaration keeps stamping `anon`
  and its anonymous writers can never edit or re-read what they wrote.
- **Rows written before this existed.** They keep the `anon` author they were
  written with. Nothing was migrated, deliberately: handing an old shared-
  sentinel row to whichever browser happens to arrive next is exactly the leak
  the identity exists to close.

A grant link (`homespun grants mint`) remains the way to hand ONE named person
a stable identity you control, and `homespun.session.login()` remains the way to
get a real account behind it. The visitor identity is neither of those; it is
the zero-friction floor beneath both.

### Visitors: recognising someone with no account

A visitor to a `public` or `link` app is handed a **stable, per-app identity**
by the relay, with no login and nothing for you to build. Their rows are stamped
with it, so `creator`, `editor`, `author`, every `:own` / `:creator` suffix and
every relation you declare work for them exactly as they work for a member.

Read `homespun.session.visitorId` for the current browser's id. It is the
visitor's counterpart to `homespun.session.humanId`, and it is what you put in a
relation field when you need to name yourself and the relation does not carry
`set: "caller"`. `homespun.session.kind` stays `"anonymous"` for a visitor,
because that is exactly what their standing in the app is: no membership, no
account, the `anyone` role and nothing more. Test for a visitor with
`session.visitorId !== null`, never by looking for a fourth `kind`.

**It identifies a BROWSER, not a person. Read the whole of this list before you
design around it.**

- A **cleared cookie** is a new visitor. The old rows still exist and are now
  reachable by nobody.
- A **second device** is a different visitor. The same human on their phone and
  their laptop is two visitors with two sets of rows and no way to join them.
- A **private/incognito window** is a different visitor, and stops being one
  when the window closes.
- A **different browser** on the same machine is a different visitor.
- It **expires**. The clock slides forward on every visit, so someone who keeps
  using the app keeps their rows; someone who disappears for the full window
  comes back as a stranger.
- It is **never proof of who anyone is**. Anyone can throw one away and take
  another as many times as they like, so it must never gate anything that
  matters, be rendered as a name or an account, or be treated as a signal of
  good behaviour.
- It is **never shared across apps**. The same browser on two of your apps has
  two unrelated ids, and neither app can tell they are the same browser.

If any of that is unacceptable for what you are building, you need a real
identity, not a visitor: `homespun.session.login()` for an account, or a grant
link for one named person. **Say so in the page.** An app that lets a visitor
build up something they would be upset to lose should tell them plainly that it
is remembered in this browser only, rather than letting them discover it on a
new phone.

The **install screen says it for you**, and says it in exactly these words, so
you do not have to word it yourself and must not contradict it:

> **This app can recognise you when you come back.** It remembers this browser
> so you can see and edit the things you add. It recognises a browser, not a
> person: clear your cookies, or use another device, and it will not know you.

That line is driven by the same predicate the relay mints on, so it appears
exactly when the app really would be given an identity. It is disclosure at
install, not in the running page: an app whose whole value is what a visitor
accumulates should still say it where they can see it while they are using it.

**When the identity is minted, and when it is not.** This is a privacy rule, not
a performance one, so it is worth stating exactly. An app gets a visitor
identity only when ALL of these hold:

1. Its visibility is `public` or `link`. A `private` app already signs everyone
   in, so its viewers have real identities.
2. It is served on its own `<slug>.homespunapps.com` subdomain (the standard
   hosted setup).
3. Its manifest declares a permission a visitor could actually satisfy: **some
   collection has `"anyone"` in its `write` list, AND that same collection's
   `read`, `update` or `delete` names a row-scoped subject a visitor can hold**,
   which means one of `creator`, `editor`, `author`, one of that collection's
   own relation names, or the narrowed forms `anyone:own`, `anyone:creator`,
   `anyone:<relation>`.

**An app that declares none of that is never given a cookie at all.** Nothing is
minted, nothing is stored, and nothing identifies the visitor. Both halves of
rule 3 matter: a collection nobody anonymous can write to gives a visitor
nothing to own, and a collection with no row scope treats every caller alike
whether it recognises them or not. Note also that only `anyone:` narrows count.
`reviewer:creator` does not qualify an app, because a visitor can never hold
`reviewer`.

So a public guestbook with `write: ["anyone"]` and `read: ["anyone"]` gets no
identity, and a team app full of `<role>:creator` scopes gets none either. Add
`update: ["creator"]` to an `anyone`-writable collection and the app starts
recognising returning visitors from its next deploy; take it away again and it
stops on the very next request.

The recipe, in full:

```json
"suggestions": {
  "write":  ["anyone"],
  "read":   ["creator"],
  "update": ["creator"],
  "delete": ["creator"]
}
```

Anyone may add a suggestion; each visitor sees, edits and deletes only their
own; nobody sees anybody else's. Add `"owner"` to `read` if the app's owner
should see every row, and remember that `read: ["creator", "owner"]` means the
owner sees ALL rows, not just their own (matching is literal, and a matched role
wins over a row scope).

### Roles your app defines: `roles` and `includes`

The five built-in subjects (`owner`, `member`, `agent`, `anyone`, plus the
row-scoped `creator` / `editor` / `author`) describe a person's relationship to
the *platform*. They cannot say "a reviewer", "a coach", "a front-desk shift
lead", because those are relationships to *your app*. Declare those yourself,
under `x-homespun-manifest.roles`, and then use the names as permission subjects
exactly as you would a built-in one.

```json
"x-homespun-manifest": {
  "roles": {
    "viewer":      { "label": "Viewer",      "description": "Can see the board" },
    "contributor": { "label": "Contributor", "description": "Can move cards", "includes": ["viewer"] },
    "admin":       { "label": "Admin",       "description": "Runs the board", "includes": ["contributor"] }
  },
  "collections": {
    "cards": {
      "read":   ["viewer"],
      "write":  ["contributor"],
      "update": ["contributor"],
      "delete": ["admin"]
    }
  }
}
```

**Declaring a role grants nothing.** A permission list naming it is what grants
something. `roles` says the name exists (and what to call it on screen); the
collection lists say what it can do. That split is deliberate: there is one place
to read to find out what any role may do, and it is the collection.

**`includes` composes roles, transitively.** In the manifest above, `admin`
includes `contributor`, and `contributor` includes `viewer`, so a person holding
`admin` holds `contributor` and `viewer` too, everywhere. That is why `read`
names only `viewer`: write the shared part once, in the base role, instead of
repeating `["viewer", "contributor", "admin"]` in every list and getting one of
them wrong in six months. Composition only ever ADDS; there is no way to subtract, because a
rule that takes access away cannot be summarized on an install screen without
the reader having to work out an ordering.

Rules the deploy validator enforces, so you find out at `homespun deploy` rather
than in production:

- Every entry of `includes` must name a role declared in the same `roles` block.
- A built-in name (`owner`, `member`, `agent`, `anyone`, `author`, `creator`,
  `editor`) is rejected. Their meaning is fixed by the platform, and a manifest
  that could include one would be a manifest handing out owner powers.
- No cycles, direct or through a chain. The error names the cycle.
- At most 16 entries per role, and the longest chain may be 8 roles deep
  counting the role itself. If you hit that, the hierarchy is too deep for
  anyone to reason about; flatten it.

**A person may hold several roles at once.** A member is given roles with
`homespun members set-role --app <app> --human <humanId> --custom-role
reviewer,scheduler` (comma-separated), and holds the union of what each one
grants, plus everything those roles include. `--clear-role` drops them back to a plain
member. A member may hold up to 8 declared roles; if you want more than that on
one person, declare a role that `includes` the others and hand out that one
instead.

A **grant link** is different: `homespun grants mint --app <app> --role <name>`
mints a link carrying exactly ONE role, because a link *is* a handout of that
role. The link's holder still gets everything that role includes.

**Role names are also usable in the narrowing forms.** `reviewer:creator` on
`update` means "a reviewer, and only on rows they created"; `reviewer:own` means
"and only on rows they wrote last". The base of the suffix must be a declared
role, since the built-in row scopes already have their own bare names.

**Check what you actually built** with `homespun members roles --app <app>`. It
reports, per declared role and per collection, the EFFECTIVE access a holder has
(separately for members and for grant-link holders, whose floors differ), and
what each role includes. It is computed by asking the real authorizer, not by
re-reading your manifest, so it is the answer enforcement will give.

Two things worth knowing before you design around roles:

- **A custom role never implies `member`.** A grant-link holder carrying
  `reviewer` is `{anyone, reviewer}` and nothing else, so a collection with
  `read: ["member"]` is invisible to them. A signed-in member carrying
  `reviewer` is `{anyone, member, reviewer}`. If both populations should see a
  collection, list both subjects.
- **`owner` carries `member`, and that hierarchy is the platform's, not yours.**
  It is not expressed through `includes` and cannot be changed by a manifest.
  The app owner already outranks every role you declare, so there is no reason
  to give them one.

### Rows that belong to a person: `relations`

`creator` and `editor` answer "who touched this row". They cannot answer "whose
row is this", because the person a row is ABOUT is usually not the person who
typed it. A shift the manager assigned, a task the agent filed on someone's
behalf, a packing list that belongs to one traveller: in every one of those the
owner is a **field of the row**, and until you declare it, that field is just
text any writer can overwrite.

`relations` gives that field a name and makes it enforceable.

```json
"tasks": {
  "schema": { "$ref": "#/$defs/Task" },
  "relations": {
    "assignee": { "field": "assignedTo" },
    "reporter": { "field": "reportedBy", "set": "caller" }
  },
  "read":   ["assignee", "admin"],
  "write":  ["contributor"],
  "update": ["assignee", "admin"],
  "delete": ["reporter", "admin"]
}
```

`assignee` now means "the caller whose own principal id is the value in this
row's `assignedTo` field". It is a subject exactly like `creator`: usable in
`update`, `delete` and `read`, and rejected in `write` and `countRead` for the
same two reasons (a create has no row to compare against, and a count is an
aggregate over the whole collection rather than one person's view).

**The value is a principal id, not a name or an email.** A page reads its own
from `homespun.session.humanId`, and everyone else's from
`homespun.members.list()`. An agent uses the human id it already holds. A field
holding `"alice@example.com"` or `"Alice"` matches nobody and grants nothing,
silently, so put an id there.

**`set: "caller"` is what makes it authorization rather than a claim.** With it,
the SERVER fills the field in with the caller's own id when the row is created,
overwriting whatever the client sent, and refuses every later attempt to change
it. Without it, whoever `write` admits chooses the value, which is exactly what
you want when an **agent creates a row that a human owns**: the agent writes
`assignedTo: "<the human's id>"`, and from that moment the human can edit and
read their own row even though they could never have created it.

Use `set: "caller"` when the row belongs to whoever made it. Omit it when
somebody else decides who the row belongs to.

Rules the deploy validator enforces, so you find out at `homespun deploy`:

- A relation name follows the role-name grammar, and may not be a built-in
  subject (`owner`, `member`, `agent`, `anyone`, `author`, `creator`, `editor`),
  may not be `own`, and may not be a role you declared. Those names already mean
  something in a permission list.
- `field` must be a simple top-level field name, and if the collection declares
  a schema it must be a declared property that can hold a string (`"type":
  "string"`, or `["string", "null"]` for a row that starts unassigned).
- At most 8 relations per collection, and two relations may not bind the same
  field.
- A permission list may only name a relation the SAME collection declares.

**Narrowing works too.** `admin:assignee` on `update` means "an admin, and only
on rows assigned to them". It is the same shape as `<role>:own` and
`<role>:creator`, which keep their existing meanings unchanged: `:own` is the
last writer, `:creator` is the creator, and neither is a relation you declare.

**Read scoping is real, and it is a filter, not just a check.** Under `read:
["assignee"]` a `list()` returns only the caller's own rows, on every page, and
a direct `get()` of somebody else's row returns **not found**, never
"forbidden", so a caller cannot learn which keys exist. The live feed follows
the same rule: an entry reaches only the person its data names. Two consequences
worth knowing:

- A **delete** entry carries the row's last-known data, so the person the row
  named still learns it was removed.
- **Reassigning** a row moves it: the new assignee starts seeing it, the old one
  stops. The old assignee's browser keeps a stale copy until it reconnects, at
  which point it drops out entirely.

> **SECURITY: `set: "caller"` decides who a row BELONGS to, not which key a
> caller may take.** This is the same trap the `creator` warning above
> describes, and declaring a relation does not close it. A create is gated by
> `write` alone, so under a `"free"` `keyClaim` on a guessable key (`profile`, a
> username, today's date) the first caller wins the slot, and a later create on
> the same live key **dedups and hands that row's current contents back to
> whoever tried**, even under `read: ["<relation>"]`. **Declare `keyClaim`**:
> `"caller"` for a one-row-per-person collection, `"server"` where the key is
> incidental. Upserting on the relation field itself (`on: "<field>"`, with the
> field declared `unique`) also resolves to the caller's own row and nobody
> else's.

> **A relation WITHOUT `set: "caller"` is a rule keyed on a field the caller
> controls, so freeze it.** Omitting `set` is the right shape for the
> agent-writes-for-a-human case, but it means whoever `write` admits chooses who
> the row belongs to, and can keep choosing on every later update. Add the field
> to `immutable` and the answer is pinned to whatever the create said:
>
> ```json
> "tasks": {
>   "relations": { "assignee": { "field": "assignedTo" } },
>   "immutable": ["assignedTo"],
>   "write":  ["agent"],
>   "update": ["assignee"],
>   "delete": ["owner"],
>   "read":   ["assignee"]
> }
> ```
>
> Without the freeze, an assignee could reassign the row to themselves off
> somebody else's task, or hand it away and lose it. With `set: "caller"` the
> server owns the field outright and no `immutable` entry is needed.

**Anonymous visitors satisfy no relation**, for the same reason they satisfy no
`creator`: they have no identity to compare a field against. If the collection
declares `set: "caller"`, an anonymous visitor cannot even create the row, which
is deliberate: a row nobody owns, in a collection whose rules are about
ownership, is worse than a refused write. Give visitors a real identity first
(`homespun.session.login()`, or a grant link).

#### Recipe: everyone sees only their own rows

The per-user collection, done properly. Anyone signed in may add a row; the
server decides whose it is; nobody else can see it, edit it or delete it.

```json
"entries": {
  "schema": { "$ref": "#/$defs/Entry" },
  "relations": { "owner_": { "field": "ownedBy", "set": "caller" } },
  "read":   ["owner_"],
  "write":  ["anyone"],
  "update": ["owner_"],
  "delete": ["owner_"]
}
```

with `ownedBy` declared as a `"type": "string"` property of `Entry`. The page
never sets `ownedBy`; the server does. This is stronger than the `creator`
version of the same recipe in one specific way: the owning field is **data**, so
your agent can hand a row to a different person later by writing the field,
which `creator` can never do. It is weaker in one way too: without `set:
"caller"`, whoever `write` admits picks the value, so leave `set` on unless you
mean to allow that.

(Note the trailing underscore in `owner_`: `owner` itself is a built-in subject
and is rejected as a relation name.)

#### Recipe: the agent files it, the human owns it

The shape the four first-party templates were faking. The agent is the only
writer; each row names the person it is for; that person can then read and
correct their own.

```json
"reports": {
  "schema": { "$ref": "#/$defs/Report" },
  "relations": { "subject": { "field": "forPerson" } },
  "read":   ["subject", "owner"],
  "write":  ["agent"],
  "update": ["subject", "agent"],
  "delete": ["owner"]
}
```

No `set` here, on purpose: the agent is choosing who the row is for, so the
value has to be the agent's to write. That is the one case where a
client-supplied relation value is the point rather than the hole, and it is safe
only because `write` is `["agent"]`. **If `write` admits a wider audience, add
`set: "caller"`,** or anyone admitted to write can name anyone they like.

### Schema gotchas (two that bite at deploy time)

- **`maxLength` cannot exceed the per-row byte cap.** A whole row's serialized
  `data` is capped at 64 KiB (`MAX_ROW_DATA_BYTES`), so a string field that
  declares `maxLength` larger than that cap can never actually be filled to that
  length: a value near it is rejected `413` at runtime. To catch that mismatch
  where you can see it, the deploy now **rejects** such a schema with
  `collection_schema_invalid` naming the offending `maxLength`. Keep every
  string `maxLength` at or under 64 KiB (in practice, size each field to what it
  actually holds, a name is `maxLength: 200`, not `2000000`). This is a
  single-field impossibility check only: it never sums fields, so a
  large-but-possible `maxLength` still deploys.

- **Intra-document `$ref` across `$defs` is NOT resolved, inline it.** A
  collection's `schema` may `$ref` a `$defs` entry, but a `$ref` FROM one
  `$defs` entry TO another sibling `$defs` entry is not resolved: the sibling
  ref is out of scope when the entry is compiled, so the deploy is REJECTED
  with `collection_schema_invalid` ("can't resolve reference"). Inline the
  shared shape into each `$def` that needs it instead of referencing a
  sibling. So this does NOT work:

  ```json
  "$defs": {
    "Address": { "type": "object", "properties": { "city": { "type": "string" } } },
    "Order": {
      "type": "object",
      "properties": { "ship_to": { "$ref": "#/$defs/Address" } }
    }
  }
  ```

  Inline `Address` directly inside `Order` instead:

  ```json
  "$defs": {
    "Order": {
      "type": "object",
      "properties": {
        "ship_to": {
          "type": "object",
          "properties": { "city": { "type": "string" } }
        }
      }
    }
  }
  ```

### Recipe: public submits, only the owner reads

The highest-value thing `read` buys you: a collection the world can write to but
only the owner can see. Order queues, RSVP lists, job applications, booking
requests, contact and feedback boxes are all this shape.

```json
"collections": {
  "menu": {
    "schema": { "$ref": "#/$defs/MenuItem" },
    "read": ["anyone"],
    "write": ["agent", "owner"],
    "delete": ["agent", "owner"]
  },
  "orders": {
    "schema": { "$ref": "#/$defs/Order" },
    "write": ["anyone", "owner", "agent"],
    "update": ["owner", "agent"],
    "delete": ["owner", "agent"],
    "read": ["owner", "agent"]
  }
}
```

`orders` declares `update` even though only staff read it: without that line,
`write: ["anyone"]` would let any visitor rewrite any order that already exists,
not only add their own (see "Who may change a row").

An anonymous customer can POST an order (it lands with an `anon` author), but
listing `orders` gives them `403 collection_read_forbidden`: only the owner and
you can read the queue, and that is enforced by the relay, so hitting the data
API directly gets them nothing the page would not show them either. `menu`
declares `read: ["anyone"]`, so it stays readable by every visitor, which is
exactly what you want for the half of the app the customer is supposed to see.
That is the affirmative way to say "this part is public", and it is the only way
to say it now that an absent `read` is a deploy error.

Adding `"creator"` to that `read` list lets each submitter see their own row back
(an order status page) without seeing anyone else's, but only for submitters who
are *signed in*: a row-scoped subject needs a stable identity to match a row
against, and an anonymous visitor has none, so it stays a `403` for them. Use
`creator` rather than the older `author` here: `author` means the row's LAST
writer, so the first time the owner or your agent edits an order, that order
would drop out of the customer's own status page. Keep the queue
`read: ["owner", "agent"]` when the customer never signs in.

**The recipe is not finished until the page has a sign-in control.** This app is
public, so nobody, including its owner, is ever prompted to sign in: the owner
opens it, gets the same anonymous session every customer gets, and `orders` is a
`403` for them too. Ship a quiet sign-in affordance, hidden once the viewer is
already owner or member:

```html
<button id="signin" hidden>Staff sign in</button>

<script>
  window.addEventListener("DOMContentLoaded", async () => {
    await homespun.ready; // session.kind is resolved by the time this resolves
    if (homespun.session.kind === "anonymous") {
      const btn = document.getElementById("signin");
      btn.hidden = false;
      btn.onclick = () => homespun.session.login(); // comes back to this page
    } else {
      renderOrderQueue(); // owner/member: the owner-only read now succeeds
    }
  });
</script>
```

`homespun.session.login()` is a full-navigation redirect to the relay's
`/authorize` hand-off, with the current page as the return target:

```
https://<main-domain>/authorize?app=<slug>&return=<absolute URL to come back to>
```

It builds that URL itself, from the auth origin the relay sends the page at
connect time and the app's own slug, so **nothing is hardcoded and you should
prefer it** over hand-writing the URL. An anonymous visitor is bounced through
the relay's login page; on the way back, an owner or member is handed a one-time
grant that mints an app session on the app's own origin, and lands on `return`
with `homespun.session.kind === "owner"` (or `"member"`), at which point the
owner-only reads work. A signed-in visitor who is neither returns to the page
still anonymous and with no grant, so the control is safe to leave in public.

If you must build that URL by hand (a plain `<a href>`, or a page not using the
SDK): `<main-domain>` is the relay's own domain (`homespun.dev` for the hosted
relay, whatever `MAIN_DOMAIN` is for a self-hosted one, so this is exactly the
part `login()` saves you from hardcoding). `return` is optional and must be an
absolute URL on the app's OWN origin. Anything else (another app, an
off-platform host, `http:`, a malformed value) is not an error, it is silently
replaced with the app's root. The slug is the leftmost label of the app's own
hostname on the hosted usercontent domain (`location.hostname.split(".")[0]`),
though `homespun.app.slug` is always right and is what `login()` uses.

### Recipe: a public count without exposing the rows

When the page needs to show "3 spots left" or "128 people signed up" to an
anonymous visitor, do NOT make the whole collection world-readable to get the
number, that leaks every submission. Opt the collection into the count-only
aggregate with `countRead` while keeping `read` locked down:

```json
"collections": {
  "signups": {
    "schema": { "$ref": "#/$defs/Signup" },
    "write": ["anyone"],
    "update": ["owner"],
    "delete": ["owner"],
    "read": ["owner"],
    "countRead": ["anyone"]
  }
}
```

`update: ["owner"]` is what holds a visitor to adding a signup rather than
rewriting somebody else's; without it, `write: ["anyone"]` grants both.

The page reads the number with `homespun.collections.count(name)`, which
resolves to a plain integer:

```js
const taken = await homespun.collections.count("signups");
document.getElementById("left").textContent = `${Math.max(0, 50 - taken)} spots left`;
```

An anonymous visitor gets the live count but a `GET /_hs/c/signups` (or
`homespun.collections.snapshot`) still returns nothing: the rows stay
owner-only. The count is a whole-collection total of live (non-deleted) rows;
there is no field projection and no filtering in v1. A collection that never
declared `countRead` refuses the count with `403 collection_count_forbidden`.

<!-- homespun:core:end -->

## Writing the HTML: `window.homespun`

The relay injects `window.homespun` into every served app document. The page
talks to its own data **only** through this bridge.

**Script ordering.** `window.homespun` is defined **synchronously during
parse**, before any script of yours runs. The relay injects two things into the
`<head>`: a tiny inline bootstrap that defines `window.homespun` immediately,
and the real SDK bundle as `<script src="/_hs/sdk.<hash>.js" defer>` that loads
after parsing and takes over. Because the bootstrap runs first, referencing
`homespun.*` at the top level of a plain inline `<script>` is safe: it never
throws. The bootstrap buffers any method call made before the bundle finishes
loading (the call resolves once the bundle attaches), and synchronous reads
(`collections.snapshot`, `feed.cursor`, `session.kind`, ...) return the same
pre-`ready` defaults documented below until the data has loaded.

So gating your init on `DOMContentLoaded` is **no longer required**. It stays
perfectly harmless (every example below still does it, and it works), but you
can just as well run your init inline. What you should always do is **`await
homespun.ready`** (or `homespun.ready.then(...)`) before your first synchronous
read, so the session and the initial collection snapshots are in place:

```html
<script>
  async function init() {
    await homespun.ready; // session + initial snapshots are ready
    render();
    homespun.collections.on("items", render);
  }
  init();
</script>
```

| Surface | What it does |
|---|---|
| `homespun.ready` | `Promise<void>`. Resolves once the session is resolved and every declared collection has been snapshotted into the local mirror. `await` it before your first synchronous read. |
| `homespun.collections.snapshot(name)` | Synchronous read of every row currently in the local mirror. `[]` before `ready`. |
| `homespun.collections.get(name, key)` | Synchronous point read; `undefined` if absent/deleted. |
| `homespun.collections.count(name)` | `Promise<number>`: the collection's live row count from the server. Works even when the caller cannot read the rows, if the manifest opted in with `countRead` (the "3 spots left" shape). Network read, not a mirror read. Rejects `collection_count_forbidden` when not opted in. |
| `homespun.collections.on(name, handler)` | Live deltas for one collection, already folded into row shape: `{kind:"upsert", collection, row: HomespunRow}` or `{kind:"delete", collection, row:{key, deletedAt}}`. Returns an unsubscribe function. |
| `homespun.collections.create(name, data)` | `POST`; the server generates the row key. Returns the created `HomespunRow` FLAT. (The raw `POST /v1/apps/:id/collections/:name` REST endpoint instead wraps it as `{ "row": ... }`; see "Raw REST envelopes" if you call the API directly.) |
| `homespun.collections.upsert(name, key, data)` | Create-or-return-existing for a caller-supplied key (idempotent). |
| `homespun.collections.update(name, key, data, {ifMatch?})` | Optimistic-locked update. A stale `ifMatch` rejects with `code:"conflict"` and `details.current` set to the winning row. |
| `homespun.collections.delete(name, key, {ifMatch?})` | Soft-delete (tombstone). |
| `homespun.feed.on(handler, {collection?})` | Unfiltered (or single-collection-filtered) live change feed: every create/update/delete across the app, in order. Each entry is a raw `FeedEntry`: `{seq, op:"create"\|"update"\|"delete", collection, key, data, author, ts}`. **Note the field is `op`, not `kind`**: `feed.on` and `collections.on` carry different shapes (see below). |
| `homespun.feed.cursor` | Highest feed `seq` applied locally so far (memory-only). |
| `homespun.app.{slug,name,description,icon,visibility,collections}` | Manifest-derived, safe-to-expose facts about this app. |
| `homespun.session.{kind,humanId}` | Who's looking at the page right now: `"owner"` \| `"member"` \| `"anonymous"`, and their human id (`null` if anonymous). |
| `homespun.session.displayName` | The viewer's own name (`null` when anonymous). Self-facing only: falls back to a name derived from their email when they haven't set one, same rule the dashboard uses for its own greeting. |
| `homespun.session.login()` | Full-navigation redirect to the identity provider's `/authorize` flow. |
| `homespun.session.logout()` | Clears the stored session token and reloads as anonymous. |
| `homespun.members.list()` | Every human Member of this app (always including its owner) plus every Agent its owner currently owns, as `{kind:"human"\|"agent", id, displayName, role?}`. Names only: never an email, and never anything derived from one for anyone other than themselves. |
| `homespun.members.nameFor(author)` | Resolve a row's or feed entry's own `author` (`{kind, id}`) straight to a display name, never throws. Falls back to `"a member"` / `"an agent"` for an id no longer in the directory (a removed member, an unclaimed/reassigned agent), and `"a visitor"` for an anonymous author. |
| `homespun.uploadBlob(file, opts?)` / `homespun.downloadBlob(id)` / `homespun.saveBlob(id, filename?)` | Binary attachment upload/download. Names kept from v1 for continuity. To DISPLAY an app's own attachment, a bare `<img src=/_hs/attachments/id>` works (the read route accepts the app's own same-origin session for owner/member, private or public). `downloadBlob(id)` is the JS-bytes read: use it with `URL.createObjectURL` only when you need the raw bytes in JS (canvas, re-upload), not as the display path. |

A minimal grocery-list page against the manifest above:

```html
<!doctype html>
<meta charset="utf-8" />
<ul id="list"></ul>
<input id="new-item" placeholder="Add an item" />
<button id="add">Add</button>

<script>
  // `window.homespun` is defined synchronously during parse, so this init could
  // run inline; the DOMContentLoaded wrapper is optional (and harmless) here and
  // just guarantees the elements below exist. What matters is `homespun.ready`,
  // awaited before the first read. See "Script ordering" above.
  window.addEventListener("DOMContentLoaded", () => {
    const list = document.getElementById("list");

    function render() {
      list.innerHTML = "";
      for (const row of homespun.collections.snapshot("items")) {
        const li = document.createElement("li");
        // The row's real author, server-stamped and tamper-proof (never a
        // client-written `by` field (see "Rules of thumb" below).
        const by = homespun.members.nameFor(row.author);
        li.textContent =
          row.data.name + (row.data.checked ? " ✓" : "") + " (added by " + by + ")";
        li.onclick = () =>
          homespun.collections.update("items", row.key, {
            ...row.data,
            checked: !row.data.checked,
          });
        list.appendChild(li);
      }
    }

    homespun.ready.then(render);
    // Live updates, from a member's own edits AND from `homespun data upsert`
    // calls the agent makes later.
    homespun.collections.on("items", render);

    document.getElementById("add").addEventListener("click", async () => {
      const input = document.getElementById("new-item");
      if (!input.value.trim()) return;
      await homespun.collections.create("items", {
        name: input.value.trim(),
        checked: false,
      });
      input.value = "";
    });
  });
</script>
```

Rules of thumb:

- **`await homespun.ready` before your first synchronous read** (see "Script
  ordering" above). `window.homespun` is defined synchronously during parse, so
  referencing it at the top level of a plain inline `<script>` is safe and
  `DOMContentLoaded` gating is optional; `ready` is the signal that the session
  and the initial collection snapshots are actually in place.
- **`collections.on` and `feed.on` are not interchangeable.** `collections.on`
  gives you a row-shaped delta already folded for one collection
  (`{kind:"upsert"|"delete", row}`). Reach for it when you just want to
  re-render on change, as in the example above. `feed.on` gives you the raw,
  unfolded `FeedEntry` (`{seq, op, collection, key, data, author, ts}`,
  field is **`op`** not `kind`) across the whole app (or one collection via
  `{collection}`). Reach for it when you need ordering/`seq`, cross-collection
  events, or the entry's own metadata (`author`, `ts`) rather than just the
  resulting row.
- **`.textContent`, never `.innerHTML`**, for anything containing human- or
  agent-authored text: the same injection discipline as any other web page.
- **Never invent a client-side `by`/`author` field for what the row's real,
  server-stamped `author` already is.** A page-written field like
  `{ ...data, by: "Alice" }` is just ordinary row data: any visitor can set
  it to anything, so it proves nothing about who actually wrote the row. This
  is a rule about attribution, not about data: storing a self-declared name is
  fine (a guestbook or RSVP legitimately records the responder's stated name in
  `data`, and you should render it as what they called themselves), the narrow
  rule is only that such a field is never PROOF of authorship.
  Render the row's own `author` instead: `homespun.members.nameFor(row.author)`
  (or `entry.author` off the feed) turns the tamper-proof `{kind, id}` the
  relay stamped into a real name. Greet the current viewer the same way, with
  `homespun.session.displayName`, falling back to something generic (e.g.
  "Sign in" or "Welcome") when it's `null`.
- **No relay-injected stylesheet or CSS variables in v2.** Unlike the v1
  viewer, a deployed app gets no default styling: you own 100% of the
  CSS from the first paint. Write real, theme-aware CSS (respect
  `prefers-color-scheme` yourself) rather than assuming a house style exists.
- **Network access is manifest-gated, not blanket-blocked.** A v2 app is a
  real top-level page (not a sandboxed iframe): `fetch`/`XMLHttpRequest` work
  against `'self'` (its own data API) plus whatever origins you declared in
  `externalHosts`; nothing else. `<script src>`/`<link rel=stylesheet>` from
  an external `https:` origin additionally requires `cdn: true`. Images,
  fonts, and media may load from any `https:` origin (or `data:`) regardless
  of `cdn`/`externalHosts`: those are display-only and can't exfiltrate
  data. Anything not covered by one of these is blocked by the app's CSP;
  there is no escape hatch besides declaring it in the manifest and
  redeploying.

### Let your app's users upload a file

**This is the RIGHT way to collect a photo (or any file) from an end user** (a
visitor adding a picture to their app). Build an in-page browser file input that
POSTs the bytes to the app's own `POST /_hs/attachments` route via
`homespun.uploadBlob`. The bytes travel browser -> relay directly and **never
pass through the agent or the model context**, so it costs you no tokens and is
the correct UX. Do NOT route an end user's photo through the agent (having them
hand you bytes to `attachments upload`) just to store it: that is slow, and the
base64 would enter the model context and cost tokens proportional to the file
size.

`homespun.uploadBlob(file, opts?)` lets a person, inside your rendered app, hand
a file (an image, a PDF, a CSV) straight to the app from their browser. It POSTs
the bytes to the app's own `POST /_hs/attachments` route, runs the identical
hardened pipeline every other upload does (byte-sniff, allowlist, size cap,
quota), and resolves to an `AttachmentRef` whose `id` you store like any other
attachment id:

```html
<input id="file" type="file" accept="image/*" />
<script>
  window.addEventListener("DOMContentLoaded", () => {
    document.getElementById("file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const ref = await homespun.uploadBlob(file); // { id, mime, size, filename }
      // Reference it from a row: a field declared `format: homespun-attachment-id`
      // validates the id, and the bytes read back at /_hs/attachments/<id>.
      await homespun.collections.create("photos", { image: ref.id, caption: "" });
      const img = document.createElement("img");
      // Display an app's OWN attachment with a bare URL. The
      // `/_hs/attachments/<id>` route accepts the app's own same-origin session
      // (owner/member) for reads, so an <img src> renders on the app's own page
      // for a private app exactly as it does for a public/link one. Use
      // homespun.downloadBlob(id) + URL.createObjectURL only when you need the
      // raw bytes in JS (canvas, a Blob to hand elsewhere).
      img.src = "/_hs/attachments/" + ref.id;
      document.body.appendChild(img);
    });
  });
</script>
```

**Who may upload depends on the target collection.** `homespun.uploadBlob` is
the **owner-or-member** convenience: it carries the visitor's app-session token
and posts to `POST /_hs/attachments`, so an anonymous visitor is refused
(`upload_forbidden` on a public/link app, `unauthorized` on a private one). If
`homespun.session.kind` is `"anonymous"` and you want a signed-in upload, send
them through `homespun.session.login()` first.

To instead accept uploads from **anonymous in-page visitors**, use the
**anonymous-upload capability** (M3): declare the target collection with
`write: ["anyone"]`, then have the browser POST directly to
`POST /_hs/attachments?collection=<name>` (a raw `fetch` with a `FormData`
body, since `uploadBlob` does not set the `?collection=` param, so the
anonymous path is a plain fetch, not `uploadBlob`). A not-signed-in visitor can then add
an image straight from the page. Anonymous uploads are image-only
(server-sniffed), per-file size-capped (`ANON_UPLOAD_MAX_BYTES`), rate-limited
per (IP, app), and sub-capped per app (`ANON_BYTES_PER_APP`) so a stranger can
never exhaust the owner's storage.

Either way the bytes count against the **app owner's** blob quota, and an
uploader who goes too fast gets a clean `rate_limited` error.

## Serving and security: what an app's origin can and can't do

Each deployed app is served **top-level**, at its own subdomain
(`<slug>.homespunapps.com`), not embedded in an iframe. A few things follow
from that:

- **No cookies on the app's origin.** The usercontent domain strips every
  inbound `Cookie` header and drops every outbound `Set-Cookie`: nothing on
  that origin ever reads or sets one. Session state lives in the browser's
  `localStorage`, scoped per-app-origin, and is established via
  `homespun.session.login()` (a redirect to the identity provider) rather than a
  cookie.
- **`connect-src` is `'self'` plus your declared `externalHosts`, never
  wider**, regardless of the `cdn` flag. `cdn: true` only widens
  `script-src`/`style-src` (code you load), not what the page can fetch,
  keeping "can load a charting library" and "can exfiltrate data" as two
  separate grants.
- **Visibility gates who can open the app at all**: `private` (only the
  owner plus invited members, sign-in gated; this is the default), `link`
  (anyone with the URL), `public` (listed and discoverable). This is
  orthogonal to the per-collection `write`/`update`/`delete` role lists in the
  manifest; visibility controls who can load the page, the manifest roles
  control who can write which collection once they are on it.
- **Only a private app gets a sign-in gate.** A public or link app serves its
  page to anonymous visitors directly, so if it has any owner-only or
  member-only surface, the page itself has to offer the way in
  (`homespun.session.login()`); otherwise the owner is stuck anonymous on their
  own app. Sessions are per-origin: signing in on the main site does not sign a
  person in to an app. See "Recipe: public submits, only the owner reads".

## Deploying and iterating

`homespun deploy` is the one command for both creating and redeploying, decided
by whether you pass `--app`, not by two separate verbs. Tell the human their
new app is private until they invite members or change its visibility.

**Canonical shape, a directory with two fixed filenames:**

```sh
homespun deploy ./my-app
#   reads ./my-app/index.html and ./my-app/manifest.json, no discovery
#   heuristics, both files required
```

**Escape hatch, a single HTML file plus an explicit manifest:**

```sh
homespun deploy ./index.html --manifest ./manifest.json
# --manifest also accepts inline JSON
```

**Create** (no `--app`) calls `POST /v1/apps`:

```sh
homespun deploy ./my-app
# private by default; add --visibility link|public to share wider

homespun deploy ./my-app --visibility public --slug grocery-list
# -> { app_id, slug, visibility, url, version, created: true }
```

- `--slug` is accepted with `--visibility public`, `--visibility private`,
  or no `--visibility` at all (the default is private). An explicit
  `--visibility link` app always gets a server-generated slug; passing
  `--slug` with it is rejected before the request even goes out.

**Redeploy** (`--app <id-or-slug>`) calls `POST /v1/apps/:id/versions`:

```sh
homespun deploy ./my-app --app grocery-list
# -> { app_id, version, visibility, created: false, compat, breaks? }
```

- **Send only what changed.** On a redeploy every content field is optional and
  an omitted one keeps what is live: the HTML, the manifest and the asset set
  each carry forward on their own. Ship the document alone with
  `homespun deploy ./index.html --app grocery-list` (no `--manifest`), or the
  manifest alone with `homespun deploy --app grocery-list --manifest ./manifest.json`
  (no file argument at all). A directory deploy still ships both, which is right
  when both changed. Over MCP the same rule applies to `deploy_app`: omit
  `manifest` for an HTML-only change, omit `html` for a manifest-only one, and
  omit `assets` to keep the current files. `assets: []` is the explicit "clear
  the asset set", and omitting all three is refused, since nothing would change.
  A create can inherit nothing, so it always needs both halves.
- `--slug`/`--visibility` cannot be changed here: slug is immutable for the
  app's lifetime; change visibility with `homespun apps update --visibility`.
- **The compat gate.** By default the relay refuses a redeploy on either of
  two grounds, and they point in opposite directions.
  - It *strands existing rows*: a collection removed, a row schema tightened,
    or a collection flipped `appendOnly`. Rows written under the old contract
    could stop making sense.
  - It *widens what the app's install screen says*: some collection now
    reaches further than the live manifest does, so a user installing today
    would be asked to approve something the current users never saw. The
    break quotes that sentence back to you.

  It fails `422` with `details.breaks[]` naming every offending path. Taking
  access AWAY is always compatible and never asks: dropping a role from
  `read`/`write`/`delete`, or adding `update: ["creator"]` to a
  `write: ["anyone"]` collection so only each row's creator can edit it,
  redeploys clean. Pass `--force` to redeploy anyway (a removed collection is
  detached, not deleted, and its rows aren't destroyed).

**Dry run before you deploy (`--check`).** Add `--check` to validate a bundle
WITHOUT deploying it: the relay runs the full manifest + asset-shape validation,
the redeploy compat gate (with `--app`), and the schedule-timezone advisory, then
prints `{ ok, warnings, compat?, breaks? }` and creates NO version and mutates
nothing. An invalid manifest fails the same way a real deploy would; a narrowing
redeploy reports the compat break (`compat: "incompatible"`, `breaks[]`) instead
of applying it, so you can see what `--force` would detach before committing. Via
MCP: `deploy_app` with `dry_run: true` (alias `check: true`).

```sh
homespun deploy ./my-app --check            # validate a create
homespun deploy ./my-app --app grocery --check   # validate a redeploy (+compat)
```

**Skipping the HTML retransmit (MCP `html_path`).** Over the MCP `deploy_app`
tool you can pass `html_path` (an absolute path) instead of inline `html` so a
large HTML file is not resent in the tool-call arguments every deploy. The path
is read on the **MCP-server host** (the relay for a hosted connector, your CLI
host for a locally-run one), NOT the remote agent's machine, so it only helps a
locally-run connector; a hosted connector cannot see your path and returns a
clean error (send inline `html` there). If both are given, inline `html` wins.
The `homespun deploy` CLI already reads the file from disk, so this is an
MCP-only convenience.

An app can go **dormant** after a period of inactivity; a dormant app's live
watchers get a terminal `{"type":"_dormant"}` frame. `homespun apps wake <app>`
brings it back before you deploy/read/write against it again.

## Shipping assets with your app (images, fonts, audio, video, data)

`deploy_app` (and `POST /v1/apps` / `POST /v1/apps/:id/versions`) takes an
optional `assets[]` bundle alongside the HTML, so an app AND its files ship in
ONE call. This is the clean way to deliver a scroll-scrub frame sequence, a
hosted video, a custom font, or a data file, with no second upload step and no
CDN. Each asset is EITHER `{ path, content_base64, mime? }` (inline bytes) OR
`{ path, attachment_id }` (a reference to an already-uploaded attachment, see
"Avoiding base64 in the model context" below):

- `path` is the **app-relative, same-origin** reference your HTML uses, e.g.
  `frames/000.jpg`. It must be relative (no leading `/`), carry no `..`
  segment / backslash / control char, use the charset `[A-Za-z0-9._/-]`, be
  unique in the bundle, and not start with a reserved prefix (`_hs`, `b`).
- `content_base64` is the standard base64 of the file's raw bytes.
- `mime` is advisory for types with magic bytes (images, audio, video, fonts,
  PDF): the relay sniffs the real type from the bytes, and a declared type that
  disagrees is rejected. For **text/data files that have no magic bytes**
  (`text/plain`, `text/csv`, `text/markdown`, `application/json`,
  `application/zip`, and the Word/OOXML `.docx/.xlsx/.pptx` types), declare the
  real `mime` and it is stored as that type; those are always served as an inert
  download (`Content-Disposition: attachment`). Omitting `mime` still works and
  stores them as `application/octet-stream`. Either way the same allowlist +
  size cap apply.

The page then references each asset by its path on the app's OWN origin, with no
token and no `/_hs/...`:

```html
<img src="frames/000.jpg" />
<video src="media/intro.mp4" controls></video>
<!-- Range/seek works -->
<link rel="preload" as="font" href="fonts/body.woff2" crossorigin />
```

Rules worth knowing:

- **One atomic deploy.** If any asset fails validation (bad path, disallowed
  type, over the size cap or quota) the WHOLE deploy is rejected: no app is
  created, or the live version is not advanced. The error names the offending
  path.
- **Redeploy replaces the set, or keeps it.** A redeploy that SENDS `assets[]`
  makes that the new version's map, and the previous version's assets are
  detached, so a removed path simply stops resolving as an asset. A redeploy
  that OMITS `assets` keeps the live set: the same files stay mapped at the same
  paths with no re-upload and no re-encoding. `assets: []` is the explicit way
  to clear the set.
- **Served hardened + Range.** Assets stream through the same responder as
  attachments: `X-Content-Type-Options: nosniff`, a sandbox CSP,
  inline-vs-download disposition (images / fonts / audio / video render inline,
  everything else downloads), and HTTP Range / `206` for media + font seeking.
- **Visibility follows the app.** On a private app an asset needs the same
  signed-in session as the document; a public or link app serves it to anyone.
- **Bounds.** Up to the relay's per-deploy asset-count cap (default 50); total
  bytes are bounded by the per-app blob quota. A very large single deploy body
  is rejected before it is parsed, so split huge bundles across redeploys, or
  upload rarely-changing files once via the attachments API and reference them
  by their `/_hs/attachments/:id` URL.

**Example: a scroll-scrub frame sequence (`deploy_app`).**

```jsonc
{
  "html": "<!doctype html><img id=f><script>const N=48,img=f;addEventListener('scroll',()=>{const i=Math.min(N-1,scrollY/innerHeight*N|0);img.src='frames/'+String(i).padStart(3,'0')+'.jpg'});img.src='frames/000.jpg'</script><div style='height:800vh'></div>",
  "manifest": { "x-homespun-manifest": { "app": { "name": "Scrubber" }, "collections": {} } },
  "assets": [
    { "path": "frames/000.jpg", "content_base64": "<base64 of frame 0>" },
    { "path": "frames/001.jpg", "content_base64": "<base64 of frame 1>" }
    // ... up to frames/047.jpg
  ]
}
```

A hosted video is the same shape with one
`{ "path": "media/clip.mp4", "content_base64": "<base64>" }` and a
`<video src="media/clip.mp4" controls>` tag; the browser's native seek issues
Range requests the relay answers with `206`.

**Avoiding base64 in the model context: reference an attachment by id.**

`content_base64` carries the file's bytes INLINE in the deploy call. When a model
emits that call through the MCP tool, those bytes ride in the tool-call arguments
and cost context tokens proportional to the file size, re-paid on every retry (a
few-hundred-KB image is already very costly). An asset entry has a second form
that carries no bytes, `{ path, attachment_id }`: name an already-uploaded
attachment and the deploy binds `path` to it.

```jsonc
"assets": [{ "path": "img/hero.jpg", "attachment_id": "att_..." }]
```

The referenced attachment must be **owned by you, app-scoped to THIS app, and
`ready`** (an agent-scoped attachment, or one belonging to another app, is
rejected with an opaque error). Two ways to produce one WITHOUT the bytes ever
entering the model context:

- **`attachments` action `fetch`** with `{ source_url, scope: "app", app_id }`:
  the relay downloads the bytes server-side (SSRF-gated, https only), runs the
  same sniff / allowlist / size / scan / quota pipeline as any upload, and
  returns a ready `attachment_id`. You send only a URL string. This is the
  least-effort zero-context path when the image is reachable at a URL.
- **`attachments` presign -> out-of-band PUT -> finalize** (see "Images, video,
  and any real media" below) with `scope: "app", app_id`: you PUT the raw bytes
  straight to storage, so they bypass the model context. Use this when you hold
  the bytes but not a URL.

Because an app-scoped attachment needs the app id, the order for a NEW app is:
`deploy_app` to create it (get `app_id`), then `fetch` / `presign` with
`scope: "app"` and that id, then redeploy with
`assets: [{ path, attachment_id }]`. For an EXISTING app, do it in one redeploy.
On a filesystem self-host (no presign backend) fall back to inline
`content_base64`: still correct, just not zero-context.

## Reading and writing data as the agent

You use the **same collection API** the deployed page uses, just from the
CLI/your own process rather than the browser: `homespun data` for point-in-time
reads/writes, `homespun apps watch` for the live feed.

```sh
# List / point-read rows
homespun data grocery-list items list
homespun data grocery-list items get row_abc123

# Write. Upsert is the ONLY create-shaped verb: omit --key to add a new
# row (server-generated key); pass --key to ensure a row exists at that key
# (returns the existing row with deduped:true on a collision, never errors)
homespun data grocery-list items upsert --data '{"name":"Milk","checked":false}'
homespun data grocery-list items upsert --key milk --data '{"name":"Milk"}'

# Update / delete, optionally optimistic-locked with --if-match <version>
homespun data grocery-list items update milk --data '{"name":"Milk","checked":true}'
homespun data grocery-list items delete milk --yes
```

`<app>` accepts either the app id or its slug throughout: `homespun data`,
`homespun deploy --app`, and every `homespun apps` subcommand resolve a slug via a
lookup automatically.

**Raw REST envelopes (only if you skip the CLI and SDK and call the HTTP API
directly).** The `homespun data` CLI and the browser `homespun.collections` SDK
both hand you the row shape directly, but the underlying REST endpoints WRAP it,
and a write and a list wrap it differently. If you call the API yourself, match
these exactly. Reading the wrong key gives you `undefined`, and a loop that
ignores that can silently drop every row it writes:

- `POST /v1/apps/:id/collections/:name` (create/upsert) returns
  `{ "row": { key, data, version, author, created_at, updated_at, deleted_at } }`
  (plus `"deduped": true` when an upsert matched an existing key). The row lives
  under `.row`, not at the top level. A keyed upsert that matches a row the
  collection's `read` list does not reach for you returns `404 row_not_found`
  instead of the body, the same answer a `GET` on that key gives, so the create
  door cannot be used to read past `read`. **Watch out:** the browser SDK's
  `homespun.collections.create()` hands back the row FLAT (`row.key`), so code
  written against the SDK shape reads `undefined` when pointed at the REST
  endpoint. Read `response.row`, not `response`.
- `PATCH .../:key` (update) and `GET .../:key` (point read) also wrap the row as
  `{ "row": {...} }`.
- `GET /v1/apps/:id/collections/:name` (list rows) returns
  `{ "rows": [...], "next_cursor", "has_more" }`. The array key is **`rows`**.
- `GET /v1/apps` (list apps) returns `{ "items": [...], "next_cursor" }`. The
  array key is **`items`**, not `rows`. The two list envelopes deliberately
  differ, so never assume one shape from the other.

**Watching the live feed** is the direct replacement for polling: streams the
app's change feed as JSON-lines, one compact object per line, over a
WebSocket with an automatic long-poll fallback (byte-identical output either
way, so a pipe consumer can't tell which transport served a given line):

```sh
homespun apps watch grocery-list
homespun apps watch grocery-list --collection items          # filter to one collection
homespun apps watch grocery-list --since <cursor> --once      # replay + exit after one entry
homespun apps watch grocery-list --timeout 300                # give up after 5 minutes
```

A dormancy transition mid-watch prints a single `{"type":"_dormant"}` line
and exits `0`. That's "the app went to sleep," not an error.

**Managing the app itself:**

```sh
homespun apps list                      # your apps, newest activity first
homespun apps list --status dormant     # filter by lifecycle status
homespun apps show grocery-list         # full detail: manifest, current_version, row_count, storage_bytes
homespun apps update grocery-list --visibility private
homespun apps wake grocery-list         # wake a dormant app
homespun apps delete grocery-list --yes # destructive, permanently removes the app and its data
```

Other identity/config commands still work exactly as you'd expect and are
unrelated to any of the above: `homespun config show` (inspect the resolved
url/api-key; `homespun config` bare with no verb is rejected with
`invalid_args`; `show` is the read-only inspection verb, alongside
`list`/`use`/`add`/`rm` for multi-profile management), `homespun agent logout`
(clear local credentials), `homespun key list|mint|revoke` (inspect / mint a
sibling / revoke your own API key). Run `--help` on any of them.

**Bootstrapping a credential with `key mint`.** `homespun key mint` (MCP: `key`
action `mint`) mints a NEW sibling API key for your OWN agent identity (same
scope and ownership) and returns its raw value ONCE. Use it when you are driving
Homespun over MCP and need to hand a fresh CLI or child process a working key of
its own: `mint`, capture the `api_key` from the response, and set it via
`homespun config` / `HOMESPUN_API_KEY`. The relay derives identity from your
key, so `mint` only ever mints a sibling of yourself, never another agent's
key. The raw key is never retrievable again (save it now), the sibling shows up
in a later `key list` made WITH it, and the owner can `key revoke` it like any
other key.

**Community templates over MCP, not the CLI.** Publishing an app as a community
template, reading a template's install-time config contract, and installing a
template into your own account all work through the `community` tool (MCP), not
through a `homespun` CLI verb. The `homespun` CLI itself deploys and iterates one
app at a time with `homespun deploy`; it has no publish/install subcommand, so
don't tell a human those live as CLI commands. See "Community templates:
configure and install" below for the install-time config contracts.

## Community templates: configure and install

A template can ask for install-time configuration: a display name, a theme, an
API key, a logo. The mechanism is generic and rests on three contracts, one per
role. Nothing app-specific lives in the platform.

**1. Publisher contract (when you publish a template).** Declare ONE settings
collection in the manifest under `x-homespun-manifest.settingsCollection`, naming
a collection in the same manifest whose write list is restricted to
`["owner","agent"]` (never a broad member write). Then declare the config the
template needs as ordered setup steps on `community` action `publish`
(`setup_steps`):

- A `config` step sets a value; an `upload` step is an install-time file (an
  image/logo) stored as an attachment id.
- Each `config`/`upload` step carries a `key` naming a top-level field of the
  settings collection's row schema. An `upload` target field must be typed
  `string` (it holds the attachment id). Publish validates every key against the
  schema, so broken wiring cannot ship.
- Mark a sensitive value `secret: true`. The public detail page never renders a
  secret's default, and when ANY step is secret the settings collection's `read`
  list must also be restricted to owner/agent (so members cannot read config
  through the mirror). Only ever publish your own example default, never a real
  secret.

At install the answers are written into ONE singleton row of the settings
collection at the reserved key `install-config`, as `{ [stepKey]: value }`.

**2. App-author contract (reading config in your app's HTML).** Read the
`install-config` row of your settings collection through the SDK collection
mirror, the same way you read any collection row. TOLERATE ABSENCE: a template
with no config, or an installer who skipped every optional step, leaves no row
(or a partial one), so fall back to your in-code defaults for any missing field.
An `upload` field's value is an attachment id string; render it from the app's
own origin at `/_hs/attachments/<id>` (an `<img src>`), exactly like any in-app
image. It serves under your app's visibility gate.

**3. Installing-agent contract (installing a template for your human).** Two
`community` actions:

- `get_config_contract` with `ref` (a namespaced `<handle>/<slug>` or a
  community snapshot id) returns the contract: `settings_collection` and the
  ordered `config_steps`, each with `key`, `kind` (`config` or `upload`),
  `required`, `secret`, `choices`, `default`, and `value_hint`. Read it first so
  you know what to collect.
- For each `upload` step, PRE-UPLOAD the file with the `attachments` tool
  (action `upload`, agent scope) and keep the returned attachment id.
- `install` with `ref` and `config` (a `{ stepKey: value }` map: a `config`
  value is a string, an `upload` value is the pre-uploaded attachment id).
  Installs always create a fresh private copy owned by your human. A required
  step you omit is rejected before anything is created; a value outside a step's
  `choices` is rejected; an upload id you do not own is rejected. On success the
  relay re-points your uploaded attachments to the new app so they serve under
  its gate. The response carries the new app's `app_id`, `slug`, and `url`.

Installs are agent-key. Trials and "keep my trial" stay human-only web flows.

### Receiving data from an external service (connect steps)

A template can also declare that the installed app RECEIVES data: a Stripe
event, a Zapier push, a form vendor's callback. That needs one extra hop,
because every copy of the app gets its OWN secret hook URL and only the
installer can paste it into the external service.

**Publisher side.** Declare the inbound hook in the manifest under
`x-homespun-manifest.ingest` (a `name` plus the `collection` it writes into),
then add a `connect` setup step whose `ingestRule` names that rule:

```json
"ingest": [{ "name": "stripe_events", "collection": "payments" }]
```

```json
{
  "kind": "connect",
  "label": "Point Stripe at this app",
  "description": "Add the hook URL as a webhook endpoint in your Stripe dashboard.",
  "ingestRule": "stripe_events"
}
```

`ingestRule` is allowed only on a `connect` step, and publish REJECTS a name the
manifest does not declare, so a step can never point at a hook that was never
provisioned. Everything else about `connect` steps is unchanged, and a plain
`connect` step with no `ingestRule` keeps working exactly as before.

**What the installer sees.** Installing (or keeping a trial of) such a template
lands the human on a finish-setup page that names each connect step and links to
the app's Inbound hooks panel, where they copy the freshly minted URL. The URL
carries its own secret, so it is shown in that ONE place and nowhere else; it can
be rotated there at any time.

**Installing-agent side.** `get_config_contract` returns `connect_steps`
alongside `config_steps`: each entry has `label`, `description`, `ingest_rule`,
and the rule's `collection` and `mode`. After `install` returns the new
`app_id`, read the provisioned URLs with the `ingest` tool's `list` action on
that app and wire each one into the external service the step describes. Do not
reuse a URL from another copy of the template: each install mints its own.

## Attachments (binary uploads)

Attachments are binary blobs (images, PDFs, audio, video, and text/data files)
you upload once and then reference from row data by their
`attachment_id` (a field declared with `format: homespun-attachment-id`
validates the id). Every upload is server-side MIME-sniffed from its bytes,
checked against the relay's allowlist, and counted against your size +
per-agent/per-app/per-account quotas.

**Per-file size limits are type-aware.** Images and every non-media type (pdf,
fonts, text/data) are capped at a modest per-file size (`MAX_BLOB_BYTES`, 5 MB
by default); audio and video get a larger per-file cap (`MAX_MEDIA_BLOB_BYTES`,
50 MB by default) since media is inherently bigger. The relay picks the cap
from the SNIFFED type, so declaring an image type to dodge the limit does not
help. Both caps are plan-drivable (a paid plan / operator override raises them
per account). The aggregate per-app and per-account byte quotas are the real
storage bound: the per-app total is **100 MB on the free tier**
(`MAX_BLOBS_PER_APP_BYTES`, raised to 250 MB for paid / overridden accounts) and
the per-account total is `MAX_BLOBS_PER_ACCOUNT_BYTES` (≈ 5 GB by default). An
over-cap upload returns `attachment_size_exceeded` (413), and an upload that
would push the per-app or per-account total over its quota returns
`quota_exceeded`.

The declared MIME is never trusted for a type that has magic bytes: an image /
audio / video / font / PDF whose bytes disagree with the declared type is
rejected (`mime_mismatch`), and an inline-safe media type is ALWAYS verified by
sniff so a lying declared type can never be served inline. **Text/data files
that have no magic bytes** (`text/plain`, `text/csv`, `text/markdown`,
`application/json`, `application/zip`, and the Word/OOXML `.docx/.xlsx/.pptx`
types) are the one exception: declare the real type and it is stored as that
type. They are always served as an inert download (`Content-Disposition:
attachment`), so trusting the declared type is safe. Supported audio now
includes `audio/aac` and `audio/flac` alongside mp3/wav/ogg/mp4.

**Watch the token cost of inline uploads.** An inline `content_base64` upload
carries the bytes in the tool-call arguments, so they enter the **model
context** and cost tokens **proportional to file size** (a few-hundred-KB image
is already very costly, and the cost repeats on every retry). So for any real
image or media, prefer the **presign** path below, which PUTs the bytes
out-of-band and never puts them in front of the model. Reserve inline
`content_base64` for genuinely small assets (a tiny icon) or clients that cannot
do an out-of-band HTTP PUT. (And for **end-user** photo uploads inside a
rendered app, use the in-page browser upload instead, which never touches the
agent at all: see "Let your app's users upload a file".)

There are two ways to hand the relay the bytes inline, and which one you can use
depends on where your code runs:

- **`content_base64` (base64 bytes) is the no-filesystem inline path.** Pass the
  file bytes as base64 and the relay stores them with NO filesystem access on
  either side. Use it for a small asset you generated in-session, or when you
  are talking to the hosted MCP connector and cannot PUT out-of-band. Via MCP:
  `attachments` action `upload` with `content_base64`. Remember the token cost
  above scales with the file, so reach for `presign` on anything bigger than an
  icon.
- **`file_path` reads the file on the RELAY host, not your machine.** For the
  hosted MCP connector that host is Homespun's infrastructure, so a path that
  exists on your side will fail with `ENOENT`. `file_path` only works when the
  file is genuinely local to the relay, e.g. a locally-run `homespun attachment
  upload --file <path>` CLI.

Both paths run the identical validation and return the same `AttachmentRef`
(`{ attachment_id, scope, mime, size, sha256, ... }`); an oversized or
disallowed upload returns the same error either way. Scope an upload to `agent`
(default, reusable across your apps) or `app` (pass `app_id`).

### Images, video, and any real media: presign -> PUT -> finalize

Prefer this path for **any real image or media**, not just huge files: base64-ing
the bytes inline puts them in the model context and costs tokens proportional to
their size (and can exceed message limits on a big file). Presign uploads the
bytes **out-of-band** so they go straight to storage over HTTP and never pass
through this tool or the model:

1. **`presign`**: call `attachments` action `presign` with `{ mime, size,
   sha256, scope }` (the `mime` is advisory; `size` is the exact byte length and
   `sha256` is the hex SHA-256 of the exact bytes you will upload). You get back
   `{ put_url, attachment_id }`.
2. **PUT the bytes**: do an HTTP `PUT put_url` with the raw file bytes as the
   body (a plain `curl -T file "$put_url"` or `fetch(put_url, { method: 'PUT',
   body })`). This is the step that keeps the bytes out of the model context.
3. **`finalize`**: call `attachments` action `finalize` with the
   `attachment_id`. The relay re-reads the stored bytes and runs the SAME
   validation any upload runs: it **byte-sniffs the actual content** and stores
   / serves THAT sniffed type (never the mime you declared at presign), and
   re-verifies size + sha256, the allowlist, your quota, and the scan hook. Only
   then does the attachment become `ready`. A file whose real bytes fail any
   check (a mime that lies, a size/sha256 that does not match, a disallowed
   type) is rejected and never served, so a presign claiming, say, `font/woff2`
   over HTML bytes can never be served inline under that lie.

The presigned path requires the hosted **Azure** storage backend. On a
filesystem self-host `presign` returns a clear not-supported error; use the
inline `content_base64` / `file_path` upload there instead.

Rule of thumb: use presign + finalize for **any real image or media** (the
bytes stay out of the model context, so it is both cheaper and unbounded by
message size); use inline `content_base64` only for a genuinely small asset (a
tiny icon) or a client that cannot PUT out-of-band.

### Thumbnails: on-demand resized images (`?w=`)

A raster image attachment can be served at a smaller width by adding a
`?w=<width>` query param to its serving URL. The relay downscales the image
with sharp on the first request, caches the result, and serves the cached
variant thereafter, so a photo-heavy app can request small thumbnails without
shipping the full-resolution bytes each time:

```html
<img src="/_hs/attachments/<id>?w=256" />        <!-- app-scoped attachment -->
<img src="frames/000.jpg?w=512" />               <!-- deploy asset -->
```

`?w=` also works on the agent download (`/v1/attachments/:id?w=256`) and the
capability URL (`/b/<token>?w=256`).

A bare `<img src="/_hs/attachments/<id>?w=256">` works for the app's OWN
attachment on a private app too: the read route accepts the app's own
same-origin session (owner/member), so the thumbnail renders on the app's own
page just like the full image. The only thing without a width parameter is the
JS-bytes read, `homespun.downloadBlob(id)`, so if you fetch the raw bytes in JS
you get the full image; use the `?w=` URL form when you want a resized variant.

Rules worth knowing:

- **Fixed width allowlist.** Only these widths are honoured: **64, 128, 256,
  512, 1024, 2048**. Any other value (e.g. `?w=300`, `?w=99999`) is IGNORED and
  the original image is served. The closed list bounds the number of cached
  variants per image to at most six.
- **Cached variants are free, regenerable cache.** A generated variant is NOT
  metered against your storage quota. It does not need to be: a variant is a
  downscale-only derivative of a source image that already counts against your
  quota, so total variant storage is inherently bounded (at most about 1.5x your
  live source bytes across the six widths). Every cached variant is deleted
  together with its source on every deletion path, so it can never outlive the
  image it came from.
- **Downscale only.** A width at or above the source width serves the original;
  images are never enlarged.
- **Raster only.** Works for `png` / `jpeg` / `webp` and static `gif`. An svg,
  an animated gif, a non-image type, or an image the relay can't decode all fall
  back to serving the original (never an error).
- **No thumbnails on an encrypting relay.** When the relay runs with
  `BLOB_ENCRYPT_AT_REST=true`, no variant is generated (a plaintext thumbnail
  would weaken the at-rest posture): `?w=` serves the full-size original, so a
  photo app gets no thumbnail / bandwidth benefit there.
- **Same hardening.** A variant is served through the same secure responder as
  the original: `X-Content-Type-Options: nosniff`, the sandbox CSP, and inline
  disposition for the raster image. Metadata (EXIF etc.) is stripped from the
  variant.

<!-- homespun:core:start -->

## Common gotchas (before you ship)

A short checklist of the things that most often go wrong. The first one is a
data-exposure trap, not a style nit, so read it first.

1. **⚠️ Collection read is UNRESTRICTED BY DEFAULT. This leaks PII.** Omitting
   `read` does not mean "private": it means everyone who can open the app reads
   every row, and on a `public`/`link` app that is every anonymous visitor on
   the internet, straight off the data API (`GET /_hs/c/<collection>`), page or
   no page. **Any collection the public can write to that captures personal data
   (emails, names, phone numbers, messages, orders, bookings) MUST declare
   `read: ["owner"]`** (add `"agent"`/`"member"` if they read it too). If you
   only need a public tally, use `countRead` (see "Recipe: a public count
   without exposing the rows"), never a wide-open `read`. When in doubt:
   collecting FROM the public means restricting who can READ.

2. **`notify` interpolation is single-row, top-level only.** Both `when.field`
   and the `{{fieldKey}}` templates read one of the changed row's OWN top-level
   keys: no nested paths, no array indexing, and no cross-row aggregates. "Email
   when there are 10 signups" is not a `notify` rule.

3. **The owner is anonymous until `login()`.** On a `public`/`link` app nobody,
   not even the owner, is signed in automatically, so any owner-only surface
   needs a sign-in control on the page (`homespun.session.login()`). See "Recipe:
   public submits, only the owner reads" for the full owner-sign-in affordance.

4. **`create()` server-mints the row key.** `homespun.collections.create(name,
   data)` returns a row with a server-generated `key`: do not invent a
   client-side id to identify a row. Use `upsert(name, key, data)` only when YOU
   own a meaningful natural key (e.g. a date), and when you do, **declare an
   `update` list**: a guessable key plus a `write` list that admits the public
   is a row takeover, because `write` on its own lets any caller it admits
   overwrite any row in the collection (see "Who may change a row"). An
   `update` list stops the overwrite but not the land-grab: whoever writes a
   guessable key first owns that slot for good, so prefer a server-minted key
   over a natural one wherever losing that race would matter. Never
   trust a client-written `author`/`by` field as proof of who wrote a row; the
   row's server-stamped `author` is the only tamper-proof attribution, and it
   names the row's LAST writer, not its creator.

5. **Anonymous visitors have no stable identity.** An anonymous caller's
   `session.humanId` is `null` and every anonymous write authors as the same
   `anon` sentinel, so you cannot tell two anonymous visitors apart server-side.
   They therefore never satisfy `creator`, `editor`, `author` or any
   `:own`/`:creator` suffix: a permission list scoped that way is always false
   for an anonymous caller, which is fail-closed and deliberate.
   When a public app needs to remember "this browser's own draft" (an RSVP they
   can edit, a cart), mint a client id in `localStorage` and store it IN the row
   data yourself:

   ```js
   function clientId() {
     let id = localStorage.getItem("cid");
     if (!id) { id = crypto.randomUUID(); localStorage.setItem("cid", id); }
     return id;
   }
   // Tag rows with it, then filter client-side to "mine".
   await homespun.collections.create("rsvps", { cid: clientId(), name });
   ```

   This is a convenience handle, not a security boundary (anyone can read/forge
   a `cid`); never gate anything sensitive on it.

6. **Verify before you deploy.** Run a syntax pass and open the built page in a
   real browser before shipping: a page that never loads its SDK renders a dead
   shell, and that only shows up at runtime:

   ```sh
   node --check <(sed -n 's/.*<script>\(.*\)<\/script>.*/\1/p' index.html) 2>/dev/null || true
   # then actually open it: a headless smoke check, or your own browser
   ```

   At minimum load the page, confirm `await homespun.ready` resolves, and click
   through the primary flow. Tests and typecheck do not catch a blank page.

7. **The SDK initializes synchronously now.** `window.homespun` is defined at
   parse time by an inline stub (the sync-stub fix), so referencing `homespun.*`
   at the top level of a plain `<script>` is safe and no longer throws.
   `DOMContentLoaded` gating is therefore no longer required: it stays a
   harmless good practice (it guarantees your elements exist). What you must
   still do is `await homespun.ready` before your first synchronous read.

<!-- homespun:core:end -->

## If you know the old (event) skill: migration note

If you learned homespun's v1 event/app/template model, here's
the direct mapping. Everything below is a rename or a fold onto the one
collection primitive, not a new concept:

| Old | New |
|---|---|
| `homespun.emit(type, data)` | `homespun.collections.create("events", { type, ...data })` on a manifest collection with `appendOnly: true` |
| `homespun.on(type, handler)` | `homespun.feed.on(handler, { collection: "events" })`, then check `entry.data.type === type` yourself |
| `homespun.state.events` | `homespun.collections.snapshot("events")` |
| `homespun.state.last(type)` | `homespun.collections.snapshot("events").findLast(r => r.data.type === type)` |
| `homespun.inputData` | a seed row you write yourself at deploy time (e.g. an app-config collection, key `"main"`), read via `homespun.collections.get(...)` |
| `homespun.records.*` | `homespun.collections.*`, the same seven methods (`snapshot/get/on/create/upsert/update/delete`), just renamed to match the manifest's `collections` keyword |
| `homespun create` / `homespun template create` / `homespun upgrade` | `homespun deploy` (create with no `--app`; redeploy with `--app <id>`) |
| `homespun watch <homespun-id>` | `homespun apps watch <app>` |
| `homespun send` | `homespun data <app> <collection> upsert` (or `update`). There's no separate "send an event" verb; you write into a collection like anything else |

There is no shim: a deployed app talks the new API only. If you're
migrating an existing template/app's HTML, expect to rewrite its data
calls, not just its imports.
