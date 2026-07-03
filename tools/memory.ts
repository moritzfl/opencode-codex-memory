import fs from "fs"
import path from "path"
import { safeResolveMemoryPath } from "@/path-guard"
import { memoryRoot } from "@/paths"
import { tool } from "@opencode-ai/plugin"

const MAX_READ_BYTES = 256 * 1024

export const memory_read = tool({
  description:
    "Read a file from the persistent memory workspace (MEMORY.md, rollout_summaries/*, skills/*, etc.). " +
    "Paths are relative to the memory root and cannot escape it.",
  args: {
    path: tool.schema.string().describe("Relative path inside the memory workspace (e.g. MEMORY.md, rollout_summaries/session-xyz.md)."),
  },
  async execute(args, ctx) {
    try {
      const fullPath = safeResolveMemoryPath(args.path)
      if (!fs.existsSync(fullPath)) {
        return { output: `Not found: ${args.path}` }
      }
      const stat = fs.statSync(fullPath)
      if (stat.isDirectory()) {
        const entries = fs.readdirSync(fullPath)
        return {
          output: `Directory ${args.path}/\n` + entries.map((e) => `- ${e}`).join("\n"),
          metadata: { kind: "directory", entries },
        }
      }
      const fd = fs.openSync(fullPath, "r")
      try {
        const size = Math.min(stat.size, MAX_READ_BYTES)
        const buf = Buffer.alloc(size)
        fs.readSync(fd, buf, 0, size, 0)
        const text = buf.toString("utf8")
        const truncated = stat.size > MAX_READ_BYTES
        return {
          output: text + (truncated ? `\n\n[truncated: ${stat.size - MAX_READ_BYTES} bytes omitted]` : ""),
          metadata: { path: args.path, bytes: stat.size, truncated },
        }
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      return { output: `memory_read error: ${(err as Error).message}` }
    }
  },
})

// Time-anchored memory files carry their session/note timestamp as a filename
// prefix: 2026-07-03T05-11-22-<hash>-<slug>.md / 2026-07-03T05-11-22_<slug>.md
function fileTimestamp(name: string): number | null {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!m) return null
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  return Number.isNaN(ts) ? null : ts
}

// Accepts YYYY-MM-DD (whole-day boundary) or a full ISO datetime.
function parseDateArg(value: string, endOfDay: boolean): number | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const ts = Date.parse(`${value}T00:00:00Z`)
    if (Number.isNaN(ts)) return null
    return endOfDay ? ts + 24 * 60 * 60 * 1000 - 1 : ts
  }
  const ts = Date.parse(value)
  return Number.isNaN(ts) ? null : ts
}

interface CandidateFile {
  rel: string
  abs: string
  ts: number | null
}

function collectSearchFiles(root: string): CandidateFile[] {
  const files: CandidateFile[] = []
  const walk = (dir: string, prefix: string) => {
    let entries: string[]
    try {
      entries = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name.startsWith(".git")) continue
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(abs, rel)
      } else if (/\.(md|txt|json)$/i.test(name)) {
        files.push({ rel, abs, ts: fileTimestamp(name) })
      }
    }
  }
  walk(root, "")
  return files
}

function firstContentLine(content: string): string {
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    // Skip the metadata header lines of summary/note files.
    if (/^(session_id|updated_at|cwd|usage_count|created|session):/i.test(t)) continue
    return t.slice(0, 160)
  }
  return "(empty)"
}

export const memory_search = tool({
  description:
    "Search across the persistent memory workspace (MEMORY.md, rollout_summaries/*, skills/*). " +
    "Returns matching lines with file paths. Optional since/until restrict the search to " +
    "time-anchored files (rollout summaries, ad-hoc notes) from that period — useful to recall " +
    "what the user was working on around a given time. With since/until and no query, returns a " +
    "chronological listing of that period's sessions/notes.",
  args: {
    query: tool.schema.string().min(1).optional().describe("Search query (case-insensitive substring match). Optional when since/until is set."),
    since: tool.schema.string().optional().describe("Only time-anchored files at/after this time (YYYY-MM-DD or ISO datetime)."),
    until: tool.schema.string().optional().describe("Only time-anchored files at/before this time (YYYY-MM-DD or ISO datetime; whole day for date-only)."),
    limit: tool.schema.number().int().min(1).max(200).default(50).describe("Max matches to return."),
  },
  async execute(args, ctx) {
    try {
      const root = memoryRoot()
      if (!fs.existsSync(root)) return { output: "Memory workspace is empty." }
      if (!args.query && !args.since && !args.until) {
        return { output: "memory_search error: provide a query and/or since/until." }
      }
      const since = args.since ? parseDateArg(args.since, false) : null
      if (args.since && since === null) return { output: `memory_search error: could not parse since="${args.since}".` }
      const until = args.until ? parseDateArg(args.until, true) : null
      if (args.until && until === null) return { output: `memory_search error: could not parse until="${args.until}".` }

      let files = collectSearchFiles(root)
      const timeFiltered = since !== null || until !== null
      if (timeFiltered) {
        // Time filters only apply to time-anchored files; MEMORY.md etc. carry
        // no single timestamp and are excluded from time-scoped recall.
        files = files.filter((f) => f.ts !== null && (since === null || f.ts >= since) && (until === null || f.ts <= until))
        files.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      }
      const rangeLabel = timeFiltered ? ` in ${args.since ?? "..."}..${args.until ?? "..."}` : ""

      if (!args.query) {
        const listing = files.slice(0, args.limit).map((f) => {
          let content = ""
          try {
            content = fs.readFileSync(f.abs, "utf8")
          } catch {
          }
          return `${new Date(f.ts!).toISOString()} ${f.rel} — ${firstContentLine(content)}`
        })
        if (listing.length === 0) return { output: `No time-anchored memory files${rangeLabel}.` }
        return {
          output: `${listing.length} memory file(s)${rangeLabel}:\n${listing.join("\n")}`,
          metadata: { count: listing.length, since: args.since, until: args.until },
        }
      }

      const q = args.query.toLowerCase()
      const matches: { file: string; line: number; text: string }[] = []
      for (const f of files) {
        if (matches.length >= args.limit) break
        let content: string
        try {
          content = fs.readFileSync(f.abs, "utf8")
        } catch {
          continue
        }
        for (const [i, line] of content.split(/\r?\n/).entries()) {
          if (matches.length >= args.limit) break
          if (line.toLowerCase().includes(q)) {
            matches.push({ file: f.rel, line: i + 1, text: line.slice(0, 240) })
          }
        }
      }
      if (matches.length === 0) return { output: `No matches for "${args.query}"${rangeLabel}.` }
      const out = matches
        .map((m) => `${m.file}:${m.line}: ${m.text}`)
        .join("\n")
      return {
        output: `${matches.length} match(es) for "${args.query}"${rangeLabel}:\n${out}`,
        metadata: { count: matches.length, query: args.query, since: args.since, until: args.until },
      }
    } catch (err) {
      return { output: `memory_search error: ${(err as Error).message}` }
    }
  },
})

const NOTES_DIR = "extensions/ad_hoc/notes"

export const memory_add_note = tool({
  description:
    "Append a short ad-hoc note to the persistent memory workspace under extensions/ad_hoc/notes/. " +
    "Used when the user asks to remember something for future sessions.",
  args: {
    note: tool.schema.string().min(1).max(4000).describe("The note text to persist."),
    title: tool.schema.string().max(120).optional().describe("Optional short title for the note."),
  },
  async execute(args, ctx) {
    try {
      const root = memoryRoot()
      const notesDir = path.join(root, NOTES_DIR)
      fs.mkdirSync(notesDir, { recursive: true })
      const ts = new Date().toISOString()
      const slug = (args.title ?? `note-${ts}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
      const file = path.join(notesDir, `${ts.slice(0, 19).replace(/[:.]/g, "-")}_${slug}.md`)
      const header = `# ${args.title ?? "Ad-hoc note"}\n\n- created: ${ts}\n- session: ${ctx.sessionID}\n\n`
      fs.writeFileSync(file, header + args.note + "\n", { flag: "w" })
      return {
        output: `Note saved to ${path.relative(root, file)}`,
        metadata: { file: path.relative(root, file), sessionID: ctx.sessionID },
      }
    } catch (err) {
      return { output: `memory_add_note error: ${(err as Error).message}` }
    }
  },
})