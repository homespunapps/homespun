// `homespun deploy` — create or redeploy an App (spec-cli §3.1). This is the
// create->redeploy loop the v2 vision names: no `--app` creates a new App;
// `--app <id>` redeploys an existing one (compat-gated unless --force).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeClient } from "../config.js";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveJson } from "../input.js";
import { resolveAppId } from "../resolve-app.js";

interface DeployBundle {
  html: string;
  manifest: unknown;
}

function readBundle(
  source: string,
  manifestFlag: string | undefined,
): DeployBundle {
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
    return {
      html: readFileSync(htmlPath, "utf8"),
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
    };
  }
  // Single-file escape hatch.
  if (manifestFlag === undefined) {
    fail("single-file deploy requires --manifest <path|json>", "invalid_args");
  }
  return {
    html: readFileSync(source, "utf8"),
    manifest: resolveJson(manifestFlag!, "--manifest"),
  };
}

export async function runDeploy(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("deploy"));

  const source = args.positionals[0];
  if (!source) {
    fail("usage: homespun deploy <dir|file> [--app <id>] ...", "invalid_args");
  }

  const appId = args.flags.get("app");
  const slug = args.flags.get("slug");
  const visibility = args.flags.get("visibility") as
    | "private"
    | "link"
    | "public"
    | undefined;
  if (
    visibility !== undefined &&
    !["private", "link", "public"].includes(visibility)
  ) {
    fail("--visibility must be private|link|public", "invalid_args");
  }
  const force = args.bools.has("force");
  const check = args.bools.has("check");

  const bundle = readBundle(source!, args.flags.get("manifest"));
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
        html: bundle.html,
        manifest: bundle.manifest,
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
      const out = await client.deployApp({
        html: bundle.html,
        manifest: bundle.manifest,
        visibility,
        slug,
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
    const redeployed = await client.redeployApp(id, {
      html: bundle.html,
      manifest: bundle.manifest,
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
