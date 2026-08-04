<!-- homespun skill reference: webhooks -->

# Webhooks, stored credentials and OAuth2

A reference section of the homespun skill. Read this when an app must push its
row changes to another system: Slack, a CRM, Zapier, another agent. Everything
here is optional; an app that only stores data and emails people never needs it.

The trigger grammar (`on`, `collection`, `when`) is the same one `notify` uses
and is documented in the main skill under "Email a person when a collection
changes". This file covers only what is specific to sending to a machine.

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

Three details a receiver implementation gets wrong if it has to guess them:

- **The secret is the HMAC key VERBATIM, `whsec_` prefix included.** The prefix
  is part of the key, not a display convention, so stripping it makes every
  signature fail to verify. Use exactly the string the deploy response gave you.
- **`v1` is lower-case hex, 64 characters** (SHA-256). Compare by hex-decoding
  both sides and doing a constant-time compare of the raw bytes, which is
  case-insensitive by construction and avoids a length-dependent string compare.
- **The raw body must be captured before any JSON parsing.** Re-serialising a
  parsed object changes whitespace and key order, and the HMAC is over the bytes
  as sent. In Express that means a raw-body parser on this route rather than
  `express.json()`.

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

**Retries, and what is NOT guaranteed.** A failed attempt (a non-2xx, a network
error, or a 3xx, since a redirect is never followed) is retried with exponential
backoff: 30 seconds doubling to a one-hour ceiling, up to `WEBHOOKS_MAX_ATTEMPTS`
sends (default **6**), after which the delivery is marked `failed` and is not
retried again. **Ordering is not guaranteed.** A delivery that fails and backs
off arrives after deliveries created later, so a receiver that cares about order
must sort on the envelope's `feed_seq` (the ordered feed position) rather than
trusting arrival order. There is no documented rotation procedure for the signing
secret; treat it as fixed for the life of the app.

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

## A target the installer supplies: `urlFromSetting`

Instead of `url`, a rule may name **`urlFromSetting`**: the name of a top-level
string field of the app's declared `settingsCollection`, read at **fire time** to
get the actual target. Exactly one of `url` / `urlFromSetting` per rule.

```json
"webhooks": [
  { "on": "create", "collection": "orders", "urlFromSetting": "fulfilmentUrl" }
]
```

It exists for **templates**, and for those it is not optional: a webhook rule
carrying a hardcoded `url` **cannot be published to the community store** (the
publish gate refuses it, naming the collection), because the publisher's own
endpoint would otherwise be baked into every install. `urlFromSetting` lets each
installer supply their own through the app's install-time config.

Two consequences worth designing for:

- It **requires `x-homespun-manifest.settingsCollection`** to be declared. This
  is easy to remember as a template-only concern and then forget when you add a
  rule to an ordinary app.
- It **fails closed at fire time**, never silently sends somewhere wrong. If the
  config row is missing, the field is unset or not a string, or the value is not
  a structurally valid target (https, no userinfo, no IP literal), the delivery
  fails with an error naming which of those it was, and nothing is sent.

## A schedule that fires a webhook

A `schedules[]` rule fires on a **date** rather than on a change, and it can
deliver to a machine instead of a person. Swap the email keys for the webhook
keys and everything else about the rule stays as documented in the main skill:

```json
"schedules": [
  {
    "collection": "listings",
    "dateField": "expiresOn",
    "offsetDays": 0,
    "when": { "field": "status", "equals": "live" },
    "url": "https://api.example.com/hooks/expire"
  }
]
```

**A rule fires exactly one action.** `to` (email) or `url`/`urlFromSetting`
(webhook), never both and never neither, enforced at deploy:

- both: `a schedule rule fires exactly one action - provide 'to' (email) or
  'url'/'urlFromSetting' (webhook), not both`
- neither: `a schedule rule requires an action - 'to' (email) or
  'url'/'urlFromSetting' (webhook)`
- and the keys of the unused shape are refused individually, so `subject`
  beside a `url` is rejected as an email-only key rather than ignored.

**Everything about delivery is the same code as a `webhooks[]` rule**, not a
parallel implementation: the same URL and `bodyTemplate` validation (with the
same error text), the same HMAC signing and `X-Homespun-Signature` header, the
same SSRF re-resolution, the same `connection` host-binding, the same retry
schedule and attempt cap, and the same `X-Homespun-Delivery` idempotency key. A
receiver verifies a scheduled delivery exactly as it verifies any other.

Four differences, all upstream of delivery:

- **There is no `on` key.** The trigger is `dateField + offsetDays` landing on
  today, scanned once per app per local day.
- **`when` is level-only.** The `changedTo` edge form is rejected at deploy: a
  dated scan has no before-state to compare against.
- **The envelope carries `"op": "schedule"` and `"feed_seq": null`**, because no
  row mutation triggered it. A receiver that switches on `op`, or that assumes
  `feed_seq` is always a number, needs to handle both.
- **Retargeting a rule's URL lets an already-fired date fire again.** A rule's
  identity is hashed from its fields including `url` / `urlFromSetting` /
  `bodyTemplate`, so changing the target mints a new rule as far as the
  once-per-date guarantee is concerned, and rows that already fired under the old
  target will fire once more under the new one.

**Caps are separate budgets, and there are three of them.** A per-app rule-count
cap (`SCHEDULES_MAX_RULES`, default 10) covers all `schedules[]` rules of both
kinds. A per-app per-day *enqueue* cap applies **per action kind**
(`SCHEDULES_MAX_WEBHOOKS_PER_APP_DAY` and `SCHEDULES_MAX_EMAILS_PER_APP_DAY`,
both default 20), so an app cannot spend one kind's budget on the other. Then the
ordinary per-app hourly *send* cap (`WEBHOOKS_APP_HOURLY_CAP`, default 500)
applies to the resulting deliveries, shared with your `webhooks[]` traffic. The
webhook action is gated on `WEBHOOKS_ENABLED` independently of `NOTIFY_ENABLED`,
so a webhook-only app does not need the email path switched on at all.
