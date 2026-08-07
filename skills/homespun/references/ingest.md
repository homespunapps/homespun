<!-- homespun skill reference: ingest -->

# Ingest: inbound catch-hooks

A reference section of the homespun skill. Read this before declaring an
`ingest` rule in a manifest. An inbound catch-hook is the receiving
counterpart to `webhooks`: instead of the relay pushing a row change out to
another system, an external system (Stripe, Zapier, Make, Home Assistant,
GitHub, or anything that can POST JSON) pushes data IN, and the relay writes
it straight into a declared collection with no agent online to receive it.

Hooks are declared in the manifest's `x-homespun-manifest.ingest` array,
validated at deploy, and materialized into a secret URL:
`POST /v1/ingest/:hookId/:secret`. There is no dashboard-created or
agent-created hook past that: add or remove one by editing the manifest and
redeploying.

## The rule shape

```json
"ingest": [
  {
    "name": "stripe-payments",
    "collection": "payments",
    "mode": "upsert",
    "upsertOn": "external_id",
    "map": {
      "external_id": "id",
      "amount": "data.object.amount",
      "customer": "data.object.customer"
    },
    "dedupeKey": "id",
    "handshake": "echo",
    "verify": { "scheme": "github" },
    "wake": true
  }
]
```

Every key past `name` and `collection` is optional. An unknown key is a hard
deploy error: the strict per-rule allowlist is itself part of the security
posture, since it is what keeps a rule to pure field selection and stops an
executable or credential key from being smuggled in.

- **`name`** (required): the hook's identity, unique within the app. Same
  character grammar as a connection name: lowercase alphanumeric, interior
  `_`/`-`, starting alphanumeric, up to 64 chars. It survives redeploys, so the
  same name keeps the same URL.
- **`collection`** (required): must name a collection already declared under
  `x-homespun-manifest.collections`.
- **`mode`**: `"append"` (default) writes a new row on every delivery.
  `"upsert"` merges onto an existing row matched by `upsertOn`.
- **`upsertOn`**: required if and only if `mode` is `"upsert"`, and rejected
  outright when present on an `"append"` rule. Must name one of the target
  collection's declared `unique` fields: the merge key has to be enforceably
  unique, or two concurrent deliveries could race to create duplicate rows.
- **`map`** (optional): an object of target row field to dot-path into the
  parsed JSON body, e.g. `"customer.name"` or `"items.0.id"`. Every value must
  be a valid dot-path string, never a nested object or a number, so a rule
  stays pure field selection and never an inline transform. Absent means the
  raw default row `{ hook, payload, receivedAt }`, with the whole parsed body
  under `payload`. A path that resolves to nothing OMITS that field from the
  row; it never writes a `null` for a field the body simply did not have (see
  "Nullable fields" below for the opposite case, an explicit `null`).
- **`dedupeKey`** (optional): where the redelivery-dedupe value comes from. It
  has two forms, covered in its own section below because this is the part
  most likely to be gotten wrong.
- **`handshake`**: `"echo"` is the only value in v1. Answers a Slack- or
  Microsoft-Graph-style URL-verification POST: when the parsed body carries a
  string `challenge` field, that value is echoed back and nothing is
  journaled.
- **`verify`** (optional): opts into signature verification,
  `{ "scheme": "github" }` being the only value in v1 (Stripe and
  generic-header schemes are a later slice). Its presence flips the hook from
  "the URL secret is the sole authenticator" to "the URL secret plus a valid
  body signature": an inbound POST that fails verification is rejected `401`
  and never written. A malformed `verify` fragment is a hard deploy error, not
  a silent degrade, because silently turning verification off would be a
  fail-open that lets a bare URL-secret holder write without the signing
  secret.
- **`wake`**: boolean, default `false`. `true` auto-wakes a dormant app on an
  accepted delivery.

At most `INGEST_MAX_HOOKS` rules per app (default 10). A manifest declaring
more fails deploy naming the count and the limit. A duplicate `name` within
one manifest is also a deploy error, since `name` becomes the hook's identity.

## Nullable fields

A mapped field arrives one of two ways, and the target collection's schema has
to allow both:

- The source path is **absent** from the body: the field is omitted from the
  row, never written as `null`.
- The source path is **present with an explicit `null`**: the field is written
  as `null`.

A sender that sends `null` for a field rather than leaving it out (GitHub does
this: a `workflow_job` webhook sends `"conclusion": null` on the `queued` and
`in_progress` events, with the real value arriving only on `completed`) needs
that field typed as nullable in the collection schema
(`{ "type": ["string", "null"] }`), or every delivery carrying the explicit
`null` fails with a schema violation.

## `dedupeKey`: two forms

`dedupeKey` names where the value that dedupes a redelivery comes from. It is
EITHER of two forms, never a mix:

- **A dot-path into the parsed JSON body** (the default form), e.g. `"id"` or
  `"data.object.id"`. The resolved value must be a scalar: a string is used
  as-is, a number or boolean is stringified. A path that resolves to nothing,
  or to an object or array, dedupes as "no value" (see the trap below).
- **`header:<name>`, a request-header reference**, e.g.
  `"header:x-github-delivery"`. `<name>` is a lowercase HTTP header name:
  starts with an alphanumeric character, then interior `-`, up to 64 chars
  total. This form exists for a sender whose replay id lives in a header
  rather than the body: GitHub puts its delivery id in the `X-GitHub-Delivery`
  header, and its webhook bodies carry no equivalent stable id of their own,
  so a body-path dedupe cannot cover them.

```json
{
  "name": "gh-issues",
  "collection": "issues",
  "dedupeKey": "header:x-github-delivery"
}
```

Three things about the header form that are not obvious from the manifest
syntax alone:

- **The lookup is case-insensitive.** HTTP header names are case-insensitive
  by the protocol, so the reference is normalized to lowercase at deploy and
  the receive-time lookup is case-insensitive too:
  `"header:X-GitHub-Delivery"` and `"header:x-github-delivery"` behave
  identically.
- **An absent header resolves to "no value"**, the SAME "not deduped, delivery
  accepted" semantics as an absent body path (see the trap below). It is never
  a hard failure: the delivery is still written, it is just not protected
  against a future redelivery.
- **A `header:<name>` dedupeKey never resolves during a backfill**
  (`homespun ingest backfill`). Backfill replays stored provider bodies, not
  live HTTP requests, so there are no request headers to read; a body-path
  dedupeKey still dedupes correctly during a backfill, a header-path one does
  not. Keep this in mind if a hook's live traffic dedupes on a header:
  backfilling historical payloads through it will not catch a duplicate body
  in the file.

## The trap: no `dedupeKey` means no deduplication, silently

With **no `dedupeKey`** declared, every delivery to the rule resolves to a
null dedupe value, redeliveries of the exact same payload included. The
database guard that would otherwise catch a repeat is a UNIQUE index on
`(app, hook, dedupe value)` that only applies WHILE the dedupe value is
non-null (a partial index, `WHERE dedupe_value IS NOT NULL`); two `NULL`s are
never equal to each other under that index, so a resend is written as a brand
new row every single time, not merged, not dropped.

This is not a bug, it is the declared default: for a rule with no other guard,
"write every delivery, including any redelivery" is today's ordinary
`append` behaviour, unchanged by the existence of dedupe elsewhere. It is also
the kind of thing that looks correct in a quick manual test (POST once, see
one row) and only breaks under a REAL redelivery, which is exactly the
situation a sender like Stripe or GitHub eventually produces: a slow `2xx`, a
network blip, or the sender's own at-least-once delivery guarantee all
produce a second POST of the identical payload, and without a `dedupeKey` it
lands as a second row.

Any hook fed by a sender that can retry, which in practice is most of them,
needs a `dedupeKey` naming the sender's own idempotency or delivery id if a
duplicate row (or, for `upsert`, a duplicate merge) would be wrong: the
event's own `id` field for Stripe, the `X-GitHub-Delivery` header for GitHub.

## Optimistic locking with `if_match`

`if_match` is NOT a manifest key. It is a top-level field in the POST BODY of
an individual delivery, read straight off the parsed JSON body under the
exact field name and type the direct
`PATCH /v1/apps/:id/collections/:name/:key` route's body already uses: a
non-negative integer.

```json
{ "id": "cust_42", "status": "reviewed", "if_match": 3 }
```

It exists for a backend that reads a row, computes for a while, and writes
the result back through the hook: without it, a concurrent write landing in
between is silently overwritten, last-write-wins.

- **Consulted only for a `mode: "upsert"` rule.** An `append` rule always
  creates a brand-new row, so there is no existing version an append delivery
  could be stale against; an `if_match` key in an append body is inert, the
  same as any other field the rule does not map. The very first delivery for
  a natural key, which has no existing row yet to match, also ignores it, for
  the same reason.
- **Absent `if_match` leaves the hook exactly as before: last-write-wins.**
  This is the default for every rule that never sends the field, and for
  every `append` rule regardless of what the body contains. Omitting it is
  not a regression, it is today's unchanged behaviour.
- **A match** lets the write land and the row's `version` increments, exactly
  like a matching PATCH.
- **A mismatch** refuses the write with a retryable `409 conflict` rather
  than acking `200`, so a compute-then-write-back backend learns
  synchronously, from the response, to re-read and retry rather than
  believing a stale write landed. The delivery is still journaled as a
  `failed` delivery, and every `failed` delivery releases its dedupe slot (see
  above), so a corrective retry that resends the SAME `dedupeKey` value
  reaches a real write attempt instead of being dropped as a duplicate of its
  own failed predecessor.
- **A present but malformed `if_match`** (anything other than a non-negative
  integer) is rejected as `invalid_request` and journaled `failed`, never
  silently ignored: an ignored typo would quietly reinstate the exact
  lost-update this field exists to close, with no signal that the guard never
  ran.

## Managing hooks and inspecting deliveries

Hooks have no create/delete verb of their own: add or remove one by editing
the manifest's `ingest` array and redeploying. Once deployed:

```sh
homespun ingest list --app <idOrSlug>
# -> { hooks: [{ name, url, collection, mode, wake, handshake, disabledAt,
#      createdAt, deliveries: { accepted, failed, dropped_duplicate } }] }

homespun ingest rotate --app <idOrSlug> --name stripe-payments
# mints a fresh URL secret; the old URL stops working immediately

homespun ingest signing-secret set --app <idOrSlug> --name gh-issues
homespun ingest signing-secret clear --app <idOrSlug> --name gh-issues
# manages the OPT-IN signature secret a `verify` rule requires; fail-closed
# (401 on every delivery) until this is set for that hook

homespun ingest backfill --app <idOrSlug> --name gh-issues --file bodies.json
# bulk-loads historical raw provider bodies through the hook's mapping,
# writing rows identical to a live delivery; see the dedupeKey note above
```

The delivery journal itself is read and replayed over the owner HTTP API, not
a CLI verb:

```
GET  /v1/apps/:id/ingest/deliveries?hook=<name>&status=<status>&limit=<n>
POST /v1/apps/:id/ingest/deliveries/:deliveryId/replay
```

A replay re-runs the stored payload through the CURRENT manifest rule (so
fixing a `map` and redeploying, then replaying a `failed` delivery, is the
normal debugging loop), and it bypasses dedupe entirely: the owner asked for
this exact payload to run again, so an `append` rule can produce a duplicate
row on replay even where the original dedupeKey would have caught a live
redelivery.
