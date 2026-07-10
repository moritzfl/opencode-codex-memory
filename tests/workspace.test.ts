import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-ws-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
})

const OUTPUT = {
  session_id: "ses_abc",
  source_updated_at: Date.UTC(2026, 6, 3, 5, 11, 22),
  raw_memory: "### Task 1: fix build\n\nReusable knowledge:\n- bun run build works",
  rollout_summary: "# Fixed the build\n\n## Task 1: fix build\nOutcome: success",
  rollout_slug: "Fix Build!",
  cwd: "/Users/x/proj",
  generated_at: Date.UTC(2026, 6, 3, 6, 0, 0),
  usage_count: 2,
  last_usage: null,
}

describe("rolloutSummaryFileStem", () => {
  it("builds a timestamp-hash-slug stem", () => {
    const { rolloutSummaryFileStem } = require("../src/workspace.js")
    const stem = rolloutSummaryFileStem(OUTPUT)
    expect(stem).toMatch(/^2026-07-03T05-11-22-[0-9a-z]{4}-fix_build$/)
  })

  it("is stable for the same session and omits an empty slug", () => {
    const { rolloutSummaryFileStem } = require("../src/workspace.js")
    expect(rolloutSummaryFileStem(OUTPUT)).toBe(rolloutSummaryFileStem({ ...OUTPUT }))
    const noSlug = rolloutSummaryFileStem({ ...OUTPUT, rollout_slug: null })
    expect(noSlug).toMatch(/^2026-07-03T05-11-22-[0-9a-z]{4}$/)
  })
})

describe("workspace rendering", () => {
  it("renders raw_memories.md with session metadata and summary-file pointer", () => {
    const { ensureLayout, rebuildRawMemories, rolloutSummaryFileStem } = require("../src/workspace.js")
    ensureLayout()
    const content = rebuildRawMemories([OUTPUT])
    expect(content).toContain("## Session `ses_abc`")
    expect(content).toContain("cwd: /Users/x/proj")
    expect(content).toContain(`rollout_summary_file: ${rolloutSummaryFileStem(OUTPUT)}.md`)
    expect(content).toContain("bun run build works")
  })

  it("writes summary files under the stem name and prunes stale ones", () => {
    const { ensureLayout, writeRolloutSummaries, rolloutSummaryFileStem } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    const dir = path.join(memoryRoot(), "rollout_summaries")
    fs.writeFileSync(path.join(dir, "stale.md"), "old")
    writeRolloutSummaries([OUTPUT])
    const names = fs.readdirSync(dir)
    expect(names).toEqual([`${rolloutSummaryFileStem(OUTPUT)}.md`])
    const body = fs.readFileSync(path.join(dir, names[0]), "utf8")
    expect(body).toContain("session_id: ses_abc")
    expect(body).toContain("cwd: /Users/x/proj")
  })

  it("writes the empty-input placeholder when no outputs are selected", () => {
    const { ensureLayout, rebuildRawMemories } = require("../src/workspace.js")
    ensureLayout()
    expect(rebuildRawMemories([])).toContain("No raw memories yet.")
  })

  it("seeds the ad_hoc extension instructions", () => {
    const { ensureLayout } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    const p = path.join(memoryRoot(), "extensions", "ad_hoc", "instructions.md")
    expect(fs.existsSync(p)).toBe(true)
  })
})

describe("validateConsolidationArtifacts", () => {
  it("rejects missing MEMORY.md, empty summary, and non-v1 header", () => {
    const { ensureLayout, validateConsolidationArtifacts } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    // ensureLayout seeds empty summary → invalid
    let r = validateConsolidationArtifacts()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/does not start with v1/)

    fs.writeFileSync(path.join(memoryRoot(), "memory_summary.md"), "v1\n\n## User Profile\n")
    r = validateConsolidationArtifacts()
    expect(r.ok).toBe(true)

    fs.unlinkSync(path.join(memoryRoot(), "MEMORY.md"))
    r = validateConsolidationArtifacts()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/missing consolidated memory/)
  })

  it("rejects a directory named MEMORY.md", () => {
    const { ensureLayout, validateConsolidationArtifacts } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    fs.unlinkSync(path.join(memoryRoot(), "MEMORY.md"))
    fs.mkdirSync(path.join(memoryRoot(), "MEMORY.md"))
    fs.writeFileSync(path.join(memoryRoot(), "memory_summary.md"), "v1\n")
    const r = validateConsolidationArtifacts()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a file/)
  })
})

describe("pruneExtensionResources", () => {
  it("prunes old timestamped resources but never notes or instructions.md", () => {
    const { ensureLayout, pruneExtensionResources } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    const notes = path.join(memoryRoot(), "extensions", "ad_hoc", "notes")
    const resources = path.join(memoryRoot(), "extensions", "ad_hoc", "resources")
    fs.mkdirSync(resources, { recursive: true })
    // Notes are explicit user requests: codex never prunes them.
    fs.writeFileSync(path.join(notes, "2020-01-01T00-00-00-old-note.md"), "old")
    fs.writeFileSync(path.join(resources, "2020-01-01T00-00-00_old-res.md"), "old")
    fs.writeFileSync(path.join(resources, "2999-01-01T00-00-00_future-res.md"), "new")
    fs.writeFileSync(path.join(resources, "untimestamped.md"), "keep")
    pruneExtensionResources(7)
    expect(fs.readdirSync(notes).sort()).toEqual(["2020-01-01T00-00-00-old-note.md"])
    expect(fs.readdirSync(resources).sort()).toEqual(["2999-01-01T00-00-00_future-res.md", "untimestamped.md"])
    expect(fs.existsSync(path.join(memoryRoot(), "extensions", "ad_hoc", "instructions.md"))).toBe(true)
  })
})
