// The one sentence that turns a relay-side failure into a filed report.
//
// Both agent-facing surfaces attach this to errors that are homespun's fault:
// the MCP tool result (packages/mcp/src/tools.ts) and the CLI error envelope
// (packages/cli/src/output.ts). It lives here so the two cannot drift into
// saying different things about the same channel.
//
// Attached ONLY to 5xx, never to a 4xx. A 4xx is normally the caller's own bad
// argument, and prompting a report on those would bury the real signal under
// rows the operator has to triage and close. The deliberate exception is a
// misleading error message, which the guide's "do not file" list calls out as a
// documentation bug worth a `note`, and that one needs the agent's judgement, so
// no automatic hint can catch it.

export const RELAY_FAILURE_REPORT_HINT =
  "this failure is homespun's, not a bad argument. If it is not already in your feedback list, file it once as type `bug`, with the error code above, what you expected, and the arguments you passed.";
