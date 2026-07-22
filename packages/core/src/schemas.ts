// Zod schemas for the Homespun relay request shapes. These let callers (the CLI,
// other clients) validate user-supplied input before it hits the relay,
// producing clear errors.
//
// The legacy v1 request schemas (create / list / upgrade / update /
// mint-participant, plus their inline + reference template forms) were removed
// when the v1 data model was dropped: they had no surviving HomespunClient
// method and no live relay route. Only the feedback schema, still used by the
// CLI + MCP, remains.

import { z } from "zod";

// POST /v1/feedback — an agent submits a bug report, feature request, or note
// to the relay operator. Message is trimmed before length check so whitespace
// padding cannot bypass the 1..4000 cap.
export const feedbackTypeSchema = z.enum(["bug", "feature", "note"]);

export const submitFeedbackSchema = z.object({
  type: feedbackTypeSchema,
  message: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(4000)),
  // App-scoped (v2): optionally attach the feedback to an App the caller can
  // access.
  app_id: z.string().min(1).optional(),
});
