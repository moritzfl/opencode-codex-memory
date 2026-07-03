import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-memex-git-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(path.join(TEST_ROOT, "memories"), { recursive: true })
  process.env.OPENCODE_MEMEX_TEST_ROOT = TEST_ROOT
})
afterEach(() => {
  delete process.env.OPENCODE_MEMEX_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
})

function memFile(rel: string): string {
  return path.join(TEST_ROOT, "memories", rel)
}

function statusLines(diff: { changes: { status: string; path: string }[] }): string[] {
  return diff.changes.map((c) => `${c.status} ${c.path}`).sort()
}

describe("git-baseline", () => {
  it("captures adds/modifies/deletes with content diffs across baseline cycles", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")

    fs.writeFileSync(memFile("a.md"), "one\n")
    fs.writeFileSync(memFile("b.md"), "two\n")
    expect(await ensureBaseline()).toBe(true)
    expect((await captureWorkspaceDiff()).changes).toEqual([])

    fs.writeFileSync(memFile("a.md"), "one changed\n")
    fs.unlinkSync(memFile("b.md"))
    fs.writeFileSync(memFile("c.md"), "three\n")

    const diff = await captureWorkspaceDiff()
    expect(statusLines(diff)).toEqual(["A c.md", "D b.md", "M a.md"])
    expect(diff.unifiedDiff).toContain("-one")
    expect(diff.unifiedDiff).toContain("+one changed")
    expect(diff.unifiedDiff).toContain("-two")
    expect(diff.unifiedDiff).toContain("+three")

    // committing a workspace containing a deletion must not throw
    expect(await resetBaseline()).toBe(true)
    expect((await captureWorkspaceDiff()).changes).toEqual([])
  })

  it("diffs against empty content before the first commit exists", async () => {
    const { captureWorkspaceDiff } = require("../src/git-baseline.js")
    fs.writeFileSync(memFile("first.md"), "hello\n")
    const diff = await captureWorkspaceDiff()
    expect(statusLines(diff)).toEqual(["A first.md"])
    expect(diff.unifiedDiff).toContain("+hello")
  })

  it("ensureBaseline commits pre-existing deletions instead of failing", async () => {
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    fs.writeFileSync(memFile("stale.md"), "old summary\n")
    expect(await ensureBaseline()).toBe(true)
    fs.unlinkSync(memFile("stale.md"))
    expect(await ensureBaseline()).toBe(true)
    expect((await captureWorkspaceDiff()).changes).toEqual([])
  })

  it("removes the phase2 diff artifact before diffing and committing", async () => {
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    expect(await ensureBaseline()).toBe(true)
    fs.writeFileSync(memFile("phase2_workspace_diff.md"), "stale artifact\n")
    fs.writeFileSync(memFile("real.md"), "content\n")
    const diff = await captureWorkspaceDiff()
    expect(statusLines(diff)).toEqual(["A real.md"])
    expect(fs.existsSync(memFile("phase2_workspace_diff.md"))).toBe(false)
  })

  it("replaces oversized per-file patches with a stub", async () => {
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    expect(await ensureBaseline()).toBe(true)
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n")
    fs.writeFileSync(memFile("big.md"), big)
    fs.writeFileSync(memFile("small.md"), "tiny\n")
    const diff = await captureWorkspaceDiff()
    expect(diff.unifiedDiff).toContain("[diff omitted:")
    expect(diff.unifiedDiff).toContain("+tiny")
  })
})

describe("writeWorkspaceDiff", () => {
  it("renders status and fenced unified diff", () => {
    const { writeWorkspaceDiff } = require("../src/workspace.js")
    const file = writeWorkspaceDiff({
      changes: [{ status: "M", path: "raw_memories.md" }],
      unifiedDiff: "--- a\n+++ b\n+new line\n",
    })
    const content = fs.readFileSync(file, "utf8")
    expect(content).toContain("## Status")
    expect(content).toContain("- M raw_memories.md")
    expect(content).toContain("## Diff")
    expect(content).toContain("+new line")
  })
})
