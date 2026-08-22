// `homespun connections` (#1363) webhook-connection management for a v2 app:
// create a static or oauth2 connection, list an app's connections (metadata
// plus a fingerprint, never a secret), delete one, print the browser URL
// that completes an oauth2 connection's owner consent, and read or replay the
// outbound delivery journal (#1720) so an agent can debug its own webhooks
// without hand-rolling HTTP. Every verb targets an
// app via a required `--app <idOrSlug>` flag, resolved the same way
// `homespun grants`/`homespun members`/`homespun data` do (resolveAppId).
//
// Auth on the relay side is owner-or-owning-agent; this CLI always
// authenticates as the owning agent. There is no update verb: change a
// connection by deleting and recreating it (matching the HTTP API).
//
// OAuth2 consent is inherently a human-in-a-browser step: the relay refuses
// an agent-key caller at `/connections/:name/authorize`. `authorize-url`
// therefore never makes a network call: it builds the URL locally and hands
// it back so you can pass it to the signed-in app owner to open.

import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { nounSpec, renderNounHelp, specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { fail, failFromError, printJson } from "../output.js";
import { resolveAppId } from "../resolve-app.js";
import { resolveSecretFlag } from "../input.js";

export async function runConnection(args: ParsedArgs): Promise<void> {
  const verb = args.positionals[0];
  if ((verb === undefined || verb === "help") && args.bools.has("help")) {
    process.stdout.write(renderNounHelp(nounSpec("connections")!) + "\n");
    return;
  }
  if (verb === undefined) {
    fail(
      "missing verb: homespun connections <create|list|delete|authorize-url|deliveries|replay>",
      "invalid_args",
    );
  }

  const sub: ParsedArgs = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
    bools: args.bools,
    ...(args.danglingValueFlags !== undefined
      ? { danglingValueFlags: args.danglingValueFlags }
      : {}),
  };

  switch (verb) {
    case "create":
      return runCreate(sub);
    case "list":
      return runList(sub);
    case "delete":
      return runDelete(sub);
    case "authorize-url":
      return runAuthorizeUrl(sub);
    case "deliveries":
      return runDeliveries(sub);
    case "replay":
      return runReplay(sub);
    default:
      fail(
        `unknown verb '${verb}' (homespun connections <create|list|delete|authorize-url|deliveries|replay>)`,
        "invalid_args",
      );
  }
}

// Parse a "key=value" list, one per --param flag repetition is not supported
// by this parser (each flag is single-valued), so extra params travel as a
// JSON object flag, mirroring `homespun grants mint --pin-where <json>`.
function parseJsonObjectFlag(
  raw: string | undefined,
  flag: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`${flag} must be a JSON object`, "invalid_args");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`${flag} must be a JSON object`, "invalid_args");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

async function runCreate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("connections", "create"));
  const appArg = args.flags.get("app");
  const name = args.flags.get("name");
  const allowedHost = args.flags.get("allowed-host");
  if (!appArg || !name || !allowedHost) {
    fail(
      "usage: homespun connections create --app <idOrSlug> --name <name> --allowed-host <host> [...]",
      "invalid_args",
    );
  }
  const kind = args.flags.get("kind");
  if (kind !== undefined && kind !== "static" && kind !== "oauth2") {
    fail('--kind must be "static" or "oauth2"', "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    if ((kind ?? "static") === "oauth2") {
      const authorizeUrl = args.flags.get("authorize-url");
      const tokenEndpoint = args.flags.get("token-url");
      const clientId = args.flags.get("client-id");
      const clientSecret = await resolveSecretFlag(
        args.flags.get("client-secret"),
        "HOMESPUN_CONNECTION_CLIENT_SECRET",
        "--client-secret",
      );
      if (!authorizeUrl || !tokenEndpoint || !clientId || !clientSecret) {
        fail(
          "kind=oauth2 requires --authorize-url, --token-url, --client-id and --client-secret",
          "invalid_args",
        );
      }
      printJson(
        await client.createConnection(appId, {
          name: name!,
          kind: "oauth2",
          allowedHost: allowedHost!,
          authorizeUrl: authorizeUrl!,
          tokenEndpoint: tokenEndpoint!,
          clientId: clientId!,
          clientSecret: clientSecret!,
          ...(args.flags.get("provider") !== undefined
            ? { provider: args.flags.get("provider")! }
            : {}),
          ...(args.flags.get("label") !== undefined
            ? { label: args.flags.get("label")! }
            : {}),
          ...(args.flags.get("scopes") !== undefined
            ? { scopes: args.flags.get("scopes")! }
            : {}),
          ...(args.flags.get("auth-scheme") !== undefined
            ? { authScheme: args.flags.get("auth-scheme")! }
            : {}),
          ...(args.flags.get("instance-field") !== undefined
            ? { instanceField: args.flags.get("instance-field")! }
            : {}),
          ...((): { authParams?: Record<string, unknown> } => {
            const v = parseJsonObjectFlag(
              args.flags.get("auth-params"),
              "--auth-params",
            );
            return v !== undefined ? { authParams: v } : {};
          })(),
          ...((): { tokenParams?: Record<string, unknown> } => {
            const v = parseJsonObjectFlag(
              args.flags.get("token-params"),
              "--token-params",
            );
            return v !== undefined ? { tokenParams: v } : {};
          })(),
        }),
      );
      return;
    }
    const headerValue = await resolveSecretFlag(
      args.flags.get("header-value"),
      "HOMESPUN_CONNECTION_HEADER_VALUE",
      "--header-value",
    );
    if (!headerValue) {
      fail(
        "--header-value is required for a static connection",
        "invalid_args",
      );
    }
    printJson(
      await client.createConnection(appId, {
        name: name!,
        kind: "static",
        allowedHost: allowedHost!,
        headerValue: headerValue!,
        headerName: args.flags.get("header-name") ?? "Authorization",
        ...(args.flags.get("provider") !== undefined
          ? { provider: args.flags.get("provider")! }
          : {}),
        ...(args.flags.get("label") !== undefined
          ? { label: args.flags.get("label")! }
          : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

async function runList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("connections", "list"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail("usage: homespun connections list --app <idOrSlug>", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.listConnections(appId));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function runDelete(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("connections", "delete"));
  const appArg = args.flags.get("app");
  const name = args.flags.get("name");
  if (!appArg || !name) {
    fail(
      "usage: homespun connections delete --app <idOrSlug> --name <name>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    await client.deleteConnection(appId, name!);
    printJson({ deleted: true, app_id: appId, name: name! });
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// deliveries
// ---------------------------------------------------------------------------

async function runDeliveries(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("connections", "deliveries"));
  const appArg = args.flags.get("app");
  if (!appArg) {
    fail(
      "usage: homespun connections deliveries --app <idOrSlug> [--status <pending|delivered|failed>] [--collection <name>] [--limit <n>]",
      "invalid_args",
    );
  }
  const limitRaw = args.flags.get("limit");
  // Rejected here rather than passed through, so a typo'd --limit is an
  // argument error instead of a silent fallback to the server's default.
  if (limitRaw !== undefined && !/^[0-9]+$/.test(limitRaw)) {
    fail("--limit must be a whole number", "invalid_args");
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  const status = args.flags.get("status");
  const collection = args.flags.get("collection");
  try {
    printJson(
      await client.listWebhookDeliveries(appId, {
        ...(status !== undefined ? { status } : {}),
        ...(collection !== undefined ? { collection } : {}),
        ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {}),
      }),
    );
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

async function runReplay(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("connections", "replay"));
  const appArg = args.flags.get("app");
  const deliveryId = args.flags.get("delivery");
  if (!appArg || !deliveryId) {
    fail(
      "usage: homespun connections replay --app <idOrSlug> --delivery <deliveryId>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  try {
    printJson(await client.replayWebhookDelivery(appId, deliveryId!));
  } catch (e) {
    failFromError(e);
  }
}

// ---------------------------------------------------------------------------
// authorize-url
// ---------------------------------------------------------------------------

async function runAuthorizeUrl(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("connections", "authorize-url"));
  const appArg = args.flags.get("app");
  const name = args.flags.get("name");
  if (!appArg || !name) {
    fail(
      "usage: homespun connections authorize-url --app <idOrSlug> --name <name>",
      "invalid_args",
    );
  }
  const client = makeClient(args);
  const appId = await resolveAppId(client, appArg!);
  printJson({
    app_id: appId,
    name: name!,
    authorize_url: client.connectionAuthorizeUrl(appId, name!),
  });
}
