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

  it("refuses to write rollout summaries through a symlinked directory", () => {
    const { writeRolloutSummaries } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    const root = memoryRoot()
    const outside = path.join(TEST_ROOT, "outside-rollouts")
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(root, "rollout_summaries"))

    expect(() => writeRolloutSummaries([OUTPUT])).toThrow("symlinks are not allowed")
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it("refuses to overwrite a symlinked generated artifact", () => {
    const { rebuildRawMemories } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    const root = memoryRoot()
    const outside = path.join(TEST_ROOT, "outside.md")
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(outside, "outside")
    fs.symlinkSync(outside, path.join(root, "raw_memories.md"))

    expect(() => rebuildRawMemories([OUTPUT])).toThrow("symlinks are not allowed")
    expect(fs.readFileSync(outside, "utf8")).toBe("outside")
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

  it("unlinks a symlinked extensions dir before seeding, without writing through it", () => {
    const { ensureLayout } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    const root = memoryRoot()
    const outside = path.join(TEST_ROOT, "outside-extensions")
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(root, "extensions"))

    ensureLayout()

    expect(fs.lstatSync(path.join(root, "extensions")).isDirectory()).toBe(true)
    expect(fs.lstatSync(path.join(root, "extensions")).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(root, "extensions", "ad_hoc"))).toBe(true)
    expect(fs.existsSync(path.join(outside, "ad_hoc"))).toBe(false)
  })

  it("replaces a symlinked MEMORY.md with a real seed file", () => {
    const { ensureLayout } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    const root = memoryRoot()
    const outside = path.join(TEST_ROOT, "outside-memory.md")
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(outside, "outside")
    fs.symlinkSync(outside, path.join(root, "MEMORY.md"))

    ensureLayout()

    expect(fs.lstatSync(path.join(root, "MEMORY.md")).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(outside, "utf8")).toBe("outside")
    expect(fs.readFileSync(path.join(root, "MEMORY.md"), "utf8")).toContain("# MEMORY.md")
  })

  it("caps the workspace diff in bytes, not UTF-16 code units", () => {
    const { ensureLayout, writeWorkspaceDiff } = require("../src/workspace.js")
    ensureLayout()
    // 3-byte chars: 2M chars = 6MiB > 4MiB cap, while .length (2M) stays under it.
    const multibyte = "\u20AC".repeat(2 * 1024 * 1024)
    const file = writeWorkspaceDiff({
      changes: [{ status: "M", path: "MEMORY.md" }],
      unifiedDiff: multibyte,
    })
    const written = fs.readFileSync(file, "utf8")
    expect(written).toContain("[workspace diff truncated at")
    // No split-character replacement glyphs before the truncation notice.
    expect(written).not.toContain("\uFFFD")
    expect(Buffer.byteLength(written, "utf8")).toBeLessThan(5 * 1024 * 1024)
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

  it("rejects consolidated artifacts that are symlinks", () => {
    const { ensureLayout, validateConsolidationArtifacts } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    const outsideMemory = path.join(TEST_ROOT, "outside-memory.md")
    const outsideSummary = path.join(TEST_ROOT, "outside-summary.md")
    fs.writeFileSync(outsideMemory, "# valid-looking memory\n")
    fs.writeFileSync(outsideSummary, "v1\n\nvalid-looking summary\n")

    fs.rmSync(path.join(memoryRoot(), "MEMORY.md"))
    fs.symlinkSync(outsideMemory, path.join(memoryRoot(), "MEMORY.md"))
    let result = validateConsolidationArtifacts()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/removed 1 symbolic links/)
    expect(fs.existsSync(path.join(memoryRoot(), "MEMORY.md"))).toBe(false)
    expect(fs.readFileSync(outsideMemory, "utf8")).toBe("# valid-looking memory\n")

    fs.writeFileSync(path.join(memoryRoot(), "MEMORY.md"), "# MEMORY.md\n")
    fs.rmSync(path.join(memoryRoot(), "memory_summary.md"))
    fs.symlinkSync(outsideSummary, path.join(memoryRoot(), "memory_summary.md"))
    result = validateConsolidationArtifacts()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/removed 1 symbolic links/)
    expect(fs.existsSync(path.join(memoryRoot(), "memory_summary.md"))).toBe(false)
    expect(fs.readFileSync(outsideSummary, "utf8")).toBe("v1\n\nvalid-looking summary\n")
  })

  it("fails validation when a nested worker symlink is present, without writing through it", () => {
    const { ensureLayout, validateConsolidationArtifacts } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    fs.writeFileSync(path.join(memoryRoot(), "memory_summary.md"), "v1\n\n## User Profile\n")
    const outside = path.join(TEST_ROOT, "outside-instructions.md")
    fs.writeFileSync(outside, "outside content")
    const link = path.join(memoryRoot(), "extensions", "external_agent_import", "instructions.md")
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(outside, link)

    const result = validateConsolidationArtifacts()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/removed 1 symbolic links/)
    expect(fs.existsSync(link)).toBe(false)
    expect(fs.readFileSync(outside, "utf8")).toBe("outside content")
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

  it("does not prune through a symlinked resources directory", () => {
    const { ensureLayout, pruneExtensionResources } = require("../src/workspace.js")
    const { memoryRoot } = require("../src/paths.js")
    ensureLayout()
    const extDir = path.join(memoryRoot(), "extensions", "unsafe")
    const outside = path.join(TEST_ROOT, "outside-resources")
    fs.mkdirSync(extDir)
    fs.writeFileSync(path.join(extDir, "instructions.md"), "instructions")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "2020-01-01T00-00-00-old.md"), "keep")
    fs.symlinkSync(outside, path.join(extDir, "resources"))

    pruneExtensionResources(7)
    expect(fs.readFileSync(path.join(outside, "2020-01-01T00-00-00-old.md"), "utf8")).toBe("keep")
  })
})
