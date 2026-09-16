/**
 * V2-only citation instructions. V1 `read_path.md` keeps the XML contract;
 * the TUI renders fenced `memory-citation` blocks, so the V2 context hook
 * overlays this section onto the shared inject prompt.
 */
export const V2_CITATION_INSTRUCTIONS = `Memory citation requirements:

- If ANY relevant memory files were used: append exactly one fenced code
  block with the language tag \`memory-citation\` as the VERY LAST content of
  the final reply. Normal responses should include the answer first, then
  append the block at the end. The host renders this block natively.
- Use this exact structure for programmatic parsing:
\`\`\`\`
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

export function overlayV2CitationInstructions(prompt: string): string {
  const start = prompt.indexOf("Memory citation requirements:")
  const end = prompt.indexOf("Updating memories:")
  if (start === -1 || end === -1 || end <= start) return `${prompt.trimEnd()}\n\n${V2_CITATION_INSTRUCTIONS}`
  return prompt.slice(0, start) + V2_CITATION_INSTRUCTIONS + prompt.slice(end)
}
