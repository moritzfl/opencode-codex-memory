export interface MemoryCitationEntry {
  path: string
  lineStart: number
  lineEnd: number
  note: string
}

export interface ParsedCitation {
  sessionIds: string[]
  entries: MemoryCitationEntry[]
  raw: string
}

const CITATION_BLOCK_RE = /<memory-citation>[\s\S]*?<\/memory-citation>/gi

function extractSection(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"))
  return m ? m[1] : null
}

function parseEntry(line: string): MemoryCitationEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const noteSplit = trimmed.lastIndexOf("|note=[")
  if (noteSplit === -1 || !trimmed.endsWith("]")) return null
  const location = trimmed.slice(0, noteSplit)
  const note = trimmed.slice(noteSplit + "|note=[".length, -1).trim()
  const colon = location.lastIndexOf(":")
  if (colon === -1) return null
  const path = location.slice(0, colon).trim()
  const range = location.slice(colon + 1)
  const dash = range.indexOf("-")
  if (dash === -1) return null
  const lineStart = Number.parseInt(range.slice(0, dash).trim(), 10)
  const lineEnd = Number.parseInt(range.slice(dash + 1).trim(), 10)
  if (!path || Number.isNaN(lineStart) || Number.isNaN(lineEnd)) return null
  return { path, lineStart, lineEnd, note }
}

export function parseCitations(text: string): ParsedCitation[] {
  const results: ParsedCitation[] = []
  const re = new RegExp(CITATION_BLOCK_RE)
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const entries: MemoryCitationEntry[] = []
    const sessionIds: string[] = []
    const seen = new Set<string>()

    const entriesBlock = extractSection(raw, "citation_entries")
    if (entriesBlock) {
      for (const line of entriesBlock.split(/\r?\n/)) {
        const entry = parseEntry(line)
        if (entry) entries.push(entry)
      }
    }

    const idsBlock = extractSection(raw, "session_ids")
    if (idsBlock) {
      for (const line of idsBlock.split(/\r?\n/)) {
        const id = line.trim()
        if (id && !seen.has(id)) {
          seen.add(id)
          sessionIds.push(id)
        }
      }
    } else if (entriesBlock && entries.length === 0) {
      // Legacy format: <citation_entries> held a comma-separated session-id list.
      for (const id of entriesBlock.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!seen.has(id)) {
          seen.add(id)
          sessionIds.push(id)
        }
      }
    }

    if (entries.length > 0 || sessionIds.length > 0) {
      results.push({ sessionIds, entries, raw })
    }
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
