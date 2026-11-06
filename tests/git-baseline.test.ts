import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-git-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(path.join(TEST_ROOT, "memories"), { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {}
})

function memFile(rel: string): string {
  return path.join(TEST_ROOT, "memories", rel)
}

function statusLines(diff: { changes: { status: string; path: string }[] }): string[] {
  return diff.changes.map((c) => `${c.status} ${c.path}`).sort()
}

describe("git-baseline", () => {
  it("keeps notes written during consolidation out of the reset baseline", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")
    const notes = path.join("extensions", "ad_hoc", "notes")
    fs.mkdirSync(memFile(notes), { recursive: true })
    fs.writeFileSync(memFile("MEMORY.md"), "v1\n")
    fs.writeFileSync(memFile(path.join(notes, "old.md")), "old\n")
    fs.writeFileSync(memFile(path.join(notes, "edited.md")), "before\n")
    expect(await ensureBaseline()).toBe(true)
    // A successful run commits the current tree; the next diff starts there.
    expect(await resetBaseline()).toBe(true)

    fs.writeFileSync(memFile(path.join(notes, "seen.md")), "seen\n")
    const diff = await captureWorkspaceDiff()
    expect(statusLines(diff)).toEqual([`A ${notes}/seen.md`])
    // Consolidator turn: memory edited, and a note arrives mid-run.
    fs.writeFileSync(memFile("MEMORY.md"), "v2\n")
    fs.writeFileSync(memFile(path.join(notes, "late.md")), "late\n")
    fs.writeFileSync(memFile(path.join(notes, "edited.md")), "after\n")
    expect(await resetBaseline(diff.extensionSnapshot)).toBe(true)

    expect(statusLines(await captureWorkspaceDiff())).toEqual([`A ${notes}/edited.md`, `A ${notes}/late.md`])
  })

  it("ignores hidden files such as .DS_Store instead of failing the diff", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")
    const isogit = require("isomorphic-git")
    const { memoryRoot } = require("../src/paths.js")

    fs.writeFileSync(memFile("keep.md"), "ok\n")
    fs.writeFileSync(memFile(".DS_Store"), "finder junk")
    fs.mkdirSync(memFile("skills"), { recursive: true })
    fs.writeFileSync(memFile(path.join("skills", ".DS_Store")), "nested junk")
    expect(await ensureBaseline()).toBe(true)
    expect(await resetBaseline()).toBe(true)
    expect(await isogit.listFiles({ fs, dir: memoryRoot() })).toEqual(["keep.md"])

    fs.writeFileSync(memFile(".DS_Store"), "finder junk changed")
    fs.writeFileSync(memFile("keep.md"), "ok2\n")
    const diff = await captureWorkspaceDiff()
    expect(statusLines(diff)).toEqual(["M keep.md"])
    expect(diff.unifiedDiff).not.toContain(".DS_Store")

    expect(await resetBaseline()).toBe(true)
    expect(await isogit.listFiles({ fs, dir: memoryRoot() })).toEqual(["keep.md"])
  })

  it("does not treat a new .DS_Store as a workspace change", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")
    fs.writeFileSync(memFile("keep.md"), "ok\n")
    expect(await ensureBaseline()).toBe(true)
    expect(await resetBaseline()).toBe(true)
    fs.writeFileSync(memFile(".DS_Store"), "\0binary")
    const diff = await captureWorkspaceDiff()
    expect(diff.changes).toEqual([])
  })

  it("captures adds/modifies/deletes with content diffs across baseline cycles", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")

    fs.writeFileSync(memFile("a.md"), "one\n")
    fs.writeFileSync(memFile("b.md"), "two\n")
    // codex ensure_git_baseline_repository starts empty: pre-existing files
    // stay visible to consolidation as additions.
    expect(await ensureBaseline()).toBe(true)
    expect(statusLines(await captureWorkspaceDiff())).toEqual(["A a.md", "A b.md"])
    expect(await resetBaseline()).toBe(true)
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

  it("ensureBaseline preserves an existing baseline so pre-existing changes stay in the diff", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")
    fs.writeFileSync(memFile("stale.md"), "old summary\n")
    expect(await ensureBaseline()).toBe(true)
    expect(await resetBaseline()).toBe(true)
    // Changes made since the last baseline (user edits, ad-hoc notes) must NOT
    // be swallowed by a fresh commit — codex keeps the baseline untouched so
    // consolidation sees them in the diff.
    fs.unlinkSync(memFile("stale.md"))
    fs.writeFileSync(memFile("note.md"), "remember this\n")
    expect(await ensureBaseline()).toBe(true)
    const diff = await captureWorkspaceDiff()
    expect(statusLines(diff)).toEqual(["A note.md", "D stale.md"])
  })

  it("resetBaseline drops previous git history", async () => {
    const { ensureBaseline, resetBaseline } = require("../src/git-baseline.js")
    const isogit = require("isomorphic-git")
    const { memoryRoot } = require("../src/paths.js")
    fs.writeFileSync(memFile("secret.md"), "leaked token\n")
    expect(await ensureBaseline()).toBe(true)
    fs.unlinkSync(memFile("secret.md"))
    fs.writeFileSync(memFile("clean.md"), "ok\n")
    expect(await resetBaseline()).toBe(true)
    // Fresh single-commit history: deleted content is not recoverable.
    const log = await isogit.log({ fs, dir: memoryRoot() })
    expect(log.length).toBe(1)
  })

  it("ensureBaseline recovers a corrupt .git with an empty baseline (codex reset_git_repository_sync)", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")
    fs.writeFileSync(memFile("a.md"), "one\n")
    expect(await ensureBaseline()).toBe(true)
    expect(await resetBaseline()).toBe(true)
    // Corrupt the repo metadata: without self-heal every phase-2 run would
    // fail forever (codex re-inits a fresh baseline instead).
    fs.writeFileSync(path.join(TEST_ROOT, "memories", ".git", "HEAD"), "garbage")
    expect(await ensureBaseline()).toBe(true)
    // Recovery must not treat existing memory files as already processed.
    expect(statusLines(await captureWorkspaceDiff())).toEqual(["A a.md"])
  })

  it("writes the baseline version marker and migrates an unversioned baseline to empty", async () => {
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    const isogit = require("isomorphic-git")
    const { memoryRoot } = require("../src/paths.js")
    fs.writeFileSync(memFile("legacy.md"), "old\n")
    // Legacy baseline: commit contents without the version marker.
    await isogit.init({ fs, dir: memoryRoot() })
    await isogit.add({ fs, dir: memoryRoot(), filepath: "legacy.md" })
    await isogit.commit({
      fs,
      dir: memoryRoot(),
      message: "legacy baseline",
      author: { name: "t", email: "t@example.com" },
    })

    expect(await ensureBaseline()).toBe(true)
    expect(fs.readFileSync(path.join(TEST_ROOT, "memories", ".git", "codex-baseline-version"), "utf8")).toBe("1\n")
    expect(await isogit.listFiles({ fs, dir: memoryRoot() })).toEqual([])
    expect(statusLines(await captureWorkspaceDiff())).toEqual(["A legacy.md"])
  })

  it("skips files above the baseline snapshot limit", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")
    const isogit = require("isomorphic-git")
    const { memoryRoot } = require("../src/paths.js")
    fs.writeFileSync(memFile("small.md"), "tiny\n")
    fs.writeFileSync(memFile("big.md"), "")
    fs.truncateSync(memFile("big.md"), 10 * 1024 * 1024 + 1)

    expect(await ensureBaseline()).toBe(true)
    expect(await resetBaseline()).toBe(true)
    expect(await isogit.listFiles({ fs, dir: memoryRoot() })).toEqual(["small.md"])
    expect((await captureWorkspaceDiff()).changes).toEqual([])

    fs.writeFileSync(memFile("small.md"), "tiny changed\n")
    expect(statusLines(await captureWorkspaceDiff())).toEqual(["M small.md"])
  })

  it("invalidates the baseline when a tracked file grows past the limit", async () => {
    const { ensureBaseline, captureWorkspaceDiff, resetBaseline } = require("../src/git-baseline.js")
    fs.writeFileSync(memFile("tracked.md"), "small\n")
    expect(await ensureBaseline()).toBe(true)
    expect(await resetBaseline()).toBe(true)

    fs.truncateSync(memFile("tracked.md"), 10 * 1024 * 1024 + 1)
    fs.writeFileSync(memFile("other.md"), "visible\n")
    // Baseline is rebuilt empty; the oversized input is skipped and the
    // remaining files stay visible as additions.
    expect(statusLines(await captureWorkspaceDiff())).toEqual(["A other.md"])
  })

  it("does not recurse into .git (symlink cycles / Windows junctions hang phase 2)", async () => {
    const { ensureBaseline } = require("../src/git-baseline.js")
    fs.writeFileSync(memFile("a.md"), "x\n")
    expect(await ensureBaseline()).toBe(true)
    const objects = path.join(TEST_ROOT, "memories", ".git", "objects")
    fs.mkdirSync(objects, { recursive: true })
    fs.symlinkSync(TEST_ROOT, path.join(objects, "loop"))
    const started = Date.now()
    expect(await ensureBaseline()).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("replaces symlinked git metadata without writing through it", async () => {
    const { ensureBaseline } = require("../src/git-baseline.js")
    const outside = path.join(TEST_ROOT, "outside-git")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "sentinel"), "untouched")
    fs.symlinkSync(outside, memFile(".git"))

    expect(await ensureBaseline()).toBe(true)
    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("untouched")
    expect(fs.lstatSync(memFile(".git")).isSymbolicLink()).toBe(false)
  })

  it("fails closed instead of diffing content through a workdir symlink", async () => {
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    const outside = path.join(TEST_ROOT, "outside-memory.md")
    fs.writeFileSync(memFile("memory.md"), "inside\n")
    fs.writeFileSync(outside, "outside secret\n")
    expect(await ensureBaseline()).toBe(true)
    fs.unlinkSync(memFile("memory.md"))
    fs.symlinkSync(outside, memFile("memory.md"))

    await expect(captureWorkspaceDiff()).rejects.toThrow(/symlink|non-regular/)
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

  it("renders large per-file patches in full (only the global cap truncates)", async () => {
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    expect(await ensureBaseline()).toBe(true)
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n")
    fs.writeFileSync(memFile("big.md"), big)
    fs.writeFileSync(memFile("small.md"), "tiny\n")
    const diff = await captureWorkspaceDiff()
    expect(diff.unifiedDiff).not.toContain("[diff omitted:")
    expect(diff.unifiedDiff).toContain("+line 4999")
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
