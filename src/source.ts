import fs from "fs"
import path from "path"
import { memorySummaryPath, memoryRoot } from "./paths.js"
import { truncateToTokens } from "./token.js"
import { fillTemplate } from "./llm.js"

const MEMORY_SUMMARY_TOKEN_LIMIT = 2500
const READ_PATH_TEMPLATE = "read_path.md"

// Tool-dependent guidance for read_path.md. With dedicated_tools on, the
// prompt points at the memory_* tools (our platform adaptation — the memory
// dir lives outside the workspace). With them off, it falls back to codex's
// own wording: the agent reads/writes the memory files directly.
const SEARCH_STEP_TOOLS = `2. Search {{ base_path }}/MEMORY.md for those keywords with the \`memory_search\`
   tool, or read it with \`memory_read\`.
   - For time-scoped recall ("what was I working on last week / around date X"),
     pass \`since\`/\`until\` to \`memory_search\` — with a query it searches only that
     period's sessions/notes; without a query it lists them chronologically.`

const SEARCH_STEP_FILES = `2. Search {{ base_path }}/MEMORY.md using those keywords.`

const UPDATE_INSTRUCTIONS_TOOLS = `Use the \`memory_add_note\` tool, which writes
one small note file under \`extensions/ad_hoc/notes/\` describing what to
add/delete/update. Do not edit the memory files yourself; the consolidation
pass will integrate the note.`

const UPDATE_INSTRUCTIONS_FILES = `- Write your update in {{ base_path }}/extensions/ad_hoc/notes/
- Each update must be one small file containing what you want to add/delete/update from the memories.
- The name of this file must be \`<timestamp>-<short slug>.md\`
- Do not edit the other memory files yourself; the consolidation pass will
  integrate the note.`

interface CachedSummary {
  content: string
  mtime: number
}

let cached: CachedSummary | null = null

function readTemplate(): string {
  const templatePath = path.join(import.meta.dirname, "templates", READ_PATH_TEMPLATE)
  return fs.readFileSync(templatePath, "utf8")
}

function readMemorySummary(): string | null {
  const summaryPath = memorySummaryPath()
  if (!fs.existsSync(summaryPath)) return null

  const stat = fs.statSync(summaryPath)
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.content
  }

  const raw = fs.readFileSync(summaryPath, "utf8").trim()
  if (!raw) return null

  const truncated = truncateToTokens(raw, MEMORY_SUMMARY_TOKEN_LIMIT)
  cached = {
    content: truncated,
    mtime: stat.mtimeMs,
  }
  return truncated
}

export function invalidateCache(): void {
  cached = null
}

export function buildMemorySystemPrompt(dedicatedTools: boolean): string | null {
  const summary = readMemorySummary()
  if (!summary) return null

  const template = readTemplate()
  return fillTemplate(template, {
    search_step: dedicatedTools ? SEARCH_STEP_TOOLS : SEARCH_STEP_FILES,
    update_instructions: dedicatedTools ? UPDATE_INSTRUCTIONS_TOOLS : UPDATE_INSTRUCTIONS_FILES,
    // Filled last so {{ base_path }} nested inside the snippets above resolves.
    base_path: memoryRoot(),
    memory_summary: summary,
  })
}

export function ensureMemoryLayout(): void {
  fs.mkdirSync(memoryRoot(), { recursive: true })
}