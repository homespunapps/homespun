<!-- homespun skill reference: embedding -->

# Embedding an app on someone else's site

A reference section of the homespun skill. Read this when an app declares
`x-homespun-manifest.embedAncestors`, so it will be framed on a site the app
does not control. The manifest key itself, the eligibility rules and the two
ways to hand over the markup are in the main skill; this file covers the
`homespun.embed` SDK namespace, which is the part an app has to actually call.

Nothing here applies to an app that is only ever opened at its own URL. The
whole namespace is inert on a top-level document, so calling into it without
first checking how the app is being viewed is safe.

## The problem this exists to solve

A framed app is cut off from two facts. It cannot see the page framing it,
because `Referrer-Policy` reduces `document.referrer` to a bare origin on this
path, so the framing page's path and query string, and every campaign parameter
on them, are not present in the framed document at all. And it cannot tell the
framing page anything, so the site owner's analytics never learn that a
submission happened.

**If you build an embedded form and do not use this namespace, the site owner
gets leads they cannot attribute and conversions they cannot measure.** That is
the normal reason someone embeds a form, so treat both halves below as part of
building an embeddable app, not as an extra.

## Reading the visitor's context

```js
await homespun.embed.ready;
const ctx = homespun.embed.context;   // null when not framed, or when the page did not answer
```

`homespun.embed.ready` is separate from `homespun.ready` and neither waits on
the other. It always resolves and never rejects. When the framing page is not
homespun-aware it resolves with `context` still `null` after about a second, so
an app that gates its first paint on it will not hang.

`context` has four fields:

| Field | What it is |
|---|---|
| `pageUrl` | Full URL of the framing page |
| `referrer` | The framing page's own referrer, not this document's |
| `params` | Campaign parameters from the framing page's query string |
| `custom` | Strings the embedder chose to pass |

`params` only ever carries `utm_source`, `utm_medium`, `utm_campaign`,
`utm_term`, `utm_content`, `gclid`, `fbclid` and `msclkid`. The rest of the
framing page's query string is never forwarded, because it routinely carries
session identifiers and search terms an app has no business receiving.

**Copy what you want onto your own row. Nothing is stored for you.**

```js
await homespun.embed.ready;
const ctx = homespun.embed.context;
await homespun.collections.leads.create({
  email: form.email.value,
  source: ctx?.params.utm_source ?? null,
  campaign: ctx?.params.utm_campaign ?? null,
  landedOn: ctx?.pageUrl ?? null,
});
```

That explicitness is the point: it is also what stops an embedder pushing keys
that collide with your real fields.

**Treat `context` as untrusted.** Every byte of it is chosen by whoever embedded
the app, which is not necessarily the same person who owns it. It is allowlisted
and length-capped before you see it, and an over-cap context is dropped whole
rather than trimmed, so a value that is present is complete. Never render it as
HTML and never branch a permission decision on it.

## Telling the page a submission happened

```js
homespun.embed.notifySubmitted({ id: leadId, value: 25, currency: "EUR" });
```

The framing page receives it as a `homespun:submitted` DOM event on the iframe
element, and fires its own analytics from there. Homespun does not ship any
tracking onto the embedder's page.

Three rules:

- **Call it yourself**, at the point you consider a conversion done. It does not
  fire automatically on insert, because apps write rows for reasons that are not
  conversions and firing on every write would both double-count and tell the
  embedder the shape of your writes.
- **Only `id`, `value` and `currency` are forwarded.** Everything else is
  dropped. Do not try to route submitted data to the embedder through it: the
  submitted lead belongs to the app owner, and the embedder is not always the
  same party.
- **It is a no-op when the app is not framed**, so it needs no guard.

## Checking whether the app is framed at all

```js
if (homespun.embed.framed) { /* hide your own site chrome, say */ }
```

Available synchronously, before `ready`. Use it for layout, not for security:
whether an app may be framed at all is decided by the manifest and enforced by
the browser, long before any of this code runs.

## Testing an embed

The `embedAncestors` origins are exact and admit no wildcards, so a preview
deployment on a per-commit hostname cannot be covered by one entry. Declare the
specific origins you will actually test from, and remember that changing them
means redeploying the manifest.
