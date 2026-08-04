// `homespun deploy` — create or redeploy an App (spec-cli §3.1). This is the
// create->redeploy loop the v2 vision names: no `--app` creates a new App;
// `--app <id>` redeploys an existing one (compat-gated unless --force).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AppAsset } from "@homespunapps/core";
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
    if (!ASSET_PATH_CHARSET.test(`${ASSET_DIR}/${rel}`)) {
      fail(
        `cannot ship ${ASSET_DIR}/${rel} as an asset: an asset path may only contain A-Za-z0-9._/- , so rename the file (spaces and accented characters are the usual cause)`,
        "invalid_args",
      );
    }
    const ext = extensionOf(rel);
    if (NON_SERVABLE_EXTENSIONS.has(ext)) {
      fail(
        `cannot ship ${ASSET_DIR}/${rel} as an asset: the relay serves ${ext} files as an inert download (Content-Disposition: attachment, X-Content-Type-Options: nosniff), so a browser would refuse to execute or apply it. Inline scripts and styles in index.html instead: the app CSP allows them.`,
        "invalid_args",
      );
    }
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

  // Dry run (--check): validate + report what a real deploy would do, persist
  // NOTHING. Runs for both create (no --app) and redeploy (--app), the latter
  // reporting the compat gate. slug/visibility are not part of a dry run.
  if (check) {
    try {
      const id =
        appId !== undefined ? await resolveAppId(client, appId) : undefined;
      const result = await client.checkDeploy({
        ...(id !== undefined ? { app_id: id } : {}),
        ...(bundle.html !== undefined ? { html: bundle.html } : {}),
        ...(bundle.manifest !== undefined ? { manifest: bundle.manifest } : {}),
        ...(bundle.assets !== undefined ? { assets: bundle.assets } : {}),
        ...(force ? { force } : {}),
      });
      printJson(result);
    } catch (e) {
      failFromError(e);
    }
    return;
  }

  if (appId === undefined) {
    // Create. Client-side mirror of the relay's slug_not_allowed_for_link —
    // fail fast rather than round-trip a request that will 400 (spec-cli §3.1).
    if (slug !== undefined && visibility === "link") {
      fail(
        "a caller-supplied --slug is not allowed with visibility 'link' (link slugs are always server-generated); drop --visibility link, or omit --slug",
        "invalid_args",
      );
    }
    try {
      // readBundle guarantees both halves on the create path (a create can
      // inherit nothing), so the non-null assertions are the type system
      // catching up with a check that already ran.
      const out = await client.deployApp({
        html: bundle.html!,
        manifest: bundle.manifest,
        visibility,
        slug,
        ...(bundle.assets !== undefined ? { assets: bundle.assets } : {}),
      });
      printJson(out);
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
    // Only what this invocation actually read is sent: an omitted html,
    // manifest or asset set keeps what is live, so
    // `homespun deploy ./index.html --app <id>` ships the document alone and
    // `--manifest` with no file ships the manifest alone. A directory WITH an
    // `assets/` folder always sends the full computed set, so deleting a file
    // on disk removes it from the app; a directory WITHOUT one sends nothing,
    // leaving assets uploaded by another path (MCP `deploy_app`) untouched.
    const redeployed = await client.redeployApp(id, {
      ...(bundle.html !== undefined ? { html: bundle.html } : {}),
      ...(bundle.manifest !== undefined ? { manifest: bundle.manifest } : {}),
      ...(bundle.assets !== undefined ? { assets: bundle.assets } : {}),
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
  } catch (e) {
    failFromError(e);
  }
}
