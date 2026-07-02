import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"
import type { Stage1Output } from "./store.js"

const RAW_MEMORIES_FILE = "raw_memories.md"
const ROLLOUT_DIR = "rollout_summaries"
const EXTENSIONS_DIR = "extensions"
const SKILLS_DIR = "skills"
const ADHOC_NOTES_DIR = "extensions/ad_hoc/notes"

export function ensureLayout(): void {
  const root = memoryRoot()
  for (const dir of [
    root,
    path.join(root, ROLLOUT_DIR),
    path.join(root, SKILLS_DIR),
    path.join(root, EXTENSIONS_DIR),
    path.join(root, ADHOC_NOTES_DIR),
  ]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  const memoryMd = path.join(root, "MEMORY.md")
  if (!fs.existsSync(memoryMd)) fs.writeFileSync(memoryMd, "# MEMORY.md\n\n_Searchable index of memories._\n", { flag: "w" })
  const summary = path.join(root, "memory_summary.md")
  if (!fs.existsSync(summary)) fs.writeFileSync(summary, "", { flag: "w" })
}

const RAW_MEMORY_MAX_CHARS = 2_500
const ROLLOUT_SUMMARY_MAX_CHARS = 1_000

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + "\n\n[truncated]"
}

export function rebuildRawMemories(outputs: Stage1Output[]): string {
  const sorted = [...outputs].sort((a, b) => a.session_id.localeCompare(b.session_id))
  const body = sorted
    .map((o) => `## ${o.session_id}\n\n- slug: ${o.rollout_slug ?? "n/a"}\n- generated_at: ${new Date(o.generated_at).toISOString()}\n\n### Summary\n${truncate(o.rollout_summary, ROLLOUT_SUMMARY_MAX_CHARS)}\n\n### Raw memory\n${truncate(o.raw_memory, RAW_MEMORY_MAX_CHARS)}\n`)
    .join("\n")
  const content = `# raw_memories.md\n\n_Merged raw memories from past sessions. Regenerated each Phase 2 run._\n\n${body}\n`
  fs.writeFileSync(path.join(memoryRoot(), RAW_MEMORIES_FILE), content, { flag: "w" })
  return content
}

export function writeRolloutSummaries(outputs: Stage1Output[]): void {
  const dir = path.join(memoryRoot(), ROLLOUT_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const keep = new Set(outputs.map((o) => `${o.session_id}.md`))
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".md") && !keep.has(name)) {
      try { fs.unlinkSync(path.join(dir, name)) } catch {}
    }
  }
  for (const o of outputs) {
    const file = path.join(dir, `${o.session_id}.md`)
    const body = `# ${o.session_id}\n\n- slug: ${o.rollout_slug ?? "n/a"}\n- generated_at: ${new Date(o.generated_at).toISOString()}\n- usage_count: ${o.usage_count}\n\n## Summary\n${o.rollout_summary}\n`
    fs.writeFileSync(file, body, { flag: "w" })
  }
}

export function pruneExtensionResources(retentionDays: number): void {
  const dir = path.join(memoryRoot(), EXTENSIONS_DIR)
  if (!fs.existsSync(dir)) return
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const walk = (d: string) => {
    for (const name of fs.readdirSync(d)) {
      const abs = path.join(d, name)
      let stat
      try { stat = fs.statSync(abs) } catch { continue }
      if (stat.isDirectory()) walk(abs)
      else if (stat.mtimeMs < cutoff) {
        try { fs.unlinkSync(abs) } catch {}
      }
    }
  }
  walk(dir)
}

export function writeWorkspaceDiff(diff: string): string {
  const file = path.join(memoryRoot(), "phase2_workspace_diff.md")
  const truncated = diff.slice(0, 4 * 1024 * 1024)
  fs.writeFileSync(file, truncated, { flag: "w" })
  return file
}