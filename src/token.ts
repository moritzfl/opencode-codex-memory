export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4

export function estimateTokens(input: string): number {
  return Math.max(0, Math.round(input.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN))
}

const TRUNCATION_MARKER = "\n[...truncated...]\n"

/**
 * Middle truncation, like codex truncate_with_head_and_tail: keep the head
 * and the tail with an explicit marker. Tail-dropping would silently lose the
 * end of memory_summary.md (the "Older Memory Topics" index lives there).
 */
export function truncateToTokens(input: string, maxTokens: number): string {
  const maxChars = maxTokens * TOKEN_ESTIMATE_CHARS_PER_TOKEN
  if (input.length <= maxChars) return input
  const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length)
  const head = Math.ceil(keep / 2)
  const tail = keep - head
  return input.slice(0, head) + TRUNCATION_MARKER + input.slice(input.length - tail)
}