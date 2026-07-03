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

describe("git-baseline", () => {
  it("captures adds/modifies/deletes across baseline cycles", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")

    fs.writeFileSync(memFile("a.md"), "one")
    fs.writeFileSync(memFile("b.md"), "two")
    expect(await ensureBaseline()).toBe(true)
    expect((await captureWorkspaceDiff()).trim()).toBe("")

    fs.writeFileSync(memFile("a.md"), "one changed")
    fs.unlinkSync(memFile("b.md"))
    fs.writeFileSync(memFile("c.md"), "three")

    const diff = await captureWorkspaceDiff()
    const lines = diff.split("\n").sort()
    expect(lines).toEqual(["A c.md", "D b.md", "M a.md"])

    // committing a workspace containing a deletion must not throw
    expect(await resetBaseline()).toBe(true)
    expect((await captureWorkspaceDiff()).trim()).toBe("")
  })

  it("ensureBaseline commits pre-existing deletions instead of failing", async () => {
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    fs.writeFileSync(memFile("stale.md"), "old summary")
    expect(await ensureBaseline()).toBe(true)
    fs.unlinkSync(memFile("stale.md"))
    expect(await ensureBaseline()).toBe(true)
    expect((await captureWorkspaceDiff()).trim()).toBe("")
  })

  it("excludes the phase2 diff artifact from the captured diff", async () => {
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    expect(await ensureBaseline()).toBe(true)
    fs.writeFileSync(memFile("phase2_workspace_diff.md"), "M raw_memories.md")
    fs.writeFileSync(memFile("real.md"), "content")
    const diff = await captureWorkspaceDiff()
    expect(diff.trim()).toBe("A real.md")
  })
})
