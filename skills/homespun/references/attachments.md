<!-- homespun skill reference: attachments -->

# Attachments: binary uploads, presigned media, thumbnails

A reference section of the homespun skill. Read this when an app stores files:
images, PDFs, audio, video, or any data blob. Covers the agent-side
`homespun attachments` verbs, the presign / PUT / finalize path for real media,
and the on-demand thumbnail parameter.

The in-page upload path a visitor uses (`homespun.uploadBlob`, and the anonymous
upload capability) stays in the main skill under "Let your app's users upload a
file", because choosing the wrong one of those two costs tokens proportional to
the file size.

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
attachment whatever its visibility. **The read route is gated on the APP's
visibility, not per collection and not on a session:** a `public` or `link` app
serves its attachments to ANYONE, anonymous visitors included, and a `private`
app requires a signed-in owner/member session. So a public gallery needs no
capability token and no sign-in, and the thumbnail renders on the app's own page
just like the full image. The only thing without a width parameter is the
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
  disposition for the raster image.

**Metadata is stripped from the STORED ORIGINAL, not only from variants.** Every
image the relay can decode is re-encoded on upload with all metadata dropped:
EXIF, IPTC, XMP, the colour profile, and the embedded preview thumbnail. There is
no opt-out. Two consequences that point opposite ways, and you should raise
whichever applies before someone uploads anything:

- A photographer's copyright and IPTC credit fields do NOT survive upload. If
  provenance matters, keep it in the row's `data` alongside the attachment id,
  because the file itself will not carry it.
- Conversely, a visitor's phone photo arrives with its GPS coordinates already
  gone, so an app that accepts public uploads is not silently accumulating
  location data about the people who use it.

A type the relay cannot decode (a PDF, say) is stored byte-for-byte, metadata
included. SVG is always rasterised to PNG, which is also what removes any script
content it carried.

## Capability URLs: `/b/<token>`

An attachment is normally reached at `/_hs/attachments/<id>` on the app's own
origin, which is gated on the app's visibility (above). A **capability token**
is the way to hand out one attachment's bytes to a reader who is not on that
origin at all: an email, a webhook receiver, a third-party page. Mint one with
`POST /v1/attachments/:id/tokens` and the holder fetches `/b/<token>`, with no
API key and no session.

**Reach for it only when the visibility gate cannot answer.** A public or link
app already serves its attachments to anyone, so a gallery, a public menu image
or an avatar needs no token at all. Minting one there adds a secret to manage
for no benefit.

- **One token, one attachment.** A token is bound to a single attachment id;
  there is no bundle form.
- **It expires.** The default life is **30 days** for an app-scoped attachment
  and **24 hours** for an agent-scoped one. A `ttl_seconds` on the mint request
  may only SHORTEN that, never extend it, so you cannot mint a permanent URL.
- **`?w=` works on it**, so `/b/<token>?w=256` gets the same cached thumbnail
  the app's own origin would serve.
- **`once: true`** mints a single-use token that deletes itself atomically on
  the first successful fetch. Good for a one-time download link, useless for an
  `<img>` that may be re-requested.
- **Revoke with `DELETE /v1/attachments/:id/tokens/:token_id`**, which takes
  effect immediately and is idempotent. `GET /v1/attachments/:id/tokens` lists
  what is outstanding, which is the audit you want before assuming an old link
  is dead.

Treat a token URL as a bearer secret: anyone holding it reads those bytes until
it expires or is revoked. Do not put one in a row that a wider `read` list can
see, because that hands the capability to everyone who can read the row.
