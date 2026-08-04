// Compose the MCP-flavoured Homespun guide from the shared conceptual core +
// the MCP invocation layer.
//
// Single source of truth: the conceptual core lives in skills/homespun/SKILL.md
// between `<!-- homespun:core:start -->` / `<!-- homespun:core:end -->` markers (the
// CLI invocation grammar lives OUTSIDE those markers, so the CLI document and
// the MCP guide share the exact same prose for "when to deploy an app / the
// collection and change-feed data model / schema design / permissions / house
// style"). The
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
 * Build the full MCP guide: the MCP invocation layer, the shared conceptual
 * core extracted from SKILL.md, then every reference section appended in the
 * order given. `mcpInvocation` is the contents of skills/homespun/MCP-INVOCATION.md;
 * `skillMarkdown` is the contents of SKILL.md; `references` is the contents of
 * skills/homespun/references/*.md.
 *
 * The references are INLINED here rather than left behind a pointer, because an
 * MCP client has no filesystem to read them from and no `homespun skill show`
 * to fetch them with: the guide is the whole of what it gets. A file-based
 * agent reads SKILL.md's pointer and loads the same file on demand, so the two
 * transports carry the same content by different routes. That asymmetry is the
 * point: the pointer saves context only where the reader can act on it.
 */
export function composeMcpGuide(
  mcpInvocation: string,
  skillMarkdown: string,
  references: readonly string[] = [],
): string {
  const core = extractCore(skillMarkdown);
  const refs = references.map((r) => r.trim()).filter((r) => r.length > 0);
  const tail = refs.length > 0 ? `\n\n${refs.join("\n\n")}` : "";
  return `${mcpInvocation.trim()}\n\n${core}${tail}\n`;
}
