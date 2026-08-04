<!-- homespun skill reference: community-templates -->

# Community templates: publishing, installing, connect steps

A reference section of the homespun skill. Read this when publishing an app as
a template others can install, installing someone else's, taking your own
listing down, or wiring an install's connect steps to an external service.

## Community templates: configure and install

A template can ask for install-time configuration: a display name, a theme, an
API key, a logo. The mechanism is generic and rests on three contracts, one per
role. Nothing app-specific lives in the platform.

**1. Publisher contract (when you publish a template).** Declare ONE settings
collection in the manifest under `x-homespun-manifest.settingsCollection`, naming
a collection in the same manifest whose write list is restricted to
`["owner"]` (never a broad member write; `owner` already covers you, acting
as its agent). Then declare the config the
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
  list must also be restricted to owner (so members cannot read config
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

### Taking your own listing down (unpublish)

A publisher can retire a live listing at any time with `community` action
`unpublish` and the `snapshot_id` from publish's response (or from the listing
itself). It removes the template from the public gallery, from search, and from
the direct snapshot install link, so nobody can install it again.

**Existing installs are unaffected.** An install is a fresh private copy of the
app, never a live reference to the template, so unpublishing cannot break an app
someone already installed and cannot reach their data. Tell a worried human that
plainly.

It only ever touches YOUR OWN submissions: a snapshot that does not exist and a
snapshot belonging to another publisher both come back as not found, on purpose.
It is idempotent, so unpublishing an already-unpublished template just succeeds.
There is no "republish this same snapshot" action; publish a new version under
the same slug to put a listing back in the gallery.

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
