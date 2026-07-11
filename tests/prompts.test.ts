import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-prompts-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {}
})

const PLACEHOLDER_RE = /\{\{ [a-z0-9_]+ \}\}/

describe("buildConsolidationPrompt", () => {
  it("fills every placeholder including the memory-extension blocks", () => {
    const { ensureLayout } = require("../src/workspace.js")
    const { buildConsolidationPrompt } = require("../src/llm.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    const prompt = buildConsolidationPrompt(memoryRoot(), "phase2_workspace_diff.md")
    expect(prompt).not.toMatch(PLACEHOLDER_RE)
    // ensureLayout creates extensions/ → codex renders both extension blocks
    expect(prompt).toContain("Memory extensions (under")
    expect(prompt).toContain("Optional source-specific inputs:")
    expect(prompt).toContain(path.join(memoryRoot(), "extensions"))
    expect(prompt).toContain("phase2_workspace_diff.md")
  })

  it("renders empty extension blocks when extensions/ does not exist", () => {
    const { buildConsolidationPrompt } = require("../src/llm.js")
    const { memoryRoot } = require("../src/paths.js")
    fs.mkdirSync(memoryRoot(), { recursive: true })
    const prompt = buildConsolidationPrompt(memoryRoot(), "phase2_workspace_diff.md")
    expect(prompt).not.toMatch(PLACEHOLDER_RE)
    expect(prompt).not.toContain("Memory extensions (under")
  })
})

describe("buildMemorySystemPrompt (read_path.md)", () => {
  it("keeps the port's citation contract and memory tool guidance", () => {
    const { ensureMemoryLayout, buildMemorySystemPrompt } = require("../src/source.js")
    const { memorySummaryPath } = require("../src/paths.js")
    ensureMemoryLayout()
    fs.writeFileSync(memorySummaryPath(), "v1\n\n## User Profile\ntest\n")
    const prompt = buildMemorySystemPrompt(true)!
    expect(prompt).not.toMatch(PLACEHOLDER_RE)
    // citation.ts parses these exact tags — read_path must instruct them
    expect(prompt).toContain("<memory-citation>")
    expect(prompt).toContain("<session_ids>")
    expect(prompt).not.toContain("oai-mem-citation")
    expect(prompt).not.toContain("rollout_ids")
    // the memory dir lives outside the workspace: tools are the read/write path
    expect(prompt).toContain("memory_search")
    expect(prompt).toContain("memory_read")
    expect(prompt).toContain("memory_add_note")
  })

  it("falls back to codex's file-based guidance when dedicated_tools is off", () => {
    const { ensureMemoryLayout, buildMemorySystemPrompt } = require("../src/source.js")
    const { memorySummaryPath, memoryRoot } = require("../src/paths.js")
    ensureMemoryLayout()
    fs.writeFileSync(memorySummaryPath(), "v1\n\n## User Profile\ntest\n")
    const prompt = buildMemorySystemPrompt(false)!
    expect(prompt).not.toMatch(PLACEHOLDER_RE)
    // no references to tools that are not registered
    expect(prompt).not.toContain("memory_search")
    expect(prompt).not.toContain("memory_read")
    expect(prompt).not.toContain("memory_add_note")
    // codex-style direct file access instead
    expect(prompt).toContain(`Search ${memoryRoot()}/MEMORY.md using those keywords.`)
    expect(prompt).toContain(`Write your update in ${memoryRoot()}/extensions/ad_hoc/notes/`)
    // citation contract is tool-independent and must survive
    expect(prompt).toContain("<memory-citation>")
    expect(prompt).toContain("<session_ids>")
  })
})

describe("template placeholder inventory", () => {
  it("templates contain only placeholders the code fills", () => {
    const dir = path.join(import.meta.dirname, "..", "src", "templates")
    const known: Record<string, string[]> = {
      "read_path.md": ["base_path", "memory_summary", "search_step", "update_instructions"],
      "consolidation.md": [
        "memory_root",
        "phase2_workspace_diff_file",
        "memory_extensions_folder_structure",
        "memory_extensions_primary_inputs",
      ],
      "stage_one_input.md": ["session_id", "session_cwd", "transcript"],
      "stage_one_system.md": [],
    }
    for (const [file, allowed] of Object.entries(known)) {
      const text = fs.readFileSync(path.join(dir, file), "utf8")
      const found = [...text.matchAll(/\{\{ ([a-z0-9_]+) \}\}/g)].map((m) => m[1])
      const unexpected = found.filter((name) => !allowed.includes(name))
      expect({ file, unexpected }).toEqual({ file, unexpected: [] })
    }
  })
})
