export const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4

export function estimateTokens(input: string): number {
  return Math.max(0, Math.round(input.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN))
}

export function truncateToTokens(input: string, maxTokens: number): string {
  const maxChars = maxTokens * TOKEN_ESTIMATE_CHARS_PER_TOKEN
  if (input.length <= maxChars) return input
  return input.slice(0, maxChars)
}