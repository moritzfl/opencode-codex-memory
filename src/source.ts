import fs from "fs"
import path from "path"
import { currentMemoryVersion } from "./memory-version.js"
import { memoryRoot } from "./paths.js"
import { assertMemoryRootSafe, safeResolveMemoryPath, withRegularFileNoFollow } from "./path-guard.js"
import { MEMORY_V2_SUMMARY_MAX_BYTES, truncateToBytes, truncateToTokens } from "./token.js"
import { fillTemplate } from "./llm.js"

const MEMORY_SUMMARY_TOKEN_LIMIT = 2500
const READ_PATH_TEMPLATE = "read_path.md"
const READ_PATH_TEMPLATE_V2 = "read_path_v2.md"

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

const SEARCH_STEP_TOOLS_V2 = `Call \`memory_search\`, \`memory_read\`, \`memory_list\`, and \`memory_add_note\` directly. They are normal tools in this chat, not tools inside \`execute\`.
Search {{ base_path }}/rollout_summaries/ with the \`memory_search\`
   tool, or read a recap with \`memory_read\`, when extra evidence, wording,
   chronology, or uncertainty could change your answer.
   - For time-scoped recall ("what was I working on last week / around date X"),
     pass \`since\`/\`until\` to \`memory_search\` — with a query it searches only that
     period's sessions/notes; without a query it lists them chronologically.`

const SEARCH_STEP_FILES_V2 = `Search {{ base_path }}/rollout_summaries/ using those keywords when a needed route is missing.`

// OpenCode has a native `skill` tool; codex does not. Memory skills are plain
// files, so a `skill` call by their name fails before the runbook is read.
const SKILL_STEP_TOOLS = `   Files under {{ base_path }}/skills/ are memory runbooks, not OpenCode skills:
   open \`SKILL.md\` with memory_read (or a file read), never with the \`skill\` tool.`

const SKILL_STEP_FILES = `   Files under {{ base_path }}/skills/ are memory runbooks, not OpenCode skills:
   open \`SKILL.md\` with a file read, never with the \`skill\` tool.`

// Consolidated summaries link skills as `[skill](skills/…)`, which models read
// as a `skill` tool handle. Inject them as plain runbook paths instead.
const SKILL_LINK = /\[skill\]\((skills\/[^)\s]+)\)/g

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
  /** mtime alone misses same-mtime rewrites on coarse-timestamp filesystems. */
  identity: string
}

const cache = new Map<string, CachedSummary>()
// Shipped templates never change while the plugin runs; read once per version.
const templates = new Map<string, string>()

function readTemplate(): string {
  const name = currentMemoryVersion() === "v2" ? READ_PATH_TEMPLATE_V2 : READ_PATH_TEMPLATE
  let template = templates.get(name)
  if (template === undefined) {
    template = fs.readFileSync(path.join(import.meta.dirname, "templates", name), "utf8")
    templates.set(name, template)
  }
  return template
}

function readMemorySummary(): string | null {
  try {
    // Use the same component-by-component symlink refusal as the memory tools:
    // neither the root nor memory_summary.md may redirect outside the workspace.
    const summaryPath = safeResolveMemoryPath("memory_summary.md")
    return withRegularFileNoFollow(summaryPath, fs.constants.O_RDONLY, (fd, stat) => {
      const identity = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
      const cached = cache.get(summaryPath)
      if (cached && cached.identity === identity) {
        return cached.content
      }

      const raw = fs.readFileSync(fd, "utf8").trim().replace(SKILL_LINK, "runbook `$1`")
      if (!raw) return null

      const truncated = currentMemoryVersion() === "v2"
        ? truncateToBytes(raw, MEMORY_V2_SUMMARY_MAX_BYTES)
        : truncateToTokens(raw, MEMORY_SUMMARY_TOKEN_LIMIT)
      cache.set(summaryPath, { content: truncated, identity })
      return truncated
    })
  } catch {
    return null
  }
}

export function invalidateCache(): void {
  cache.clear()
}

export function buildMemorySystemPrompt(dedicatedTools: boolean): string | null {
  const summary = readMemorySummary()
  if (!summary) return null

  const template = readTemplate()
  const v2 = currentMemoryVersion() === "v2"
  const searchStep = dedicatedTools
    ? (v2 ? SEARCH_STEP_TOOLS_V2 : SEARCH_STEP_TOOLS)
    : (v2 ? SEARCH_STEP_FILES_V2 : SEARCH_STEP_FILES)
  return fillTemplate(template, {
    search_step: searchStep,
    skill_step: dedicatedTools ? SKILL_STEP_TOOLS : SKILL_STEP_FILES,
    update_instructions: dedicatedTools ? UPDATE_INSTRUCTIONS_TOOLS : UPDATE_INSTRUCTIONS_FILES,
    // Filled last so {{ base_path }} nested inside the snippets above resolves.
    base_path: memoryRoot(),
    memory_summary: summary,
  })
}

export function ensureMemoryLayout(): void {
  const root = assertMemoryRootSafe()
  fs.mkdirSync(root, { recursive: true })
}
