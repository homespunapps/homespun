<!-- homespun skill reference: notify-targets -->

# Notify targets: roles, relations, authorship and authorization

A reference section of the homespun skill. Read this before writing a `notify`
rule whose `to` names anything beyond `owner`, `members` or `submitter`. The
target grammar, the `channels` and `excludeActor` keys, and above all the
row-level authorization gate are not guessable, and getting the last one wrong
looks like a bug in the relay rather than in the manifest.

The trigger grammar (`on`, `collection`, `when`, `subject`, `body`) is the same
one documented in the main skill under "Email a person when a collection
changes". This file covers only the target grammar and what happens after a
target resolves to a principal.

**The full closed set of `to` values.** Each entry in `to` is one of:

- **`owner`**: the app's owner.
- **`members`**: the app's non-owner members.
- **`submitter`**: the row's own submitted address (see "Confirmation emails"
  in the main skill; unrelated to everything below, since it never resolves to
  an account).
- **`author`**: the principal who wrote the triggering row.
- **`creator`**: the principal who created the row, falling back to the author
  when the row carries no separate creator stamped (the same fallback the
  platform's own `creator` permission subject applies).
- **`role:<name>`**: every member currently holding the declared role
  `<name>`, including through that role's `includes` closure.
- **`field:<relationName>`**: the principal named by a declared relation on
  the rule's OWN collection, read off the triggering row.

A literal email address, or any string outside this list, is rejected at
deploy. The target grammar is closed for the same reason it always has been:
a manifest can never name an address, only a principal the platform already
knows.

## `role:<name>`

`role:<name>` targets everyone currently holding a role your manifest declares
under `x-homespun-manifest.roles`, expanded through `includes` exactly the way
a permission list expands it. `<name>` must be a role your manifest declares.
Naming a built-in subject this way (`role:owner`, `role:member`, `role:anyone`,
`role:author`, `role:creator`, `role:editor`, `role:agent`) is rejected at
deploy, since those already have direct targets or are not roles at all.

```json
"x-homespun-manifest": {
  "roles": {
    "reviewer": { "label": "Reviewer" }
  },
  "collections": {
    "submissions": {
      "read": ["owner", "reviewer"],
      "write": ["member"],
      "update": ["reviewer"],
      "delete": ["owner"]
    }
  },
  "notify": [
    {
      "on": "create",
      "collection": "submissions",
      "to": ["role:reviewer"],
      "subject": "New submission: {{title}}",
      "body": "{{title}} is waiting for review."
    }
  ]
}
```

Every member holding `reviewer`, directly or through another role's
`includes`, is a candidate recipient. Whether they actually receive the email
depends on the authorization gate below.

## `field:<relationName>`

`field:<relationName>` targets the principal named by one of the rule's OWN
collection's declared `relations`: the field says whose row this is, and the
notification follows that field. The relation must be declared on the SAME
collection the rule fires on. Naming a relation that belongs to a different
collection is rejected at deploy.

```json
"x-homespun-manifest": {
  "collections": {
    "tasks": {
      "relations": {
        "assignee": { "field": "assignedTo", "set": "writer" }
      },
      "read": ["assignee", "owner"],
      "write": ["owner"],
      "update": ["assignee", "owner"],
      "delete": ["owner"]
    }
  },
  "notify": [
    {
      "on": "update",
      "collection": "tasks",
      "to": ["field:assignee"],
      "subject": "Task updated: {{title}}",
      "body": "{{title}} changed. Current status: {{status}}."
    }
  ]
}
```

At delivery time the relay reads the row's `assignedTo` field and resolves the
bare id it holds against this app's own identity tables (members, visitors,
grant-link claims), never against another app's. Two failure modes both fail
closed rather than guessing:

- the id matches **nobody** in this app (a stale value, a typo, a value that
  was never a principal id at all): the target contributes no recipient.
- the id matches **more than one** identity kind in this app: the target
  contributes no recipient, and the ambiguity is logged for the operator.

`field:` is meaningless without a `relations` declaration on the collection.
See "Rows that belong to a person: `relations`" in the main skill for how to
declare one, including `set: "caller"` and the `immutable` freeze.

## `author` and `creator`

`author` targets whoever's write triggered the rule; `creator` targets whoever
created the row, falling back to the author when the row has no separate
creator stamped. Both resolve to a real, addressable principal only for a
human, a grant-link holder, or a visitor. A write stamped `agent`, `service`,
`hook`, `system` or `anon` contributes no recipient for these two targets, on
purpose: none of those is a person with an inbox, and upgrading one to "the
owner" would be a policy choice a manifest did not ask for. An app that wants
the owner told about its own agent's writes already has the `owner` target for
that.

## The authorization gate

**Every principal a target resolves to is checked against the SAME
`authorizeRead` path the data API uses, asked about the specific triggering
row.** A principal who could not `GET` that row through the ordinary read door
receives nothing, and the attempt is recorded as a suppressed delivery, not
silently dropped and not an error. This applies to every target form, `owner`
and `members` included, not only the new ones.

This is the single most important thing to get right when writing a `to` that
names a role or a relation, because it is the one place a rule "goes missing"
by design rather than by bug. Worked example: take the `submissions`
collection above, but scope it more tightly so a reviewer can only read the
submissions assigned to them, rather than every submission a reviewer can see:

```json
"submissions": {
  "relations": { "assignee": { "field": "assignedTo", "set": "writer" } },
  "read": ["owner", "reviewer:assignee"],
  "write": ["member"],
  "update": ["reviewer:assignee"],
  "delete": ["owner"]
}
```

paired with a rule that targets every reviewer, not just the assigned one:

```json
"notify": [
  {
    "on": "create",
    "collection": "submissions",
    "to": ["role:reviewer"],
    "subject": "New submission: {{title}}",
    "body": "{{title}} needs a reviewer."
  }
]
```

Every reviewer resolves as a candidate, but `read: ["owner", "reviewer:assignee"]`
only admits a reviewer on rows assigned to THEM. A reviewer not yet assigned to
this particular row fails the read check and is suppressed; only the owner and
the assigned reviewer (if any) actually receive mail. That is not a bug in the
rule, it is the collection's own read permission applied consistently. Target
whoever should be able to read the row, or widen the read permission, but do
not expect the notify rule to grant a visibility the collection itself denies.

## `channels`

`channels` names which transports carry the rule, defaulting to `["email"]`
when omitted. `"inapp"` and `"push"` parse as part of the grammar, but each is
rejected at deploy (error `notify_channel_not_enabled`) until the relay
operator enables it, the same shape as the `submitter` gate:
`NOTIFY_INAPP_ENABLED` and `NOTIFY_PUSH_ENABLED` each flip on independently,
and neither is enabled on the hosted relay today.

### `"inapp"`: the in-app notification store

Where `"email"` sends a message out of the platform, `"inapp"` stores one
inside it, for the recipient's own next visit. Every rule fires the same way
for both: the same targets, the same per-recipient authorization gate, one
render. A recipient the gate refuses gets no stored notification, exactly as
they get no mail.

```json
{
  "on": "update",
  "collection": "tasks",
  "when": { "field": "status", "changedTo": "review" },
  "to": ["field:assignee"],
  "channels": ["inapp"],
  "subject": "Ready for review: {{title}}",
  "body": "{{title}} is ready for your review."
}
```

Three things worth knowing before you reach for it:

- **It reaches people email cannot.** A grant-link holder and an anonymous
  visitor have no address on file, so an email-only rule targeting them
  resolves to a visible decline and nothing else. The in-app store is the
  channel that actually delivers to them, which is why it carries most of the
  value for a link-shared app.
- **It is not a collection.** The store is platform-owned: it never appears in
  your manifest or your schema, your app cannot write to it, and it is not
  readable through `/_hs/c/...`. It is read through its own routes, which
  exist only for an app that declared the channel:
  `GET /_hs/notifications` (the caller's own, newest first, with `?limit=`,
  `?unread=true` and `?before=<id>`), `GET /_hs/notifications/count` (their
  unread count), and `POST /_hs/notifications/read` (`{"ids": [...]}`, or an
  empty body to mark every unread one read).
- **Every read is scoped to the caller.** There is no parameter naming whose
  notifications to fetch: a caller sees, counts and marks read only the ones
  addressed to their own principal, and another principal's notification id
  simply matches nothing.

A live page also receives each notification as it arrives, on the socket it
already holds: a `{"type": "notification", "notification": {...}}` frame on
`/_hs/ws`, delivered only to the connections belonging to the recipient. It
carries the same object the HTTP routes return, so a page can apply both
through one code path.

### `"push"`: a web push notification on the device

Where `"inapp"` waits for the recipient's next visit, `"push"` reaches them
when the app is closed. It runs through exactly the same pipeline as the other
two: the same targets, the same per-recipient authorization gate, the same
visible suppression for a recipient the gate refuses.

```json
{
  "on": "update",
  "collection": "tasks",
  "when": { "field": "status", "changedTo": "review" },
  "to": ["field:assignee"],
  "channels": ["inapp", "push"],
  "link": "/reviews",
  "subject": "Ready for review: {{title}}",
  "body": "{{title}} is ready for your review."
}
```

Four things worth knowing before you reach for it:

- **What arrives on the device carries no row data.** It is the app's name, a
  line naming the collection that changed, and the rule's `link`. Not the
  rendered `subject`, not the rendered `body`. A push payload travels through
  Apple's, Google's or Mozilla's push service, and homespun authorizes
  notification content per recipient against the row that fired it, so handing
  that same content to a third party would undo the check. The recipient taps,
  your app opens, and your own reads serve the content. Use `link` to point
  them at the right screen and `GET /_hs/notifications` to tell them which row.
- **It needs `"offline": true`.** A push message is only ever delivered to a
  service worker, and the relay serves one only to an app that declares offline
  serving. A `push` channel on a manifest without it is a hard deploy error.
- **Nothing is sent until the viewer opts in, from your own UI.** The platform
  never prompts. Your page calls `homespun.push.enable()`, which is the one
  call in the whole SDK that shows a browser prompt, and you call it from a
  user gesture: a "notify me" toggle, a "watch this" button. A prompt the
  viewer denies blocks the origin permanently in most browsers, so an app gets
  one chance and it should be spent at a moment the viewer understands.
  `homespun.push.status()` reads where they stand without prompting, and
  `homespun.push.disable()` stops it.
- **iOS needs the app on the home screen first.** That is an Apple constraint
  with no way around it, which is why `"inapp"` carries most of the value for a
  link-shared app and push is the escalation.

## Letting a recipient say stop

Every recipient can mute any channel, per app, and your page is the only place
that control can live: much of an app's audience holds a grant link or is an
anonymous visitor, and neither has a console to visit, so there is no platform
settings page and no unsubscribe link to fall back on.

```js
const prefs = await homespun.notifications.preferences.get();
if (prefs?.notifiable) {
  emailToggle.checked = !prefs.muted.email;
  emailToggle.onchange = () =>
    homespun.notifications.preferences.set({
      channel: "email",
      muted: !emailToggle.checked,
    });
}
```

Four things worth knowing:

- **Nothing needs setting up.** A recipient who has never touched this is not
  muted, so notifications work before any preference exists. There is no
  default row to write and no opt-in step.
- **A mute is per app and per channel**, not per rule. Muting `"email"` still
  leaves that recipient's in-app notifications arriving, which is usually what
  someone means by "stop emailing me".
- **`get()` returns `null` when the app declares no notify channel**, because
  there is no such route for an app that sends nothing. `notifiable: false`
  means this particular viewer has no identity the relay can store a
  preference for: an anonymous visitor, whose only identity is a cookie the SDK
  transport deliberately does not send. Hide the control rather than render one
  whose write would fail. A signed-in member and a grant-link holder are both
  notifiable.
- **A muted channel leaves no trace.** Nothing is sent, nothing is stored, and
  no delivery record is written, which is different from the platform
  suppressing a notification because the recipient may not read the row that
  fired it.

## `link`

`link` is where the recipient's client should go: a static, same-origin path
starting with `/`, such as `"/orders"`. It is stored on every in-app
notification the rule creates and is the url a push notification opens.

It is deliberately **not** a template. `subject` and `body` accept `{{field}}`
placeholders; `link` refuses them as a deploy error, because the link is what
travels in a push payload and that payload must never contain row data. Point
it at a screen, not at a row, and let the app read `/_hs/notifications` (which
carries the `collection_name` and `row_key`) to work out which row to show.

## `excludeActor`

`excludeActor` decides whether the principal whose own write fired the rule is
dropped from the resolved audience before delivery. Its default depends on the
rule, not on a flat constant:

- **`false`** (nobody dropped) when every target is `owner`, `members` or
  `submitter`, and `channels` is the email-only default. An owner or member
  sees their own write in the digest exactly as any other recipient's write.
- **`true`** (the actor dropped) when any target is `author`, `creator`, a
  `role:` target, or a `field:` target, or `channels` names anything beyond
  email-only. Telling someone about their own action is rarely wanted from
  `to: ["author"]` or `to: ["role:reviewer"]` when the actor themselves holds
  `reviewer`, so the safer default applies whenever a rule reaches for one of
  these forms.

Set `excludeActor` explicitly to override either default: `false` on a
`role:`/`field:`/`author`/`creator` rule if you DO want the actor notified
about their own write, or `true` on an `owner`/`members`-only rule if you want
the owner excluded from their own digest.

## The open-relay invariant, restated

None of the above changes the one control every `notify` target has always
carried: a rule can never name an address. Every target here resolves to a
principal the platform already has an identity for (an account, a grant-link
claim, a visitor cookie), and email addressing happens only after resolution
and authorization, from that principal's own verified account email or its
per-visit address. A manifest cannot reach a stranger through `role:`,
`field:`, `author` or `creator` any more than it could through `owner` or
`members`.
