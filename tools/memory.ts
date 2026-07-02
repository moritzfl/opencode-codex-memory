import fs from "fs"
import path from "path"
import { safeResolveMemoryPath } from "../src/path-guard.js"
import { memoryRoot } from "../src/paths.js"
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

export const memory_search = tool({
  description:
    "Search across the persistent memory workspace (MEMORY.md, rollout_summaries/*, skills/*). " +
    "Returns matching lines with file paths. Simple case-insensitive substring/ranking fallback when no index is available.",
  args: {
    query: tool.schema.string().min(1).describe("Search query (case-insensitive substring match)."),
    limit: tool.schema.number().int().min(1).max(200).default(50).describe("Max matches to return."),
  },
  async execute(args, ctx) {
    try {
      const root = memoryRoot()
      if (!fs.existsSync(root)) return { output: "Memory workspace is empty." }
      const q = args.query.toLowerCase()
      const matches: { file: string; line: number; text: string }[] = []
      const limit = args.limit
      const walk = (dir: string, prefix: string) => {
        if (matches.length >= limit) return
        let entries: string[]
        try {
          entries = fs.readdirSync(dir)
        } catch {
          return
        }
        for (const name of entries) {
          if (matches.length >= limit) return
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
            let content: string
            try {
              content = fs.readFileSync(abs, "utf8")
            } catch {
              continue
            }
            content.split(/\r?\n/).forEach((line, i) => {
              if (matches.length >= limit) return
              if (line.toLowerCase().includes(q)) {
                matches.push({ file: rel, line: i + 1, text: line.slice(0, 240) })
              }
            })
          }
        }
      }
      walk(root, "")
      if (matches.length === 0) return { output: `No matches for "${args.query}".` }
      const out = matches
        .map((m) => `${m.file}:${m.line}: ${m.text}`)
        .join("\n")
      return {
        output: `${matches.length} match(es) for "${args.query}":\n${out}`,
        metadata: { count: matches.length, query: args.query },
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