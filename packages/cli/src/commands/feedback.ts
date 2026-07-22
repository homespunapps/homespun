import type { FeedbackType } from "@homespunapps/core";
import type { ParsedArgs } from "../argv.js";
import { assertKnownFlags } from "../argv.js";
import { specFor } from "../help-catalog.js";
import { makeClient } from "../config.js";
import { printJson, fail, failFromError } from "../output.js";

const FEEDBACK_TYPES: readonly FeedbackType[] = ["bug", "feature", "note"];

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runFeedbackCreate(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("feedback", "create"));

  const type = args.flags.get("type");
  const rawMessage = args.flags.get("message");
  const appId = args.flags.get("app-id");

  if (type === undefined) {
    fail(
      "'homespun feedback create' requires --type <bug|feature|note>",
      "invalid_args",
    );
  }
  if (!FEEDBACK_TYPES.includes(type as FeedbackType)) {
    fail(
      `unknown --type '${type}' — expected one of: ${FEEDBACK_TYPES.join(", ")}`,
      "invalid_args",
    );
  }
  if (rawMessage === undefined) {
    fail(
      "'homespun feedback create' requires --message <text|-> (use '-' to read from stdin)",
      "invalid_args",
    );
  }

  let message: string;
  if (rawMessage === "-") {
    if (process.stdin.isTTY) {
      fail(
        "'homespun feedback create --message -' expects feedback on stdin, but stdin is a TTY",
        "invalid_args",
      );
    }
    message = await readStdin();
  } else {
    message = rawMessage;
  }

  if (message.trim().length === 0) {
    fail(
      "feedback message must not be empty or whitespace-only",
      "invalid_args",
    );
  }

  const client = makeClient(args);
  try {
    const res = await client.submitFeedback({
      type: type as FeedbackType,
      message,
      ...(appId !== undefined ? { appId } : {}),
    });
    printJson(res);
  } catch (e) {
    failFromError(e);
  }
}

async function runFeedbackList(args: ParsedArgs): Promise<void> {
  assertKnownFlags(args, ...specFor("feedback", "list"));

  const limitRaw = args.flags.get("limit");
  const before = args.flags.get("before");

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) {
      fail(
        `--limit must be a positive integer, got '${limitRaw}'`,
        "invalid_args",
      );
    }
    limit = n;
  }

  const client = makeClient(args);
  try {
    const page = await client.listFeedback({
      ...(limit !== undefined ? { limit } : {}),
      ...(before !== undefined ? { before } : {}),
    });
    printJson(page);
  } catch (e) {
    failFromError(e);
  }
}

export async function runFeedback(args: ParsedArgs): Promise<void> {
  const sub = args.positionals[0];
  switch (sub) {
    case "create":
      await runFeedbackCreate(args);
      break;
    case "list":
      await runFeedbackList(args);
      break;
    case undefined:
      fail(
        "missing subcommand — usage: homespun feedback <create|list> (run 'homespun feedback --help')",
        "invalid_args",
      );
      break;
    default:
      fail(
        `unknown feedback subcommand '${sub}' — expected create|list (run 'homespun feedback --help')`,
        "invalid_args",
      );
  }
}
