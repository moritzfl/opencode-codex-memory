import fs from "fs"
import path from "path"
import { tool } from "@opencode-ai/plugin"
import { memoryRoot, memorySummaryPath } from "@/paths"
import { MemoryStore } from "@/store"
import { invalidateCache } from "@/source"
import { estimateTokens } from "@/token"

function isSymlinkedRoot(): boolean {
  const root = memoryRoot()
  try {
    return fs.lstatSync(root).isSymbolicLink()
  } catch {
    return false
  }
}

// Mirrors codex clear_memory_root_contents: deletes EVERY entry including
// .git, so previously deleted/redacted memory content is not recoverable
// from git history after a reset.
function wipeMemoriesDir(): void {
  const root = memoryRoot()
  if (!fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root)) {
    const abs = path.join(root, entry)
    try {
      const stat = fs.statSync(abs)
      if (stat.isDirectory()) fs.rmSync(abs, { recursive: true, force: true })
      else fs.unlinkSync(abs)
    } catch {}
  }
}

function listMemoriesDir(): string[] {
  const root = memoryRoot()
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, prefix: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === ".git") continue
      const abs = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      let stat
      try { stat = fs.statSync(abs) } catch { continue }
      if (stat.isDirectory()) {
        out.push(`${rel}/`)
        walk(abs, rel)
      } else {
        out.push(rel)
      }
    }
  }
  walk(root, "")
  return out
}

export const memory_reset = tool({
  description:
    "Reset all persistent memory. Wipes the plugin's extracted memories and jobs tables and the entire " +
    "contents of the memories directory (including git history). Per-session memory modes are preserved, " +
    "so disabled/polluted sessions stay excluded. Refuses to run if the memory root is a symlink.",
  args: {
    confirm: tool.schema.boolean().describe("Must be true to perform the reset."),
  },
  async execute(args) {
    if (!args.confirm) return { output: "Reset aborted: confirm=false." }
    if (isSymlinkedRoot()) {
      return { output: "Reset refused: memory root is a symlink. Remove it manually to be safe." }
    }
    try {
      const store = new MemoryStore()
      store.clearMemoryData()
      wipeMemoriesDir()
      // codex keeps its state DB pool open across resets (clear_memory_roots_contents
      // only wipes directories); closing here would strand cached handles elsewhere.
      invalidateCache()
      return { output: "Memory reset complete. Extracted memories and jobs cleared, memories directory (incl. git history) wiped, cache invalidated. Per-session memory modes were preserved." }
    } catch (err) {
      return { output: `memory_reset error: ${(err as Error).message}` }
    }
  },
})

export const memory_inspect = tool({
  description:
    "Inspect the current memory state. Returns: stage1_outputs count, last Phase 2 success watermark, " +
    "memory_summary token estimate, and a listing of the memories directory. Read-only.",
  args: {},
  async execute() {
    try {
      const store = new MemoryStore()
      const outputs = store.stage1Outputs()
      const summaryPath = memorySummaryPath()
      let summaryChars = 0
      let summaryTokens = 0
      if (fs.existsSync(summaryPath)) {
        const text = fs.readFileSync(summaryPath, "utf8")
        summaryChars = text.length
        summaryTokens = estimateTokens(text)
      }
      const listing = listMemoriesDir()
      const out = [
        `stage1_outputs: ${outputs.length}`,
        `memory_summary_chars: ${summaryChars}`,
        `memory_summary_tokens_est: ${summaryTokens}`,
        `memories_dir_entries: ${listing.length}`,
        "",
        "Files:",
        listing.length > 0 ? listing.join("\n") : "(empty)",
      ].join("\n")
      return {
        output: out,
        metadata: {
          stage1_count: outputs.length,
          summary_chars: summaryChars,
          summary_tokens_est: summaryTokens,
          files: listing,
        },
      }
    } catch (err) {
      return { output: `memory_inspect error: ${(err as Error).message}` }
    }
  },
})

export const memory_mode = tool({
  description:
    "Set the memory mode for the current session. 'enabled' allows Phase 1 extraction. " +
    "'disabled' excludes this session from extraction. 'polluted' marks it as having external context " +
    "(websearch/webfetch) that should not be trusted for memory.",
  args: {
    mode: tool.schema.enum(["enabled", "disabled", "polluted"]).describe("The memory mode to set."),
    sessionId: tool.schema.string().optional().describe("Session ID. Defaults to the current session."),
  },
  async execute(args, ctx) {
    try {
      const store = new MemoryStore()
      const sid = args.sessionId ?? ctx.sessionID
      store.setMemoryMode(sid, args.mode)
      return { output: `Memory mode for session ${sid} set to '${args.mode}'.`, metadata: { sessionId: sid, mode: args.mode } }
    } catch (err) {
      return { output: `memory_mode error: ${(err as Error).message}` }
    }
  },
})