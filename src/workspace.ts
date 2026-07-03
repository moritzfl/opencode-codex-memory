import fs from "fs"
import path from "path"
import { memoryRoot } from "./paths.js"
import type { Stage1Output } from "./store.js"
import { DIFF_ARTIFACT, type WorkspaceDiff } from "./git-baseline.js"

const RAW_MEMORIES_FILE = "raw_memories.md"
const ROLLOUT_DIR = "rollout_summaries"
const EXTENSIONS_DIR = "extensions"
const SKILLS_DIR = "skills"
const ADHOC_NOTES_DIR = "extensions/ad_hoc/notes"

const ADHOC_INSTRUCTIONS = `# Ad-hoc notes extension

Files under \`notes/\` are memory update requests the user explicitly asked an agent to
remember. Each note is one small file named \`<timestamp>_<slug>.md\` describing something to
add, delete, or update in the memories.

How to consume them during consolidation:

- Treat each note as an authoritative user request; integrate its content into \`MEMORY.md\`
  (and \`memory_summary.md\` when it is broadly reusable).
- A note may ask to forget something: then remove the matching memory content.
- Notes are pruned automatically after a retention window, so consume them on sight —
  do not rely on them staying around.
`

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
  const adhocInstructions = path.join(root, EXTENSIONS_DIR, "ad_hoc", "instructions.md")
  if (!fs.existsSync(adhocInstructions)) fs.writeFileSync(adhocInstructions, ADHOC_INSTRUCTIONS, { flag: "w" })
}

const RAW_MEMORY_MAX_CHARS = 10_000

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return text.slice(0, limit) + "\n\n[truncated]"
}

// Codex-style rollout summary file stem: <timestamp>-<shorthash>-<slug>.
// The timestamp/hash prefix keeps names unique and chronologically sortable;
// the slug makes them human-scannable.
export function rolloutSummaryFileStem(o: Pick<Stage1Output, "session_id" | "source_updated_at" | "rollout_slug">): string {
  const ts = new Date(o.source_updated_at)
  const pad = (n: number) => String(n).padStart(2, "0")
  const timestamp = `${ts.getUTCFullYear()}-${pad(ts.getUTCMonth() + 1)}-${pad(ts.getUTCDate())}T${pad(ts.getUTCHours())}-${pad(ts.getUTCMinutes())}-${pad(ts.getUTCSeconds())}`
  let h = 0
  for (let i = 0; i < o.session_id.length; i++) {
    h = (h * 31 + o.session_id.charCodeAt(i)) >>> 0
  }
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
  let hash = ""
  let v = h % 36 ** 4
  for (let i = 0; i < 4; i++) {
    hash = alphabet[v % 36] + hash
    v = Math.floor(v / 36)
  }
  const prefix = `${timestamp}-${hash}`
  const slug = (o.rollout_slug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
    .replace(/_+$/g, "")
  return slug ? `${prefix}-${slug}` : prefix
}

export function rebuildRawMemories(outputs: Stage1Output[]): string {
  const sorted = [...outputs].sort((a, b) => a.session_id.localeCompare(b.session_id))
  let content = "# Raw Memories\n\n"
  if (sorted.length === 0) {
    content += "No raw memories yet.\n"
  } else {
    content += "Merged stage-1 raw memories (stable ascending session-id order):\n\n"
    for (const o of sorted) {
      content += `## Session \`${o.session_id}\`\n`
      content += `updated_at: ${new Date(o.source_updated_at).toISOString()}\n`
      content += `cwd: ${o.cwd ?? "unknown"}\n`
      content += `rollout_summary_file: ${rolloutSummaryFileStem(o)}.md\n\n`
      content += truncate(o.raw_memory.trim(), RAW_MEMORY_MAX_CHARS)
      content += "\n\n"
    }
  }
  fs.writeFileSync(path.join(memoryRoot(), RAW_MEMORIES_FILE), content, { flag: "w" })
  return content
}

export function writeRolloutSummaries(outputs: Stage1Output[]): void {
  const dir = path.join(memoryRoot(), ROLLOUT_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const keep = new Set(outputs.map((o) => `${rolloutSummaryFileStem(o)}.md`))
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(".md") && !keep.has(name)) {
      try { fs.unlinkSync(path.join(dir, name)) } catch {}
    }
  }
  for (const o of outputs) {
    const file = path.join(dir, `${rolloutSummaryFileStem(o)}.md`)
    const body =
      `session_id: ${o.session_id}\n` +
      `updated_at: ${new Date(o.source_updated_at).toISOString()}\n` +
      `cwd: ${o.cwd ?? "unknown"}\n` +
      `usage_count: ${o.usage_count}\n\n` +
      o.rollout_summary +
      "\n"
    fs.writeFileSync(file, body, { flag: "w" })
  }
}

// Resource filenames start with an ISO-like timestamp: 2026-07-03T05-11-22_slug.md
function resourceTimestamp(name: string): number | null {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!m) return null
  const ts = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  return Number.isNaN(ts) ? null : ts
}

// Prunes only timestamped .md resource/note files inside extension folders that
// have an instructions.md. Instructions and untimestamped files are never touched
// (mirrors codex's prune_old_extension_resources).
export function pruneExtensionResources(retentionDays: number): void {
  const extensionsDir = path.join(memoryRoot(), EXTENSIONS_DIR)
  if (!fs.existsSync(extensionsDir)) return
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  for (const extName of fs.readdirSync(extensionsDir)) {
    const extDir = path.join(extensionsDir, extName)
    let extStat
    try { extStat = fs.statSync(extDir) } catch { continue }
    if (!extStat.isDirectory()) continue
    if (!fs.existsSync(path.join(extDir, "instructions.md"))) continue
    for (const sub of ["resources", "notes"]) {
      const resDir = path.join(extDir, sub)
      let names: string[]
      try { names = fs.readdirSync(resDir) } catch { continue }
      for (const name of names) {
        if (!name.endsWith(".md")) continue
        const ts = resourceTimestamp(name)
        if (ts === null || ts > cutoff) continue
        try { fs.unlinkSync(path.join(resDir, name)) } catch {}
      }
    }
  }
}

const WORKSPACE_DIFF_MAX_BYTES = 4 * 1024 * 1024

// Renders the codex-style phase2_workspace_diff.md: a status listing plus a
// bounded unified diff for the consolidation agent to read.
export function writeWorkspaceDiff(diff: WorkspaceDiff): string {
  let rendered =
    "# Memory Workspace Diff\n\n" +
    "Generated by opencode-memex before Phase 2 memory consolidation. Read this file first and do not edit it.\n\n" +
    "## Status\n"
  if (diff.changes.length === 0) {
    rendered += "- none\n"
  } else {
    for (const change of diff.changes) {
      rendered += `- ${change.status} ${change.path}\n`
    }
    let body = diff.unifiedDiff
    if (body.length > WORKSPACE_DIFF_MAX_BYTES) {
      body = body.slice(0, WORKSPACE_DIFF_MAX_BYTES) + `\n[workspace diff truncated at ${WORKSPACE_DIFF_MAX_BYTES} bytes]\n`
    }
    rendered += "\n## Diff\n\n```diff\n" + body + (body.endsWith("\n") ? "" : "\n") + "```\n"
  }
  const file = path.join(memoryRoot(), DIFF_ARTIFACT)
  fs.writeFileSync(file, rendered, { flag: "w" })
  return file
}