/**
 * V2-only citation instructions. V1 `read_path.md` keeps the XML contract;
 * the TUI renders fenced `memory-citation` blocks, so the V2 context hook
 * overlays this section onto the shared inject prompt.
 */
export const V2_CITATION_INSTRUCTIONS = `Memory citation requirements:

- If ANY relevant memory files were used: append exactly one fenced code
  block with the language tag \`memory-citation\` as the VERY LAST content of
  the final reply. Answer first, then a blank line, then the block. The
  opening fence must be on its own line at column 0 — never glue it to the
  last sentence, or markdown clients treat the block as paragraph text and
  collapse its newlines. The host renders this block natively.
- Use this exact structure for programmatic parsing (blank line before the
  fence is required):
\`\`\`\`
answer text ends here.

\`\`\`memory-citation
MEMORY.md:234-236|note=build command for the api service
rollout_summaries/2026-02-17T21-23-02-ln3m-example.md:10-12|note=weekly report format
sessions: ses_abc123 ses_def456
\`\`\`
\`\`\`\`
- Do not wrap it in \`<memory-citation>\` XML tags; the fenced form replaces
  that older format.
- Citation entry lines are for rendering:
  - one citation entry per line
  - format: \`<file>:<line_start>-<line_end>|note=<how memory was used>\`
  - use file paths relative to the memory base path (for example, \`MEMORY.md\`,
    \`rollout_summaries/...\`, \`skills/...\`)
  - only cite files actually used under the memory base path (do not cite
    workspace files as memory citations)
  - if you used \`MEMORY.md\` and then a rollout summary/skill file, cite both
  - list entries in order of importance (most important first)
  - \`note\` should be short, single-line, and use simple characters only (avoid
    unusual symbols, no newlines)
- The final \`sessions:\` line is for us to track which past sessions you find
  useful:
  - one line, space-separated session ids after \`sessions:\`
  - session ids look like \`ses_...\` and appear in rollout summary files and
    MEMORY.md as \`session_id:\`
  - include unique ids only; do not repeat ids
  - omit the \`sessions:\` line if no session ids are available
  - do not include file paths or notes on this line
  - for every citation entry, try to find and cite the corresponding session id
- Never include memory citations inside pull-request messages.
- Never cite blank lines; double-check ranges.

`

const SUMMARY_ONLY_CITATIONS = `Memory citation requirements:

- When a read rollout summary informs the answer, append exactly one fenced
  \`memory-citation\` block as the VERY LAST content of the final reply.
  Answer first, then a blank line, then the opening fence at column 0.
- Cite only memory files actually read and used. Do not cite memory_summary.md.
  Do not reread files solely to construct citations. Never cite in pull requests.
- Use relative paths and nonblank line ranges. Notes must be short and single-line.
- Include unique session ids already available; omit the sessions line if none.
- Use this exact structure (never XML tags):
\`\`\`\`
answer text ends here.

\`\`\`memory-citation
rollout_summaries/2026-02-17T21-23-02-ln3m-example.md:10-12|note=weekly report format
sessions: ses_abc123 ses_def456
\`\`\`
\`\`\`\`

`

export function overlayV2CitationInstructions(prompt: string, version: "v1" | "v2" = "v1"): string {
  let start = prompt.indexOf("Memory citation requirements:")
  if (start === -1) start = prompt.indexOf("Memory citations:")
  const end = prompt.indexOf("Updating memories:")
  const instructions = version === "v2" ? SUMMARY_ONLY_CITATIONS : V2_CITATION_INSTRUCTIONS
  if (start === -1 || end === -1 || end <= start) return `${prompt.trimEnd()}\n\n${instructions}`
  return prompt.slice(0, start) + instructions + prompt.slice(end)
}
