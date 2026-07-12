import fs from "fs"
import path from "path"
import { safeResolveMemoryPath, assertMemoryRootSafe } from "../src/path-guard.js"
import { tool } from "@opencode-ai/plugin"

const MAX_READ_BYTES = 256 * 1024

export const memory_read = tool({
  description:
    "Read a file from the persistent memory workspace (MEMORY.md, rollout_summaries/*, skills/*, etc.). " +
    "Paths are relative to the memory root and cannot escape it. Supports line_offset/max_lines for " +
    "reading a window of a large file; line_offset is 1-indexed and the starting line is reported.",
  args: {
    path: tool.schema.string().describe("Relative path inside the memory workspace (e.g. MEMORY.md, rollout_summaries/session-xyz.md)."),
    line_offset: tool.schema.number().int().min(1).optional().describe("1-indexed line to start reading from."),
    max_lines: tool.schema.number().int().min(1).optional().describe("Maximum number of lines to return."),
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
          output: `Directory ${args.path}/\n` + entries.map((e) => `- ${e}`).join("\n") + "\n(use memory_list for sorted, typed listings)",
          metadata: { kind: "directory", entries },
        }
      }
      // Read the whole file and apply the line window FIRST; the byte cap
      // applies to the WINDOWED output. Capping the raw read used to make
      // lines beyond the first 256 KiB unreachable regardless of line_offset.
      const text = fs.readFileSync(fullPath, "utf8")
      // Line windowing mirrors codex memories/read: 1-indexed offset, bounded
      // line count, and the start line reported so file:line citations work.
      const startLine = args.line_offset ?? 1
      let lines = text.split(/\r?\n/)
      const totalLines = lines.length
      if (startLine > totalLines) {
        return { output: `memory_read error: line_offset ${startLine} exceeds file length (${totalLines} lines).` }
      }
      lines = lines.slice(startLine - 1)
      let lineTruncated = false
      if (args.max_lines !== undefined && lines.length > args.max_lines) {
        lines = lines.slice(0, args.max_lines)
        lineTruncated = true
      }
      let body = lines.join("\n")
      let byteTruncated = false
      if (Buffer.byteLength(body, "utf8") > MAX_READ_BYTES) {
        byteTruncated = true
        // Byte-accurate cut; drop a possibly split trailing multibyte char.
        body = Buffer.from(body, "utf8").subarray(0, MAX_READ_BYTES).toString("utf8").replace(/\uFFFD+$/, "")
      }
      const notes: string[] = []
      if (lineTruncated) notes.push(`[stopped after ${args.max_lines} lines; file has ${totalLines}]`)
      if (byteTruncated) notes.push(`[output truncated at ${MAX_READ_BYTES} bytes; use line_offset to page]`)
      const header = startLine > 1 ? `[starting at line ${startLine}]\n` : ""
      return {
        output: header + body + (notes.length ? "\n\n" + notes.join("\n") : ""),
        metadata: { path: args.path, bytes: stat.size, start_line_number: startLine, truncated: byteTruncated || lineTruncated },
      }
    } catch (err) {
      return { output: `memory_read error: ${(err as Error).message}` }
    }
  },
})

/** Skip hidden entries and symlinks, mirroring codex local/list.rs + local/search.rs walkers. */
function visibleEntries(dir: string): { name: string; isDir: boolean }[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: { name: string; isDir: boolean }[] = []
  for (const name of names) {
    if (name.startsWith(".")) continue
    let st: fs.Stats
    try {
      st = fs.lstatSync(path.join(dir, name))
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    out.push({ name, isDir: st.isDirectory() })
  }
  return out
}

const LIST_MAX_RESULTS = 2000

export const memory_list = tool({
  description:
    "List the immediate entries of a directory in the persistent memory workspace, sorted by name, " +
    "with entry types. Hidden files and symlinks are skipped. Use path '' (empty) for the memory root.",
  args: {
    path: tool.schema.string().default("").describe("Relative directory path inside the memory workspace ('' for the root)."),
    max_results: tool.schema.number().int().min(1).max(LIST_MAX_RESULTS).default(LIST_MAX_RESULTS).describe("Maximum entries to return."),
  },
  async execute(args) {
    try {
      const fullPath = safeResolveMemoryPath(args.path || ".")
      if (!fs.existsSync(fullPath)) return { output: `Not found: ${args.path}` }
      if (!fs.statSync(fullPath).isDirectory()) return { output: `memory_list error: not a directory: ${args.path}` }
      const entries = visibleEntries(fullPath).sort((a, b) => a.name.localeCompare(b.name))
      const truncated = entries.length > args.max_results
      const shown = entries.slice(0, args.max_results)
      const prefix = args.path ? `${args.path.replace(/\/+$/, "")}/` : ""
      const listing = shown.map((e) => ({ path: `${prefix}${e.name}`, entry_type: e.isDir ? "directory" : "file" }))
      if (listing.length === 0) return { output: `Directory ${args.path || "."} is empty.` }
      return {
        output:
          listing.map((e) => `${e.entry_type === "directory" ? "d" : "f"} ${e.path}`).join("\n") +
          (truncated ? `\n[truncated: ${entries.length - args.max_results} more entries]` : ""),
        metadata: { path: args.path, entries: listing, truncated },
      }
    } catch (err) {
      return { output: `memory_list error: ${(err as Error).message}` }
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

// Walks every non-hidden, non-symlink file (codex searches all files, not an
// extension allowlist), in sorted order for deterministic results.
function collectSearchFiles(root: string): CandidateFile[] {
  const files: CandidateFile[] = []
  const walk = (dir: string, prefix: string) => {
    const entries = visibleEntries(dir).sort((a, b) => a.name.localeCompare(b.name))
    for (const { name, isDir } of entries) {
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (isDir) {
        walk(abs, rel)
      } else {
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
    query: tool.schema.string().min(1).optional().describe("Search query (substring match). Optional when since/until is set."),
    case_sensitive: tool.schema.boolean().default(true).describe("Case-sensitive matching (default true, like codex memories/search)."),
    since: tool.schema.string().optional().describe("Only time-anchored files at/after this time (YYYY-MM-DD or ISO datetime)."),
    until: tool.schema.string().optional().describe("Only time-anchored files at/before this time (YYYY-MM-DD or ISO datetime; whole day for date-only)."),
    limit: tool.schema.number().int().min(1).max(200).default(200).describe("Max matches to return (default/max 200, like codex)."),
  },
  async execute(args, ctx) {
    try {
      // Walks from the root directly (no per-path resolution), so the root
      // symlink check must run here explicitly.
      const root = assertMemoryRootSafe()
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

      const caseSensitive = args.case_sensitive ?? true
      const q = caseSensitive ? args.query : args.query.toLowerCase()
      const matches: { file: string; line: number; text: string }[] = []
      // Files are walked in sorted order, so results are ordered by
      // (path, line) like codex's search response.
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
          const haystack = caseSensitive ? line : line.toLowerCase()
          if (haystack.includes(q)) {
            matches.push({ file: f.rel, line: i + 1, text: line.slice(0, 240) })
          }
        }
      }
      if (matches.length === 0) return { output: `No matches for "${args.query}"${rangeLabel}.` }
      const out = matches
        .map((m) => `${m.file}:${m.line}: ${m.text}`)
        .join("\n")
      // codex signals a capped result set (truncated/next_cursor); without an
      // indicator the model cannot tell "exactly N" from "stopped at N".
      const capped = matches.length >= args.limit
      return {
        output:
          `${matches.length} match(es) for "${args.query}"${rangeLabel}${capped ? " (result limit reached; more may exist)" : ""}:\n${out}`,
        metadata: { count: matches.length, query: args.query, since: args.since, until: args.until, truncated: capped },
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
      // Writes under the root without per-path resolution; check the root.
      const root = assertMemoryRootSafe()
      const notesDir = path.join(root, NOTES_DIR)
      fs.mkdirSync(notesDir, { recursive: true })
      const ts = new Date().toISOString()
      const slug = (args.title ?? `note-${ts}`)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60)
      // Filename layout matches codex: <YYYY-MM-DDTHH-MM-SS>-<slug>.md.
      const stem = `${ts.slice(0, 19).replace(/[:.]/g, "-")}-${slug}`
      const header = `# ${args.title ?? "Ad-hoc note"}\n\n- created: ${ts}\n- session: ${ctx.sessionID}\n\n`
      // Notes are append-only (codex create_new semantics): never overwrite an
      // existing note; disambiguate on collision instead.
      let file = path.join(notesDir, `${stem}.md`)
      for (let i = 2; ; i++) {
        try {
          fs.writeFileSync(file, header + args.note + "\n", { flag: "wx" })
          break
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST" || i > 20) throw err
          file = path.join(notesDir, `${stem}-${i}.md`)
        }
      }
      return {
        output: `Note saved to ${path.relative(root, file)}`,
        metadata: { file: path.relative(root, file), sessionID: ctx.sessionID },
      }
    } catch (err) {
      return { output: `memory_add_note error: ${(err as Error).message}` }
    }
  },
})