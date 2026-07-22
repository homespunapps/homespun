// Compose the MCP-flavoured app guide from the shared conceptual core + the
// MCP invocation layer.
//
// Single source of truth: the conceptual core lives in skills/homespun/SKILL.md
// between `<!-- homespun:core:start -->` / `<!-- homespun:core:end -->` markers (the
// CLI invocation grammar lives OUTSIDE those markers, so the CLI document and
// the MCP guide share the exact same prose for "when to use app / events vs
// records / schema design / house style / the round-trip mental model"). The
// MCP invocation layer (tool-call grammar) lives in skills/homespun/MCP-INVOCATION.md.
//
// The MCP guide = MCP-INVOCATION.md (with its trailing "the rest is the core"
// pointer) + every core block extracted from SKILL.md, in document order. No
// `homespun ...` command grammar leaks into it.
//
// This is pure string manipulation so both the relay (which reads the files at
// boot and serves the result) and any other consumer can share one
// implementation without dragging in I/O.

const CORE_START = "<!-- homespun:core:start -->";
const CORE_END = "<!-- homespun:core:end -->";

/**
 * Extract every `<!-- homespun:core:start -->…<!-- homespun:core:end -->` block from a
 * SKILL.md body, concatenated in document order (markers removed). Returns the
 * transport-agnostic conceptual core with no CLI command grammar.
 */
export function extractCore(skillMarkdown: string): string {
  const blocks: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = skillMarkdown.indexOf(CORE_START, cursor);
    if (start === -1) break;
    const afterStart = start + CORE_START.length;
    const end = skillMarkdown.indexOf(CORE_END, afterStart);
    if (end === -1) break;
    blocks.push(skillMarkdown.slice(afterStart, end).trim());
    cursor = end + CORE_END.length;
  }
  return blocks.join("\n\n");
}

/**
 * Build the full MCP guide: the MCP invocation layer followed by the shared
 * conceptual core extracted from SKILL.md. `mcpInvocation` is the contents of
 * skills/homespun/MCP-INVOCATION.md; `skillMarkdown` is the contents of SKILL.md.
 */
export function composeMcpGuide(
  mcpInvocation: string,
  skillMarkdown: string,
): string {
  const core = extractCore(skillMarkdown);
  return `${mcpInvocation.trim()}\n\n${core}\n`;
}
