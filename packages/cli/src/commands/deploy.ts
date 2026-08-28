// `homespun deploy` — create or redeploy an App (spec-cli §3.1). This is the
// create->redeploy loop the v2 vision names: no `--app` creates a new App;
// `--app <id>` redeploys an existing one (compat-gated unless --force).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  HomespunApiError,
  putPresigned,
  type AppAsset,
  type HomespunClient,
  type MissingConnection,
} from "@homespunapps/core";
import { makeClient } from "../config.js";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { fail, failFromError, printJson, warn } from "../output.js";
import { resolveJson } from "../input.js";
import { resolveAppId } from "../resolve-app.js";

// What this invocation is shipping. On a REDEPLOY any part may be absent, and
// absent means "keep what is live" (issue #1272), so all are optional here; the
// create path checks that it has html + manifest before it calls the relay.
interface DeployBundle {
  html?: string;
  manifest?: unknown;
  assets?: AppAsset[];
}

// The subdirectory a directory deploy ships as the relay's multi-file `assets[]`
// bundle (issue #1225). Deliberately an EXPLICIT directory rather than "every
// file next to index.html": a whole-directory walk would sweep up node_modules,
// .git, package.json, lockfiles and source, burn the 50-asset cap on them, and
// publish source to an origin the whole world can read. `assets/` cannot be
// triggered by accident.
const ASSET_DIR = "assets";

// The reference path KEEPS the `assets/` prefix, so a file at
// `<dir>/assets/fonts/inter.woff2` is referenced by the page as
// `assets/fonts/inter.woff2`. What is on disk is what the HTML writes; no
// prefix-stripping to reason about.

// Client-side mirrors of the relay's deploy caps (MAX_APP_ASSETS,
// MAX_BLOB_BYTES in the relay's config). Same pattern as the slug/visibility
// checks below: fail fast with a message naming the offending file rather than
// base64 the whole bundle and round-trip a request that will be rejected. The
// relay re-checks both and stays authoritative.
const MAX_ASSETS = 50;
const MAX_ASSET_BYTES = 5_000_000;

// The relay's asset-path charset (core/app-assets.ts ASSET_PATH_CHARSET).
// Excludes ':' , whitespace, '%', '\' and every control byte.
const ASSET_PATH_CHARSET = /^[A-Za-z0-9._/-]+$/;

// Extensions the relay cannot serve as executable subresources. These have no
// magic bytes, so they sniff to `application/octet-stream`, pass the upload
// allowlist, and are then served `Content-Disposition: attachment` with
// `X-Content-Type-Options: nosniff`, so the browser downloads them instead of
// running them, and `<script src>` / `<link rel=stylesheet>` silently does
// nothing. Uploading them would reproduce exactly the silent failure this
// change exists to remove, so refuse them here with an explanation.
const NON_SERVABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".svg",
  ".html",
  ".htm",
  ".xhtml",
]);

// Types the relay CANNOT sniff from magic bytes, where a declared `mime` is the
// only way the asset is stored as itself rather than as octet-stream. For
// everything else (images, fonts, audio, video, pdf) the mime is omitted
// deliberately: the relay sniffs the real type, and a declared type that
// disagrees with the bytes is rejected.
const DECLARED_MIME_BY_EXTENSION = new Map([
  [".txt", "text/plain"],
  [".csv", "text/csv"],
  [".md", "text/markdown"],
  [".json", "application/json"],
  [".zip", "application/zip"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [
    ".xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [
    ".pptx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
]);

/** Lowercase extension including the dot, or "" when there is none. */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Path-shape checks shared by every source of a relay asset path: the
 * relay's charset (ASSET_PATH_CHARSET) and the non-servable-extension
 * refusal. `readAssets` calls this for a directory-convention path; the
 * explicit `--asset` flag below calls the SAME function on its app-path half,
 * so `--asset` cannot smuggle a path shape the directory-convention bundle
 * would already reject (issue #1028). One definition rather than two that
 * could quietly drift apart.
 */
function checkAssetPathShape(path: string): void {
  if (!ASSET_PATH_CHARSET.test(path)) {
    fail(
      `cannot ship ${path} as an asset: an asset path may only contain A-Za-z0-9._/- , so rename the file (spaces and accented characters are the usual cause)`,
      "invalid_args",
    );
  }
  const ext = extensionOf(path);
  if (NON_SERVABLE_EXTENSIONS.has(ext)) {
    fail(
      `cannot ship ${path} as an asset: the relay serves ${ext} files as an inert download (Content-Disposition: attachment, X-Content-Type-Options: nosniff), so a browser would refuse to execute or apply it. Inline scripts and styles in index.html instead: the app CSP allows them.`,
      "invalid_args",
    );
  }
}

/**
 * Every file under `<dir>/assets/`, as paths relative to that directory,
 * depth-first and sorted so a deploy is byte-identical across machines.
 *
 * Dot-prefixed entries are skipped at every level: `.DS_Store`, `.gitkeep` and
 * editor droppings are never intended as assets, and the relay's path charset
 * would take them anyway, so skipping is the only way they do not silently
 * consume the asset budget.
 */
function walkAssetDir(assetRoot: string, rel: string, out: string[]): void {
  const entries = readdirSync(rel === "" ? assetRoot : join(assetRoot, rel), {
    withFileTypes: true,
  });
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith(".")) continue;
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      walkAssetDir(assetRoot, childRel, out);
    } else if (entry.isFile()) {
      out.push(childRel);
    }
    // Anything else (symlink, socket, fifo) is skipped: not a file we can read
    // bytes from with any confidence about what they are.
  }
}

/**
 * Read `<source>/assets/**` into the relay's `assets[]` bundle shape.
 *
 * Returns `undefined` when there is no `assets/` directory at all, which the
 * relay reads as "carry the live asset set forward" on a redeploy. That
 * distinction matters: a directory that never had an `assets/` folder must not
 * wipe assets an agent uploaded through the MCP `deploy_app` path. An `assets/`
 * directory that exists but is empty returns `[]`, the relay's explicit
 * "clear the assets".
 */
function readAssets(source: string): AppAsset[] | undefined {
  const assetRoot = join(source, ASSET_DIR);
  if (!existsSync(assetRoot) || !statSync(assetRoot).isDirectory()) {
    return undefined;
  }
  const relPaths: string[] = [];
  walkAssetDir(assetRoot, "", relPaths);

  if (relPaths.length > MAX_ASSETS) {
    fail(
      `too many assets: ${ASSET_DIR}/ holds ${relPaths.length} files, the limit is ${MAX_ASSETS} per deploy`,
      "invalid_args",
    );
  }

  return relPaths.map((rel) => {
    // Mirror of the relay's validateAssetPath charset. A space or an accent in
    // a filename is the common case here, and both are ordinary on disk, so
    // catching it locally turns a server round-trip into an immediate message
    // naming the file. The relay re-validates and stays authoritative.
    checkAssetPathShape(`${ASSET_DIR}/${rel}`);
    const ext = extensionOf(rel);
    const bytes = readFileSync(join(assetRoot, rel));
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      fail(
        `asset ${ASSET_DIR}/${rel} is ${bytes.byteLength} bytes, over the ${MAX_ASSET_BYTES}-byte per-file limit`,
        "invalid_args",
      );
    }
    const mime = DECLARED_MIME_BY_EXTENSION.get(ext);
    return {
      path: `${ASSET_DIR}/${rel}`,
      content_base64: bytes.toString("base64"),
      ...(mime !== undefined ? { mime } : {}),
    };
  });
}

// -----------------------------------------------------------------------
// The explicit `--asset <local>=<app-path>` flag (issue #1028): for a file
// that does not live under `assets/`, or that is too big to inline.
//
//   - small (under ASSET_PRESIGN_THRESHOLD_BYTES): inlined exactly like a
//     directory-convention asset, base64 in the deploy body.
//   - large (at or over ASSET_PRESIGN_THRESHOLD_BYTES): shipped by
//     reference, via presignBlob, a PUT of the bytes straight to storage,
//     then confirmBlob, so the deploy body never carries them. Falls back to
//     inlining when the relay's presign route answers not_implemented (the
//     filesystem backend doesn't ship it), as long as the bytes still fit
//     the MAX_ASSET_BYTES inline cap; a file over that cap with no working
//     presign route simply cannot ship, and fails naming it rather than
//     silently doing nothing.
//
// 1 MB is HomespunClient.uploadBlob's own documented cutoff for reaching for
// presignBlob() + confirmBlob() over the multipart fallback (see the doc
// comment above uploadBlob in packages/core/src/client.ts). Reusing that
// number here keeps the CLI's two "when is presign worth it" answers in
// sync, rather than inventing a second threshold that could drift from it.
const ASSET_PRESIGN_THRESHOLD_BYTES = 1_000_000;

interface ExplicitAsset {
  /** The relay-side path this asset is served at (leading '/' stripped). */
  path: string;
  /** The local disk path the caller gave, kept for error messages only. */
  localPath: string;
  bytes: Buffer;
}

/**
 * Split one `--asset` value into its local and app-path halves. The expected
 * shape is `<local>=<app-path>`; anything else (no '=', or an empty half)
 * fails with a message showing the expected form, not a generic parse error.
 */
function parseAssetFlagValue(raw: string): { local: string; appPath: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0 || eq === raw.length - 1) {
    fail(
      `malformed --asset value ${JSON.stringify(raw)}: expected the form <local>=<app-path>, for example --asset ./logo.png=logo.png`,
      "invalid_args",
    );
  }
  return { local: raw.slice(0, eq), appPath: raw.slice(eq + 1) };
}

/**
 * Read one `--asset`'s local file. Every failure names the path: the relay
 * cannot help diagnose this half of a deploy, since it never sees the local
 * filesystem, so a missing or unreadable file must not surface as an opaque
 * stack trace or a wasted round trip.
 */
function readExplicitAssetBytes(localPath: string): Buffer {
  if (!existsSync(localPath)) {
    fail(`--asset local file not found: ${localPath}`, "invalid_args");
  }
  let isFile: boolean;
  try {
    isFile = statSync(localPath).isFile();
  } catch (e) {
    fail(
      `--asset local file is not readable: ${localPath} (${(e as Error).message})`,
      "invalid_args",
    );
  }
  if (!isFile) {
    fail(
      `--asset local path is not a regular file: ${localPath}`,
      "invalid_args",
    );
  }
  try {
    return readFileSync(localPath);
  } catch (e) {
    fail(
      `--asset local file is not readable: ${localPath} (${(e as Error).message})`,
      "invalid_args",
    );
  }
}

/**
 * Parse and validate every `--asset` flag into its final relay path plus
 * bytes.
 *
 * A leading '/' on the app-path half is stripped: `--asset ./logo.png=/logo.png`
 * and `--asset ./logo.png=logo.png` mean the same app-root file. Every
 * relay-side asset path is relative (core/app-assets.ts's validateAssetPath
 * rejects a leading '/' outright), so stripping it here is the only way the
 * form a caller reaches for first (a URL-shaped root path) doesn't round-trip
 * to a relay error. What remains is checked with checkAssetPathShape, the
 * SAME function readAssets uses, so `--asset` cannot smuggle a path shape the
 * directory-convention bundle would already reject.
 *
 * A repeated app-path keeps the LAST occurrence, matching how the merge into
 * directory assets below treats an explicit path as authoritative.
 */
function collectExplicitAssets(rawValues: string[]): ExplicitAsset[] {
  const byPath = new Map<string, ExplicitAsset>();
  for (const raw of rawValues) {
    const { local, appPath } = parseAssetFlagValue(raw);
    const path = appPath.startsWith("/") ? appPath.slice(1) : appPath;
    checkAssetPathShape(path);
    const bytes = readExplicitAssetBytes(local);
    byPath.set(path, { path, localPath: local, bytes });
  }
  return [...byPath.values()];
}

/** The relay's declared mime for a path's extension, or undefined to let the relay sniff it. */
function declaredMimeFor(path: string): string | undefined {
  return DECLARED_MIME_BY_EXTENSION.get(extensionOf(path));
}

/**
 * Inline an explicit asset exactly like a directory-convention one: base64
 * in the deploy body. Enforces the same MAX_ASSET_BYTES cap readAssets does,
 * naming the LOCAL path (what the caller typed) in the error rather than the
 * relay path.
 */
function inlineExplicitAsset(asset: ExplicitAsset): AppAsset {
  if (asset.bytes.byteLength > MAX_ASSET_BYTES) {
    fail(
      `--asset ${asset.localPath} is ${asset.bytes.byteLength} bytes, over the ${MAX_ASSET_BYTES}-byte inline limit, and this relay has no working presign route to ship it by reference instead`,
      "invalid_args",
    );
  }
  const mime = declaredMimeFor(asset.path);
  return {
    path: asset.path,
    content_base64: asset.bytes.toString("base64"),
    ...(mime !== undefined ? { mime } : {}),
  };
}

/**
 * Report connections the manifest references that the app does not have.
 *
 * Deploying a manifest DECLARES a connection name; it never creates the
 * connection, because its allowed host is the exfiltration defence and only an
 * owner may bind one. Without this the gap is invisible until someone uses the
 * feature and gets "no connection named X on this app", which reads like a bug
 * in the app rather than setup that was never done.
 *
 * STDERR, never stdout: stdout carries the JSON a caller pipes into `jq`.
 *
 * The printed command is a SUGGESTION built from the host the relay read out
 * of the manifest. It is shown with its provenance so the reader checks it
 * rather than pasting blind, and `--header-value -` makes the CLI prompt for
 * the credential instead of putting it in shell history.
 */
function reportMissingConnections(
  missing: readonly MissingConnection[] | undefined,
  appRef: string,
): void {
  if (!missing || missing.length === 0) return;
  for (const m of missing) {
    warn(
      `connection '${m.name}' is declared in the manifest but does not exist on this app; every call through it will fail`,
    );
    if (m.suggested_host) {
      process.stderr.write(
        `  the manifest points it at ${m.suggested_host}. If that is right:\n` +
          `    homespun connections create --app ${appRef} --name ${m.name} \\\n` +
          `      --allowed-host ${m.suggested_host} \\\n` +
          `      --kind static --header-name Authorization --header-value -\n`,
      );
    } else {
      // Rules disagreeing on a host, or resolving it from a setting at
      // delivery time. Printing one of several hosts would suggest a binding
      // that silently fails for the others, so name the host yourself.
      process.stderr.write(
        `  its rules do not agree on a single host, so choose the destination yourself:\n` +
          `    homespun connections create --app ${appRef} --name ${m.name} \\\n` +
          `      --allowed-host <host> \\\n` +
          `      --kind static --header-name Authorization --header-value -\n`,
      );
    }
  }
}

/** Split explicit assets by the presign threshold. A pure size check, no I/O. */
function partitionExplicitAssets(assets: ExplicitAsset[]): {
  small: ExplicitAsset[];
  large: ExplicitAsset[];
} {
  const small: ExplicitAsset[] = [];
  const large: ExplicitAsset[] = [];
  for (const asset of assets) {
    (asset.bytes.byteLength < ASSET_PRESIGN_THRESHOLD_BYTES
      ? small
      : large
    ).push(asset);
  }
  return { small, large };
}

/**
 * Resolve one "large" explicit asset to a by-reference AppAssetRef: presign
 * against `appId`, PUT the bytes straight to storage, then confirm. `appId`
 * must already be real; see the two-round-trip note on runDeploy for why a
 * brand-new app cannot presign on its FIRST deploy call, since the id does
 * not exist yet.
 *
 * Falls back to inlining the asset when the relay answers not_implemented
 * (the filesystem backend has no presign route), provided the bytes still
 * fit the inline cap; a genuinely large file with no working presign route
 * fails naming it, rather than silently shrinking the deploy's asset set.
 * Any other failure (a network error, a rejected PUT, a failed confirm) is
 * rethrown for the caller's own error handling.
 */
async function resolveLargeAsset(
  client: HomespunClient,
  appId: string,
  asset: ExplicitAsset,
): Promise<AppAsset> {
  const mime = declaredMimeFor(asset.path) ?? "application/octet-stream";
  const sha256 = createHash("sha256").update(asset.bytes).digest("hex");
  try {
    const presign = await client.presignBlob({
      mime,
      size: asset.bytes.byteLength,
      sha256,
      scope: "app",
      appId,
      filename: asset.path.split("/").pop(),
    });
    await putPresigned(presign.upload_url, asset.bytes, mime);
    await client.confirmBlob(presign.attachment_id);
    return { path: asset.path, attachment_id: presign.attachment_id };
  } catch (e) {
    if (e instanceof HomespunApiError && e.code === "not_implemented") {
      if (asset.bytes.byteLength > MAX_ASSET_BYTES) {
        fail(
          `cannot ship --asset ${asset.localPath} (${asset.bytes.byteLength} bytes): it is over the ${MAX_ASSET_BYTES}-byte inline cap, and this relay's presign route is not implemented (${e.message})`,
          "invalid_args",
        );
      }
      warn(
        `presigned upload is not available on this relay; shipping --asset ${asset.localPath} (${asset.bytes.byteLength} bytes) inline instead`,
      );
      return inlineExplicitAsset(asset);
    }
    throw e;
  }
}

/** Resolve every "large" explicit asset against `appId`, in order. */
async function resolveLargeAssets(
  client: HomespunClient,
  appId: string,
  assets: ExplicitAsset[],
): Promise<AppAsset[]> {
  const resolved: AppAsset[] = [];
  for (const asset of assets) {
    resolved.push(await resolveLargeAsset(client, appId, asset));
  }
  return resolved;
}

/**
 * Merge an explicit `--asset` list into a base asset array, the explicit
 * list winning on a path collision. A colliding path keeps its ORIGINAL
 * position in the merged array, so a directory-convention asset overridden
 * by `--asset` does not jump to the end; a new path is appended in
 * `--asset` order.
 */
function mergeAssets(base: AppAsset[], overrides: AppAsset[]): AppAsset[] {
  const merged = [...base];
  const indexByPath = new Map(merged.map((a, i) => [a.path, i]));
  for (const asset of overrides) {
    const idx = indexByPath.get(asset.path);
    if (idx !== undefined) {
      merged[idx] = asset;
    } else {
      indexByPath.set(asset.path, merged.length);
      merged.push(asset);
    }
  }
  return merged;
}

/**
 * Merge, but preserve "no assets/ directory and no --asset flags" as
 * `undefined`, the redeploy "keep the live set" signal (issue #1272),
 * rather than turning it into an empty array.
 */
function mergeAssetsMaybe(
  base: AppAsset[] | undefined,
  overrides: AppAsset[],
): AppAsset[] | undefined {
  if (overrides.length === 0) return base;
  return mergeAssets(base ?? [], overrides);
}

/**
 * Warn about files sitting next to `index.html` that this deploy is NOT
 * shipping. Silently dropping them is the failure mode issue #1225 is about:
 * the deploy succeeds, and the app 404s on a file the author can plainly see in
 * the directory.
 */
function warnAboutIgnoredFiles(source: string): void {
  const ignored = readdirSync(source, { withFileTypes: true })
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        e.name !== "index.html" &&
        e.name !== "manifest.json" &&
        !(e.isDirectory() && e.name === ASSET_DIR),
    )
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();
  if (ignored.length === 0) return;
  warn(
    `not deploying ${ignored.length} entr${ignored.length === 1 ? "y" : "ies"} in ${source}: ${ignored.join(", ")}. A directory deploy ships index.html, manifest.json and everything under ${ASSET_DIR}/. Move files you want served into ${ASSET_DIR}/.`,
  );
}

function readBundle(
  source: string | undefined,
  manifestFlag: string | undefined,
  isRedeploy: boolean,
): DeployBundle {
  // No source at all: only a redeploy can do this, and only to change the
  // manifest alone (the live document is inherited).
  if (source === undefined) {
    if (!isRedeploy) {
      fail(
        "usage: homespun deploy <dir|file> [--app <id>] ...",
        "invalid_args",
      );
    }
    if (manifestFlag === undefined) {
      fail(
        "nothing to deploy: pass a directory or file, or --manifest <path|json> for a manifest-only redeploy",
        "invalid_args",
      );
    }
    return { manifest: resolveJson(manifestFlag!, "--manifest") };
  }

  if (!existsSync(source)) {
    fail(`no such file or directory: ${source}`, "invalid_args");
  }
  const st = statSync(source);
  if (st.isDirectory()) {
    if (manifestFlag !== undefined) {
      fail(
        "--manifest is only for the single-file escape hatch — a directory deploy reads <dir>/manifest.json",
        "invalid_args",
      );
    }
    const htmlPath = join(source, "index.html");
    const manifestPath = join(source, "manifest.json");
    const missing: string[] = [];
    if (!existsSync(htmlPath)) missing.push("index.html");
    if (!existsSync(manifestPath)) missing.push("manifest.json");
    if (missing.length > 0) {
      fail(
        `directory deploy is missing required file(s): ${missing.join(", ")}`,
        "invalid_args",
      );
    }
    warnAboutIgnoredFiles(source);
    const assets = readAssets(source);
    return {
      html: readFileSync(htmlPath, "utf8"),
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
      ...(assets !== undefined ? { assets } : {}),
    };
  }
  // Single-file escape hatch. A create must pair it with --manifest; a
  // redeploy may omit --manifest, which keeps the live manifest.
  if (manifestFlag === undefined) {
    if (!isRedeploy) {
      fail(
        "single-file deploy requires --manifest <path|json>",
        "invalid_args",
      );
    }
    return { html: readFileSync(source, "utf8") };
  }
  return {
    html: readFileSync(source, "utf8"),
    manifest: resolveJson(manifestFlag!, "--manifest"),
  };
}

export async function runDeploy(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("deploy"));

  const source = args.positionals[0];
  const appId = args.flags.get("app");
  const slug = args.flags.get("slug");
  const visibility = args.flags.get("visibility") as
    "private" | "link" | "public" | undefined;
  if (
    visibility !== undefined &&
    !["private", "link", "public"].includes(visibility)
  ) {
    fail("--visibility must be private|link|public", "invalid_args");
  }
  const force = args.bools.has("force");
  const check = args.bools.has("check");

  const bundle = readBundle(
    source,
    args.flags.get("manifest"),
    appId !== undefined,
  );
  const client = makeClient(args);

  const explicitAssets = collectExplicitAssets(
    args.repeated?.get("asset") ?? [],
  );

  // Dry run (--check): validate + report what a real deploy would do, persist
  // NOTHING. Runs for both create (no --app) and redeploy (--app), the latter
  // reporting the compat gate. slug/visibility are not part of a dry run.
  //
  // Every explicit asset is inlined here regardless of size: presigning is a
  // real upload (presignBlob reserves storage, PUT writes bytes, confirmBlob
  // finalises it), and --check's contract is to persist nothing. A file too
  // big to inline fails the same way inlineExplicitAsset always fails one,
  // naming it, rather than pretending a dry run validated a transport it
  // never exercised.
  if (check) {
    const checkAssets = mergeAssetsMaybe(
      bundle.assets,
      explicitAssets.map(inlineExplicitAsset),
    );
    try {
      const id =
        appId !== undefined ? await resolveAppId(client, appId) : undefined;
      const result = await client.checkDeploy({
        ...(id !== undefined ? { app_id: id } : {}),
        ...(bundle.html !== undefined ? { html: bundle.html } : {}),
        ...(bundle.manifest !== undefined ? { manifest: bundle.manifest } : {}),
        ...(checkAssets !== undefined ? { assets: checkAssets } : {}),
        ...(force ? { force } : {}),
      });
      printJson(result);
      reportMissingConnections(result.missing_connections, appId ?? "<app>");
      // A check exists to be a gate, so it must not report success on a
      // manifest whose connections do not exist: every call through them
      // fails at runtime. Gated on the STRUCTURED field, never on the warning
      // prose, because a grep that stops matching fails open and a gate that
      // fails open is worse than no gate.
      if ((result.missing_connections?.length ?? 0) > 0) {
        process.exitCode = 1;
      }
    } catch (e) {
      failFromError(e);
    }
    return;
  }

  const { small, large } = partitionExplicitAssets(explicitAssets);

  if (appId === undefined) {
    // Create. Client-side mirror of the relay's slug_not_allowed_for_link —
    // fail fast rather than round-trip a request that will 400 (spec-cli §3.1).
    if (slug !== undefined && visibility === "link") {
      fail(
        "a caller-supplied --slug is not allowed with visibility 'link' (link slugs are always server-generated); drop --visibility link, or omit --slug",
        "invalid_args",
      );
    }
    // Any "large" explicit asset needs an app id to presign against (scope:
    // "app" is bound to a specific app at presign time, and there is no
    // rescope endpoint), and a brand-new app has no id until the FIRST
    // deploy call returns one. So a create carrying a large asset is a
    // two-round-trip: deploy without it, presign + PUT + confirm against the
    // real id the relay just minted, then redeploy carrying the reference.
    // An existing app (--app given, below) already has an id, so it stays a
    // single pass. Adding a rescope endpoint to collapse this to one round
    // trip was considered and rejected as disproportionate to the problem.
    const firstPassAssets = mergeAssetsMaybe(
      bundle.assets,
      small.map(inlineExplicitAsset),
    );
    try {
      // readBundle guarantees both halves on the create path (a create can
      // inherit nothing), so the non-null assertions are the type system
      // catching up with a check that already ran.
      const out = await client.deployApp({
        html: bundle.html!,
        manifest: bundle.manifest,
        visibility,
        slug,
        ...(firstPassAssets !== undefined ? { assets: firstPassAssets } : {}),
      });
      if (large.length === 0) {
        printJson(out);
        return;
      }
      const largeRefs = await resolveLargeAssets(client, out.app_id, large);
      const finalAssets = mergeAssets(firstPassAssets ?? [], largeRefs);
      const redeployed = await client.redeployApp(out.app_id, {
        assets: finalAssets,
        force: false,
      });
      const app = await client.getApp(out.app_id);
      printJson({
        app_id: out.app_id,
        slug: app.slug,
        url: app.url,
        version: redeployed.version,
        visibility: app.visibility,
        created: true,
        ...(out.share_url !== undefined ? { share_url: out.share_url } : {}),
        compat: redeployed.compat,
        ...(redeployed.breaks ? { breaks: redeployed.breaks } : {}),
        ...(redeployed.warnings ? { warnings: redeployed.warnings } : {}),
      });
      // A brand-new app has no connections at all, so this names every one the
      // manifest declares. That is the moment the advice is most useful.
      reportMissingConnections(redeployed.missing_connections, app.slug);
    } catch (e) {
      failFromError(e);
    }
    return;
  }

  // Redeploy. slug/visibility are immutable here.
  if (slug !== undefined) {
    fail(
      "--slug cannot be changed on redeploy (slug is immutable) — omit --app to create a new app instead",
      "invalid_args",
    );
  }
  if (visibility !== undefined) {
    fail(
      "--visibility cannot be changed on redeploy — use 'homespun apps update --visibility' instead",
      "invalid_args",
    );
  }
  const id = await resolveAppId(client, appId);
  try {
    // The app id already exists, so presigning any "large" explicit asset is
    // a single pass: resolve every explicit asset up front, merge into the
    // directory-convention bundle, then redeploy once.
    const smallInline = small.map(inlineExplicitAsset);
    const largeRefs =
      large.length > 0 ? await resolveLargeAssets(client, id, large) : [];
    const explicitResolved = [...smallInline, ...largeRefs];

    // Only what this invocation actually read is sent: an omitted html,
    // manifest or asset set keeps what is live, so
    // `homespun deploy ./index.html --app <id>` ships the document alone and
    // `--manifest` with no file ships the manifest alone. A directory WITH an
    // `assets/` folder always sends the full computed set, so deleting a file
    // on disk removes it from the app; a directory WITHOUT one, and no
    // `--asset` flags, sends nothing, leaving assets uploaded by another
    // path (MCP `deploy_app`) untouched.
    const finalAssets = mergeAssetsMaybe(bundle.assets, explicitResolved);
    const redeployed = await client.redeployApp(id, {
      ...(bundle.html !== undefined ? { html: bundle.html } : {}),
      ...(bundle.manifest !== undefined ? { manifest: bundle.manifest } : {}),
      ...(finalAssets !== undefined ? { assets: finalAssets } : {}),
      force,
    });
    const app = await client.getApp(id);
    printJson({
      app_id: redeployed.app_id,
      slug: app.slug,
      url: app.url,
      version: redeployed.version,
      visibility: app.visibility,
      created: false,
      compat: redeployed.compat,
      ...(redeployed.breaks ? { breaks: redeployed.breaks } : {}),
      ...(redeployed.warnings ? { warnings: redeployed.warnings } : {}),
    });
    reportMissingConnections(redeployed.missing_connections, app.slug);
  } catch (e) {
    failFromError(e);
  }
}
