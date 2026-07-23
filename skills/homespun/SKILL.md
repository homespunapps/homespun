---
name: app
description: >-
  Build a small personal app for a human — an HTML page backed by live,
  queryable data — deploy it with one command, and keep collaborating with
  the human through it via a data API. One primitive: collections (a
  mutable, queryable row store with a live change feed). Use when a question
  or workflow deserves a persistent app the human can reopen anytime, not
  just a one-shot reply. Drives the `homespun` CLI: deploy an app, read/write its
  data, watch it for changes.
---

<!-- homespun skill v1.6.1 -->

# app

`homespun` deploys small apps for you. You author an HTML page plus a manifest
(what data it stores, who may read/write it), `homespun deploy` puts it live at
its own URL, and you stay a first-class collaborator on that app afterwards —
reading and writing its data, watching it for changes — through the exact
same collection API the page itself uses.

## When to use this

Use `homespun` when the interaction is richer than a text reply, OR when it
should **persist** — a dashboard the human reopens, a shared list you and the
human both edit over time, a tool that outlives this conversation. For a
one-shot question, just ask in text. For a rich but disposable one-shot
interaction, deploy a small app anyway — there's no separate "form" primitive
in v2; an app with one collection and no persistence expectation is just a
small, short-lived app.

<!-- homespun:core:start -->

## The mental model: one primitive

Everything an app stores is a **collection** — a named, mutable, queryable
set of rows, each with a `key`, a `data` payload, an optimistic-lock
`version`, and an `author`. Every write (create, update, delete) also lands
on the app's **change feed**, an ordered log you and the page can both
subscribe to. That's it: one data primitive, one feed. There is no separate
"event" type and no template/app split — an app IS its HTML plus its
manifest plus its collections.

**Append-only collections are how you get "events."** If you want an
audit trail or a one-shot journaled fact ("this happened") rather than a
mutable row, declare the collection `appendOnly: true` in the manifest (see
below) and only ever `create` into it — never `update`/`delete`. You get
exactly what a v1 "event" gave you (an ordered, immutable, replayable log),
expressed through the same collection API instead of a second primitive.

The three things you build:

1. **A manifest** — declares the app's collections (with row schema and
   who may write/delete each), which external hosts its page may fetch from,
   and whether it may load CDN scripts/styles.
2. **An HTML page** — talks to its own data exclusively through
   `window.homespun.collections.*` and `window.homespun.feed`, injected by the
   relay at runtime.
3. **Deploys** — `homespun deploy` puts the app live; `homespun deploy --app <id>`
   redeploys it in place, same URL.

After that, you (the agent) read and write the same collections the page
reads and writes, via `homespun data`, and watch the app's live feed via
`homespun apps watch` — the same round trip the human's browser gets, just from
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

- **The filter never widens what you can read.** Read permission + author
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
  author: { kind: "human" | "agent" | "anon"; id: string };
  createdAt: string;  // ISO 8601 timestamp (camelCase, NOT created_at)
  updatedAt: string;  // ISO 8601 timestamp (camelCase, NOT updated_at)
}
```

The row's `author` is **server-stamped and tamper-proof**: it records who
actually wrote the row. Its `kind` is one of `"human"`, `"agent"`, or `"anon"`
(the sentinel for a truly-anonymous writer on a public/link app). **That is a
DIFFERENT enum from `homespun.session.kind`**, whose values are `"owner"`,
`"member"`, and `"anonymous"`. So do not special-case
`row.author.kind === "anonymous"` to mirror the session enum: it silently
never matches, because a row author uses `"anon"`. Resolve an author to a
display name with `homespun.members.nameFor(row.author)`.

Storing a self-declared name is fine and is not the same thing as attribution:
a guestbook, RSVP, or booking legitimately keeps the responder's stated name
in `data` (e.g. `data.name`), and you should render it as what they called
themselves. The one rule is that a self-declared field is never PROOF of who
wrote the row. Render `data.name` as their stated name and
`homespun.members.nameFor(row.author)` as who actually wrote it (server-stamped);
never treat the former as the latter.

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
id twice (a retry after a slow 2xx), so treat that header as an idempotency key
and dedupe on it.

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


## Setup

If the `homespun` command isn't on your PATH yet, install it first:
`npm i -g @homespunapps/cli`.

The hosted relay (`https://homespun.dev`) is the default — `homespun agent register`
works out of the box. The CLI needs:

- **An agent API key.** Either pre-provided by the operator (as
  `HOMESPUN_API_KEY`), or obtained yourself via `homespun agent register` (see
  "Registering" below). Once registered, the key is saved to the config file
  and you don't need `HOMESPUN_API_KEY` at all.
- **A relay URL.** Only relevant for self-hosters — set `HOMESPUN_URL` (or pass
  `--url`) to point at a non-hosted relay. Note this is the **control-plane**
  URL (where `deploy`/`apps`/`data` talk) — the *deployed app itself* is
  served on its own domain (see "Serving and security" below), not under
  this URL.

Output is JSON on stdout. Errors are `{"error":{"code","message"}}` on stderr
with a non-zero exit.

## Keeping this skill up to date

This skill carries its version in an HTML comment near the top of the file:

```
<!-- homespun skill vX.Y.Z -->
```

**The skill version is the app package version** (`@homespunapps/relay`,
`@homespunapps/cli`, `@homespunapps/core` — all kept in lockstep by the release
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
# skill — skip the update and proceed with what's local.
if [ "$REMOTE_VER" = "0.0.0" ]; then
  : # nothing to do
elif [ "$LOCAL_VER" != "$REMOTE_VER" ]; then
  homespun skill show > <path-to-your-local-skill>   # overwrites with the relay's current skill
fi
```

Where `<path-to-your-local-skill>` is wherever YOUR runtime stores the app
skill (e.g. `~/.claude/skills/homespun/SKILL.md` for Claude Code,
`~/.cursor/rules/app.mdc` for Cursor, the relevant section of
`~/.codex/AGENTS.md` for Codex / Gemini-style concatenated files).

The two `grep`s above are intentionally strict:

- `-m1` stops at the first match in the file, so prose mentions of the
  pattern (this very section!) don't double-count.
- `[0-9]+\.[0-9]+\.[0-9]+` only matches a real semver triple, so a
  literal `<!-- homespun skill vX.Y.Z -->` in documentation is skipped.

Rules:

- If the local file has no `<!-- homespun skill v... -->` comment, treat it as
  stale and run `homespun skill show > <path>`.
- If `REMOTE_VER` is `0.0.0`, skip the update — the relay is on an old
  image without a version comment, and clobbering your (presumably newer)
  local copy with that would be a downgrade.
- If the network is unreachable or `homespun skill version` fails, **do not
  update** — proceed with the local skill you have.
- Don't loop. Check once at conversation start; if you've already refreshed in
  this run and it's still mismatched, stop and report the error to
  the human.
- If you've hand-edited the local skill (added your own notes), save your
  changes first — `homespun skill show > <path>` is a clobbering write.

## Discover the CLI with `--help`

**Before using a command, run its help.** This skill summarizes the workflow,
but `--help` is the authoritative, always-current reference for every flag,
argument, and default:

- `homespun --help` — the command list and global options.
- `homespun <command> --help` — every flag and option for that command, e.g.
  `homespun deploy --help`, `homespun apps --help`, `homespun apps watch --help`,
  `homespun data --help`.

If a command errors or you are unsure of an option name, **run `--help`
instead of guessing** — the CLI is self-documenting and the help text reflects
the installed version, which this skill may not.

### If `homespun` exits 75 ("CLI upgrade required")

The relay you're talking to needs a newer `@homespunapps/cli` than you have
installed. The CLI signals this with **exit code 75** (`EX_TEMPFAIL`) and a
stderr message that starts with `app: this relay requires @homespunapps/cli >=
<version>`. If that message includes a `To upgrade: <command>` line, the
command is correct for how `homespun` was installed on this machine — there's
nothing to guess.

What to do, in this order:

1. **Run the printed upgrade command once.** If no command is printed (the
   message says "vendored" or "unknown" install), stop and ask the human to
   bump `@homespunapps/cli` — don't try to install one yourself.
2. **Re-run your original `homespun` command once.** If it succeeds, continue.
3. **If it still fails with exit 75 after one upgrade + retry**, stop and
   report the error to the human. Do not loop — repeated upgrade attempts
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

**Default: browser approval (device flow).** On a relay that supports it,
`homespun agent register` runs an RFC 8628 style device-authorization flow:

1. The CLI calls `POST /v1/device/code` and prints a verification URL plus a
   short code like `ABCD-EFGH` (15-minute TTL).
2. Show them to your human: they open the URL **on any device** (their phone
   works), sign in, and click Approve.
3. The CLI polls `POST /v1/device/token` and, on approval, receives the new
   agent's API key exactly once and saves it to the CLI config file
   (`${XDG_CONFIG_HOME:-~/.config}/homespun/config.json`, mode 0600). After
   that, every other command picks the key up from that file automatically.

The progress lines (URL + code) go to stderr; the final JSON lands on stdout
with `"registered_via": "device"`. Crucially, a device-flow agent is **already
owned** by the human who approved it: no separate claim step is needed, and
`homespun deploy` works immediately.

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
   "My agents" → "Claim a new agent" → "Generate claim code" — this calls
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
   gets `agent_already_claimed` (409) — there's no unclaim/re-claim in v1. To
   change owners, register a fresh agent and have the new human claim that one.

If `homespun deploy` fails with `agent_not_claimed`, stop and ask the human to
mint you a claim code — don't guess at a workaround.

<!-- homespun:core:start -->

## Authoring an app: the manifest

The manifest is a plain JSON Schema 2020-12 document with one namespaced
extension key, `x-homespun-manifest`. It is the **whole consent surface** — what
it declares is exactly what the relay enforces at runtime, so be as precise
as you can: unknown keys are hard rejected (a typo is a deploy-time error,
never silently ignored), and there are no implicit grants — `owner`/`agent`
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
        "write": ["agent", "owner", "member"],
        "delete": ["agent", "owner", "member"]
      },
      "audit": {
        "schema": { "$ref": "#/$defs/AuditEntry" },
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

> **SAFETY: `read` is UNRESTRICTED BY DEFAULT.** Omitting `read` does not mean
> "no one can read", it means EVERYONE who can open the app reads every row. On
> a `public` or `link` app that is every anonymous visitor on the internet. So
> if a collection can be written by the public (its `write` includes `"anyone"`,
> or the app is `public`/`link`) AND it holds anything a person would not want
> shown to strangers (names, emails, phone numbers, messages, orders, bookings,
> any personal data), you MUST set `read` to the roles that should see it:
> typically `["owner", "agent"]`, plus `"member"` when staff read it too.
> Otherwise every visitor can read every submission by hitting the data API
> (`GET /_hs/c/<collection>`) directly; the page is not what protects the rows,
> the `read` list is.
>
> **Rule of thumb: collecting data FROM the public? Restrict who can READ it.**
> The "public submits, only the owner reads" recipe below is exactly this shape:
> `orders` sets `read: ["owner", "agent"]` because the submissions are private,
> while `menu` omits `read` on purpose because it is meant to be world-readable.

Fields, exactly:

- **`x-homespun-manifest.app`** — `name` (required, ≤80 chars), `description`
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
- **`x-homespun-manifest.collections`** — a map of collection name →
  `{ schema?, write, delete, read?, countRead?, appendOnly?, seedOnInstall? }`.
  An app may declare zero collections (a purely presentational app).
  - **`schema`** — `{ "$ref": "#/$defs/<Name>" }` into the document's own
    `$defs`. Optional — omit it for a schemaless collection (rows validated
    only at your own discretion). Cross-document refs are not supported.
    **A declared schema is STRICTLY ENFORCED:** any `create`/`upsert`/`update`
    whose `data` fails the schema is rejected `422 row_schema_violation`, with
    the failing JSON Schema paths listed in the error's `details`. Nothing in
    this block is advisory: `schema`, `write`, `delete`, `read` and
    `appendOnly` are all enforced by the relay on every request, through the
    same door for browser visitors and for you as the agent. A non-conforming
    write never lands.
  - **`write`** — required, non-empty array of roles that may `create`/
    `upsert`/`update` rows in this collection.
  - **`delete`** — required, non-empty array of roles that may delete rows.
  - **`read`**: optional array of roles. **It IS enforced, server-side, on
    every read** (list, single-row get, and the live change feed), exactly the
    way `write` and `delete` are. Semantics:
    - **Omitted** (the common case): anyone who can open the app can read the
      collection. This is the back-compat default, so leaving `read` off keeps
      a collection world-readable within the app's visibility. On a public/link
      app that means every anonymous visitor, so do not leave it off on a
      collection that stores anything private (see the SAFETY note above).
    - **Declared, and the caller holds one of the listed roles**: the read is
      allowed and returns every row.
    - **Declared, and the caller holds none of them** (including an explicit
      empty `read: []`): the read is refused `403 collection_read_forbidden`,
      whose `hint` names the roles the collection requires. This applies to the
      data API itself, so a visitor calling the collection endpoint directly is
      refused just as the page would be.
    - **`read: ["author"]`** scopes reads to the caller's *own* rows: a list
      returns only rows that caller authored, and a get on a row authored by
      someone else returns `404 row_not_found` (the same error a missing key
      returns) rather than a 403, deliberately, so a caller cannot probe which
      keys exist. An anonymous visitor has no author identity, so it can never
      satisfy `author` and is refused `403` outright.
    - Matching is **literal, with no implicit grants**: `read: ["owner"]` does
      not silently include `agent`, and under a bare `read: ["author"]` even
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
      and no field values. Matching is literal (no implicit grants), the same
      as `write`/`delete`; `"author"` is not accepted (a count is an aggregate,
      not a per-row view). v1 is a whole-collection total with no filtering.
    - It does **not** relax `read`: the rows stay exactly as protected as
      before, so this is safe to add to a collection that captures private
      submissions.
  - **`appendOnly`**: optional boolean (default `false`). Set `true` for a
    journal/event-shaped collection: rows can be created but never updated or
    deleted. **This is enforced, not advisory:** an update or delete against an
    append-only collection is refused `403 append_only` for *every* role,
    including `owner` and `agent`, and that check runs before the role match,
    so an append-only violation reports `append_only` rather than a misleading
    "forbidden". Model an edit as a new row.
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
    to the app's visibility), `author` (row-scoped: the human/agent who
    authored *that specific row*; valid in `delete` and `read`, not in
    `write`, since a create has no pre-existing row to be the author of).
- **`x-homespun-manifest.externalHosts`** — an array of `https://` origins
  (DNS name, optional single leftmost `*.` wildcard, no path/query/IP
  literal) the page's `fetch`/`XMLHttpRequest` is allowed to reach. This is
  the **only** way a deployed app can talk to anything besides its own data
  API — see "Serving and security" below.
- **`x-homespun-manifest.cdn`** — boolean, default `false`. Set `true` to allow
  `<script src>`/`<link rel=stylesheet>` from any `https:` origin (a CDN).
  It does **not** widen what the page can `fetch()` — that's `externalHosts`
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
    "write": ["agent", "owner"],
    "delete": ["agent", "owner"]
  },
  "orders": {
    "schema": { "$ref": "#/$defs/Order" },
    "write": ["anyone", "owner", "agent"],
    "delete": ["owner", "agent"],
    "read": ["owner", "agent"]
  }
}
```

An anonymous customer can POST an order (it lands with an `anon` author), but
listing `orders` gives them `403 collection_read_forbidden`: only the owner and
you can read the queue, and that is enforced by the relay, so hitting the data
API directly gets them nothing the page would not show them either. `menu` omits
`read`, so it stays readable by every visitor, which is exactly what you want for
the half of the app the customer is supposed to see.

Adding `"author"` to that `read` list lets each submitter see their own row back
(an order status page) without seeing anyone else's, but only for submitters who
are *signed in*: `author` needs a stable identity to match a row against, and an
anonymous visitor has none, so it stays a `403` for them. Keep the queue
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
    "delete": ["owner"],
    "read": ["owner"],
    "countRead": ["anyone"]
  }
}
```

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
| `homespun.ready` | `Promise<void>` — resolves once the session is resolved and every declared collection has been snapshotted into the local mirror. `await` it before your first synchronous read. |
| `homespun.collections.snapshot(name)` | Synchronous read of every row currently in the local mirror. `[]` before `ready`. |
| `homespun.collections.get(name, key)` | Synchronous point read; `undefined` if absent/deleted. |
| `homespun.collections.count(name)` | `Promise<number>`: the collection's live row count from the server. Works even when the caller cannot read the rows, if the manifest opted in with `countRead` (the "3 spots left" shape). Network read, not a mirror read. Rejects `collection_count_forbidden` when not opted in. |
| `homespun.collections.on(name, handler)` | Live deltas for one collection, already folded into row shape — `{kind:"upsert", collection, row: HomespunRow}` or `{kind:"delete", collection, row:{key, deletedAt}}`. Returns an unsubscribe function. |
| `homespun.collections.create(name, data)` | `POST`; the server generates the row key. Returns the created `HomespunRow` FLAT. (The raw `POST /v1/apps/:id/collections/:name` REST endpoint instead wraps it as `{ "row": ... }`; see "Raw REST envelopes" if you call the API directly.) |
| `homespun.collections.upsert(name, key, data)` | Create-or-return-existing for a caller-supplied key (idempotent). |
| `homespun.collections.update(name, key, data, {ifMatch?})` | Optimistic-locked update. A stale `ifMatch` rejects with `code:"conflict"` and `details.current` set to the winning row. |
| `homespun.collections.delete(name, key, {ifMatch?})` | Soft-delete (tombstone). |
| `homespun.feed.on(handler, {collection?})` | Unfiltered (or single-collection-filtered) live change feed — every create/update/delete across the app, in order. Each entry is a raw `FeedEntry`: `{seq, op:"create"\|"update"\|"delete", collection, key, data, author, ts}`. **Note the field is `op`, not `kind`** — `feed.on` and `collections.on` carry different shapes (see below). |
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
    // Live updates — from the human's own edits AND from `homespun data upsert`
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
  (`{kind:"upsert"|"delete", row}`) — reach for it when you just want to
  re-render on change, as in the example above. `feed.on` gives you the raw,
  unfolded `FeedEntry` (`{seq, op, collection, key, data, author, ts}`,
  field is **`op`** not `kind`) across the whole app (or one collection via
  `{collection}`) — reach for it when you need ordering/`seq`, cross-collection
  events, or the entry's own metadata (`author`, `ts`) rather than just the
  resulting row.
- **`.textContent`, never `.innerHTML`**, for anything containing human- or
  agent-authored text — the same injection discipline as any other web page.
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
- **No relay-injected stylesheet or CSS variables in v2.** Unlike the old
  app viewer, a deployed app gets no default styling — you own 100% of the
  CSS from the first paint. Write real, theme-aware CSS (respect
  `prefers-color-scheme` yourself) rather than assuming a house style exists.
- **Network access is manifest-gated, not blanket-blocked.** A v2 app is a
  real top-level page (not a sandboxed iframe): `fetch`/`XMLHttpRequest` work
  against `'self'` (its own data API) plus whatever origins you declared in
  `externalHosts`; nothing else. `<script src>`/`<link rel=stylesheet>` from
  an external `https:` origin additionally requires `cdn: true`. Images,
  fonts, and media may load from any `https:` origin (or `data:`) regardless
  of `cdn`/`externalHosts` — those are display-only and can't exfiltrate
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

## Serving and security — what an app's origin can and can't do

Each deployed app is served **top-level**, at its own subdomain
(`<slug>.homespunapps.com`) — not embedded in an iframe. A few things follow
from that:

- **No cookies on the app's origin.** The usercontent domain strips every
  inbound `Cookie` header and drops every outbound `Set-Cookie` — nothing on
  that origin ever reads or sets one. Session state lives in the browser's
  `localStorage`, scoped per-app-origin, and is established via
  `homespun.session.login()` (a redirect to the identity provider) rather than a
  cookie.
- **`connect-src` is `'self'` plus your declared `externalHosts` — never
  wider**, regardless of the `cdn` flag. `cdn: true` only widens
  `script-src`/`style-src` (code you load), not what the page can fetch —
  keeping "can load a charting library" and "can exfiltrate data" as two
  separate grants.
- **Visibility gates who can open the app at all**: `private` (only the
  owner plus invited members, sign-in gated; this is the default), `link`
  (anyone with the URL), `public` (listed and discoverable). This is
  orthogonal to the per-collection `write`/`delete` role lists in the
  manifest; visibility controls who can load the page, the manifest roles
  control who can write which collection once they are on it.
- **Only a private app gets a sign-in gate.** A public or link app serves its
  page to anonymous visitors directly, so if it has any owner-only or
  member-only surface, the page itself has to offer the way in
  (`homespun.session.login()`); otherwise the owner is stuck anonymous on their
  own app. Sessions are per-origin: signing in on the main site does not sign a
  person in to an app. See "Recipe: public submits, only the owner reads".

## Deploying and iterating

`homespun deploy` is the one command for both creating and redeploying — decided
by whether you pass `--app`, not by two separate verbs. Tell the human their
new app is private until they invite members or change its visibility.

**Canonical shape — a directory with two fixed filenames:**

```sh
homespun deploy ./my-app
#   reads ./my-app/index.html and ./my-app/manifest.json — no discovery
#   heuristics, both files required
```

**Escape hatch — a single HTML file plus an explicit manifest:**

```sh
homespun deploy ./index.html --manifest ./manifest.json
# --manifest also accepts inline JSON
```

**Create** (no `--app`) — `POST /v1/apps`:

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

**Redeploy** (`--app <id-or-slug>`) — `POST /v1/apps/:id/versions`:

```sh
homespun deploy ./my-app --app grocery-list
# -> { app_id, version, visibility, created: false, compat, breaks? }
```

- `--slug`/`--visibility` cannot be changed here — slug is immutable for the
  app's lifetime; change visibility with `homespun apps update --visibility`.
- **The compat gate.** By default the relay refuses a redeploy that
  *narrows* the manifest against the currently-live one — removing a
  collection, tightening a schema, dropping a write/delete role that used to
  be granted — because rows already written under the old contract could
  stop making sense. It fails `422` with `details.breaks[]` naming every
  offending path. Adding collections/roles or loosening constraints is
  always compatible. Pass `--force` to redeploy anyway (a narrowed
  collection is detached, not deleted — its rows aren't destroyed).

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
CDN. Each asset is `{ path, content_base64, mime? }`:

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
- **Redeploy replaces the set.** A redeploy's `assets[]` becomes the new
  version's map; the previous version's assets are detached, so a removed path
  simply stops resolving as an asset.
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

## Reading and writing data as the agent

You use the **same collection API** the deployed page uses, just from the
CLI/your own process rather than the browser — `homespun data` for point-in-time
reads/writes, `homespun apps watch` for the live feed.

```sh
# List / point-read rows
homespun data grocery-list items list
homespun data grocery-list items get row_abc123

# Write — upsert is the ONLY create-shaped verb: omit --key to add a new
# row (server-generated key); pass --key to ensure a row exists at that key
# (returns the existing row with deduped:true on a collision, never errors)
homespun data grocery-list items upsert --data '{"name":"Milk","checked":false}'
homespun data grocery-list items upsert --key milk --data '{"name":"Milk"}'

# Update / delete — optionally optimistic-locked with --if-match <version>
homespun data grocery-list items update milk --data '{"name":"Milk","checked":true}'
homespun data grocery-list items delete milk --yes
```

`<app>` accepts either the app id or its slug throughout — `homespun data`,
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
  under `.row`, not at the top level. **Watch out:** the browser SDK's
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

**Watching the live feed** — the direct replacement for polling: streams the
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
and exits `0` — that's "the app went to sleep," not an error.

**Managing the app itself:**

```sh
homespun apps list                      # your apps, newest activity first
homespun apps list --status dormant     # filter by lifecycle status
homespun apps show grocery-list         # full detail: manifest, current_version, row_count, storage_bytes
homespun apps update grocery-list --visibility private
homespun apps wake grocery-list         # wake a dormant app
homespun apps delete grocery-list --yes # destructive — permanently removes the app and its data
```

Other identity/config commands still work exactly as you'd expect and are
unrelated to any of the above: `homespun config show` (inspect the resolved
url/api-key — `homespun config` bare with no verb is rejected with
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
you upload once and then reference from row data or event payloads by their
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
   own a meaningful natural key (e.g. a date). Never trust a client-written
   `author`/`by` field as proof of who wrote a row; the row's server-stamped
   `author` is the only tamper-proof attribution.

5. **Anonymous visitors have no stable identity.** An anonymous caller's
   `session.humanId` is `null` and every anonymous write authors as the same
   `anon` sentinel, so you cannot tell two anonymous visitors apart server-side.
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

## If you know the old (event) skill — migration note

If you've used app before and learned the event/app/template model, here's
the direct mapping — everything below is a rename or a fold onto the one
collection primitive, not a new concept:

| Old | New |
|---|---|
| `homespun.emit(type, data)` | `homespun.collections.create("events", { type, ...data })` on a manifest collection with `appendOnly: true` |
| `homespun.on(type, handler)` | `homespun.feed.on(handler, { collection: "events" })`, then check `entry.data.type === type` yourself |
| `homespun.state.events` | `homespun.collections.snapshot("events")` |
| `homespun.state.last(type)` | `homespun.collections.snapshot("events").findLast(r => r.data.type === type)` |
| `homespun.inputData` | a seed row you write yourself at deploy time (e.g. an app-config collection, key `"main"`), read via `homespun.collections.get(...)` |
| `homespun.records.*` | `homespun.collections.*` — same seven methods (`snapshot/get/on/create/upsert/update/delete`), just renamed to match the manifest's `collections` keyword |
| `homespun create` / `homespun template create` / `homespun upgrade` | `homespun deploy` (create with no `--app`; redeploy with `--app <id>`) |
| `homespun watch <homespun-id>` | `homespun apps watch <app>` |
| `homespun send` | `homespun data <app> <collection> upsert` (or `update`) — there's no separate "send an event" verb; you write into a collection like anything else |

There is no shim: a deployed app talks the new API only. If you're
migrating an existing template/app's HTML, expect to rewrite its data
calls, not just its imports.
