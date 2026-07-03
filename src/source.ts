import fs from "fs"
import path from "path"
import { memorySummaryPath, memoryRoot } from "./paths.js"
import { truncateToTokens } from "./token.js"
import { fillTemplate } from "./llm.js"

const MEMORY_SUMMARY_TOKEN_LIMIT = 2500
const READ_PATH_TEMPLATE = "read_path.md"

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

export function buildMemorySystemPrompt(): string | null {
  const summary = readMemorySummary()
  if (!summary) return null

  const template = readTemplate()
  return fillTemplate(template, {
    base_path: memoryRoot(),
    memory_summary: summary,
  })
}

export function ensureMemoryLayout(): void {
  const root = memoryRoot()
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true })
  }
}