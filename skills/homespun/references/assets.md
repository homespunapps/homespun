<!-- homespun skill reference: assets -->

# Shipping assets with your app

A reference section of the homespun skill. Read this when an app needs to ship
files alongside its HTML: images, fonts, audio, video, or data files served
from the app's own origin at a stable path.

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

## From the CLI: the `assets/` directory

A directory deploy ships everything under `<dir>/assets/` as this same bundle,
so the CLI needs no base64 in your hands and no separate upload step:

```
my-app/
  index.html        <- the document
  manifest.json     <- the manifest
  assets/
    logo.png        -> referenced by the page as assets/logo.png
    fonts/body.woff2 -> referenced as assets/fonts/body.woff2
```

```bash
homespun deploy ./my-app
```

The reference path keeps the `assets/` prefix, so what is on disk is what the
HTML writes. Nested directories are preserved and dot-prefixed entries
(`.DS_Store`, `.gitkeep`) are skipped.

Only `assets/` ships. Anything else next to `index.html` is left behind and
named on stderr, so a stray `node_modules/` or `package.json` is never
published. On a redeploy, a directory WITH an `assets/` folder sends the full
set on disk (deleting a file there removes it from the app), and a directory
WITHOUT one sends nothing, leaving a set uploaded through `deploy_app`
untouched.

**Scripts and stylesheets cannot be assets.** `.js`, `.css` and `.svg` are
refused by the CLI with a message saying why: they have no magic bytes, so they
would upload as `application/octet-stream` and be served
`Content-Disposition: attachment` with `nosniff`, meaning the browser downloads
them instead of running them and `<script src>` silently does nothing. The app
CSP allows `'unsafe-inline'` for both script and style, so inline them in
`index.html`.

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
