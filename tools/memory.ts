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
function collectSearchFiles(start: string, prefix: string): CandidateFile[] {
  const files: CandidateFile[] = []
  const walk = (dir: string, rel: string) => {
    const entries = visibleEntries(dir).sort((a, b) => a.name.localeCompare(b.name))
    for (const { name, isDir } of entries) {
      const abs = path.join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      if (isDir) {
        walk(abs, relPath)
      } else {
        files.push({ rel: relPath, abs, ts: fileTimestamp(name) })
      }
    }
  }
  walk(start, prefix)
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

// --- search engine, ported from codex ext/memories/src/local/search.rs ---

const SEARCH_MAX_RESULTS = 200 // codex MAX_SEARCH_RESULTS (= default)

interface SearchMatch {
  path: string
  match_line_number: number
  content_start_line_number: number
  content: string
  matched_queries: string[]
}

// codex SearchComparison::prepare: lowercase when case-insensitive; when
// normalized, keep ONLY alphanumeric characters (Unicode) so "blue-green",
// "blue green" and "bluegreen" compare equal.
function prepareComparable(value: string, caseSensitive: boolean, normalized: boolean): string {
  let v = caseSensitive ? value : value.toLowerCase()
  if (normalized) v = v.replace(/[^\p{L}\p{N}]/gu, "")
  return v
}

type MatchMode = "any" | "all_on_same_line" | "all_within_lines"

/**
 * Per-file matching, all three codex modes. Window mode extends from every
 * line matching at least one query until all queries are covered (bounded by
 * lineCount), then drops windows that strictly contain another window so only
 * minimal windows are reported.
 */
function searchFileContent(
  file: CandidateFile,
  lines: string[],
  queries: string[],
  preparedQueries: string[],
  mode: MatchMode,
  lineCount: number,
  contextLines: number,
  caseSensitive: boolean,
  normalized: boolean,
  out: SearchMatch[],
): void {
  const lineFlags = lines.map((line) => {
    const prepared = prepareComparable(line, caseSensitive, normalized)
    return preparedQueries.map((q) => prepared.includes(q))
  })
  const matchedQueries = (flags: boolean[]) => queries.filter((_, i) => flags[i])
  const push = (start: number, end: number, flags: boolean[]) => {
    const contentStart = Math.max(0, start - contextLines)
    const contentEnd = Math.min(lines.length, end + contextLines + 1)
    out.push({
      path: file.rel,
      match_line_number: start + 1,
      content_start_line_number: contentStart + 1,
      content: lines.slice(contentStart, contentEnd).join("\n"),
      matched_queries: matchedQueries(flags),
    })
  }

  if (mode === "any" || mode === "all_on_same_line") {
    for (let i = 0; i < lines.length; i++) {
      const flags = lineFlags[i]
      const hit = mode === "any" ? flags.some(Boolean) : flags.every(Boolean)
      if (hit) push(i, i, flags)
    }
    return
  }

  // all_within_lines
  const windows: { start: number; end: number; flags: boolean[] }[] = []
  for (let start = 0; start < lines.length; start++) {
    if (!lineFlags[start].some(Boolean)) continue
    const lastAllowed = Math.min(start + lineCount - 1, lines.length - 1)
    const flags = new Array<boolean>(preparedQueries.length).fill(false)
    for (let end = start; end <= lastAllowed; end++) {
      for (let q = 0; q < flags.length; q++) flags[q] = flags[q] || lineFlags[end][q]
      if (flags.every(Boolean)) {
        windows.push({ start, end, flags })
        break
      }
    }
  }
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]
    const containsAnother = windows.some(
      (o, j) => i !== j && w.start <= o.start && w.end >= o.end && (w.start !== o.start || w.end !== o.end),
    )
    if (containsAnother) continue
    push(w.start, w.end, w.flags)
  }
}

function renderMatch(m: SearchMatch): string {
  const header = `${m.path}:${m.match_line_number}`
  if (!m.content.includes("\n") && m.content_start_line_number === m.match_line_number) {
    return `${header}: ${m.content}`
  }
  return `${header} (content from line ${m.content_start_line_number}):\n${m.content}`
}

export const memory_search = tool({
  description:
    "Search the persistent memory workspace (MEMORY.md, rollout_summaries/*, skills/*) for substring " +
    "matches. Supports multiple queries with match_mode: 'any' (a line matching any query), " +
    "'all_on_same_line' (a line containing every query), or 'all_within_lines' (all queries within a " +
    "window of line_count lines). Optional path scoping, context lines, and cursor pagination. " +
    "Optional since/until restrict the search to time-anchored files (rollout summaries, ad-hoc " +
    "notes) from that period — useful to recall what the user was working on around a given time. " +
    "With since/until and no queries, returns a chronological listing of that period's sessions/notes.",
  args: {
    queries: tool.schema.array(tool.schema.string()).optional().describe("Search substrings (at least one, non-empty after trim). Optional only when since/until is set."),
    match_mode: tool.schema.enum(["any", "all_on_same_line", "all_within_lines"]).default("any").describe("How multiple queries combine (default any)."),
    line_count: tool.schema.number().int().min(1).optional().describe("Window size in lines for all_within_lines (required for that mode)."),
    path: tool.schema.string().optional().describe("Restrict the search to a file or directory relative to the memory root."),
    cursor: tool.schema.string().optional().describe("Pagination cursor from a previous response's next_cursor."),
    context_lines: tool.schema.number().int().min(0).default(0).describe("Extra lines of context around each match."),
    case_sensitive: tool.schema.boolean().default(true).describe("Case-sensitive matching (default true, like codex memories/search)."),
    normalized: tool.schema.boolean().default(false).describe("Compare only alphanumeric characters, ignoring separators (blue-green == bluegreen); combine with case_sensitive=false to also ignore case."),
    since: tool.schema.string().optional().describe("Only time-anchored files at/after this time (YYYY-MM-DD or ISO datetime)."),
    until: tool.schema.string().optional().describe("Only time-anchored files at/before this time (YYYY-MM-DD or ISO datetime; whole day for date-only)."),
    max_results: tool.schema.number().int().min(1).max(SEARCH_MAX_RESULTS).default(SEARCH_MAX_RESULTS).describe("Max matches per page (default/max 200, like codex)."),
  },
  async execute(args, ctx) {
    try {
      // Walks from the root directly (no per-path resolution), so the root
      // symlink check must run here explicitly.
      const root = assertMemoryRootSafe()
      if (!fs.existsSync(root)) return { output: "Memory workspace is empty." }

      const queries = (args.queries ?? []).map((q) => q.trim())
      if (args.queries && (queries.length === 0 || queries.some((q) => q.length === 0))) {
        return { output: "memory_search error: queries must be non-empty strings." }
      }
      if (queries.length === 0 && !args.since && !args.until) {
        return { output: "memory_search error: provide queries and/or since/until." }
      }
      const mode = (args.match_mode ?? "any") as MatchMode
      if (mode === "all_within_lines" && !(typeof args.line_count === "number" && args.line_count >= 1)) {
        return { output: "memory_search error: all_within_lines requires line_count >= 1." }
      }
      const since = args.since ? parseDateArg(args.since, false) : null
      if (args.since && since === null) return { output: `memory_search error: could not parse since="${args.since}".` }
      const until = args.until ? parseDateArg(args.until, true) : null
      if (args.until && until === null) return { output: `memory_search error: could not parse until="${args.until}".` }

      // Path scoping: a file searches just that file, a directory is walked.
      let files: CandidateFile[]
      if (args.path) {
        const start = safeResolveMemoryPath(args.path)
        let st: fs.Stats
        try {
          st = fs.statSync(start)
        } catch {
          return { output: `Not found: ${args.path}` }
        }
        const rel = args.path.replace(/\/+$/, "")
        files = st.isFile() ? [{ rel, abs: start, ts: fileTimestamp(path.basename(start)) }] : collectSearchFiles(start, rel)
      } else {
        files = collectSearchFiles(root, "")
      }

      const timeFiltered = since !== null || until !== null
      if (timeFiltered) {
        // Time filters only apply to time-anchored files; MEMORY.md etc. carry
        // no single timestamp and are excluded from time-scoped recall.
        files = files.filter((f) => f.ts !== null && (since === null || f.ts >= since) && (until === null || f.ts <= until))
        files.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      }
      const rangeLabel = timeFiltered ? ` in ${args.since ?? "..."}..${args.until ?? "..."}` : ""

      if (queries.length === 0) {
        const listing = files.slice(0, args.max_results).map((f) => {
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
      const normalized = args.normalized ?? false
      const preparedQueries = queries.map((q) => prepareComparable(q, caseSensitive, normalized))
      if (preparedQueries.some((q) => q.length === 0)) {
        return { output: "memory_search error: a query is empty after normalization." }
      }

      // codex: collect ALL matches, sort by (path, line), then page by cursor.
      const all: SearchMatch[] = []
      for (const f of files) {
        let content: string
        try {
          content = fs.readFileSync(f.abs, "utf8")
        } catch {
          continue
        }
        if (content.includes("\u0000")) continue // binary, like codex's InvalidData skip
        searchFileContent(
          f,
          content.split(/\r?\n/),
          queries,
          preparedQueries,
          mode,
          args.line_count ?? 1,
          args.context_lines ?? 0,
          caseSensitive,
          normalized,
          all,
        )
      }
      all.sort((a, b) => a.path.localeCompare(b.path) || a.match_line_number - b.match_line_number)

      let startIndex = 0
      if (args.cursor !== undefined) {
        startIndex = Number.parseInt(args.cursor, 10)
        if (!Number.isInteger(startIndex) || startIndex < 0 || String(startIndex) !== args.cursor.trim()) {
          return { output: `memory_search error: invalid cursor "${args.cursor}" (must be a non-negative integer).` }
        }
        if (startIndex > all.length) {
          return { output: `memory_search error: cursor ${startIndex} exceeds result count ${all.length}.` }
        }
      }
      const endIndex = Math.min(startIndex + (args.max_results ?? SEARCH_MAX_RESULTS), all.length)
      const pageMatches = all.slice(startIndex, endIndex)
      const nextCursor = endIndex < all.length ? String(endIndex) : null
      const truncated = nextCursor !== null

      const label = queries.map((q) => `"${q}"`).join(", ")
      if (all.length === 0) return { output: `No matches for ${label}${rangeLabel}.` }
      return {
        output:
          `${pageMatches.length} of ${all.length} match(es) for ${label}${rangeLabel}` +
          `${truncated ? ` (more available; pass cursor=${nextCursor})` : ""}:\n` +
          pageMatches.map(renderMatch).join("\n"),
        metadata: {
          queries,
          match_mode: mode === "all_within_lines" ? { type: mode, line_count: args.line_count } : { type: mode },
          path: args.path,
          matches: pageMatches,
          next_cursor: nextCursor,
          truncated,
          since: args.since,
          until: args.until,
        },
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