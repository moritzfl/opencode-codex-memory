export interface ParsedCitation {
  sessionIds: string[]
  raw: string
}

const CITATION_BLOCK_RE = /<memory-citation>\s*<citation_entries>\s*([\w.,\s-]*)\s*<\/citation_entries>\s*<\/memory-citation>/gis

export function parseCitations(text: string): ParsedCitation[] {
  const results: ParsedCitation[] = []
  const re = new RegExp(CITATION_BLOCK_RE)
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const ids = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (ids.length > 0) results.push({ sessionIds: ids, raw })
  }
  return results
}

export function extractCitedSessionIds(text: string): string[] {
  const seen = new Set<string>()
  for (const c of parseCitations(text)) {
    for (const id of c.sessionIds) seen.add(id)
  }
  return Array.from(seen)
}

export function stripCitations(text: string): string {
  return text.replace(CITATION_BLOCK_RE, "").replace(/[ \t]*\n{3,}/g, "\n\n").trimEnd()
}