import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-tools-${process.pid}-${Date.now()}`)
const CTX = { sessionID: "ses_test" } as any

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
  const root = path.join(TEST_ROOT, "memories")
  fs.mkdirSync(path.join(root, "rollout_summaries"), { recursive: true })
  fs.mkdirSync(path.join(root, "extensions", "ad_hoc", "notes"), { recursive: true })
  fs.writeFileSync(path.join(root, "MEMORY.md"), "# Task Group: api service\n\n- deploy uses blue-green rollout\n")
  fs.writeFileSync(
    path.join(root, "rollout_summaries", "2026-06-01T10-00-00-ab12-fix_deploy.md"),
    "session_id: ses_old\nupdated_at: 2026-06-01T10:00:00.000Z\ncwd: /proj\n\n# Fixed the deploy pipeline\nblue-green rollout notes\n",
  )
  fs.writeFileSync(
    path.join(root, "rollout_summaries", "2026-07-02T09-30-00-cd34-add_metrics.md"),
    "session_id: ses_new\nupdated_at: 2026-07-02T09:30:00.000Z\ncwd: /proj\n\n# Added metrics dashboard\n",
  )
  fs.writeFileSync(
    path.join(root, "extensions", "ad_hoc", "notes", "2026-07-02T12-00-00_remember-flag.md"),
    "# Remember flag\n\n- created: 2026-07-02T12:00:00.000Z\n\nalways pass --dry-run first\n",
  )
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
})

function search(args: Record<string, unknown>) {
  const { memory_search } = require("../tools/memory.js")
  return memory_search.execute({ limit: 50, ...args }, CTX)
}

describe("memory_search time filters", () => {
  it("still searches everything without time filters", async () => {
    const r = await search({ query: "blue-green" })
    expect(r.output).toContain("MEMORY.md")
    expect(r.output).toContain("2026-06-01T10-00-00-ab12-fix_deploy.md")
  })

  it("restricts query matches to time-anchored files in the window", async () => {
    const r = await search({ query: "blue-green", since: "2026-07-01" })
    // MEMORY.md has no timestamp and the June summary is out of range.
    expect(r.output).toContain("No matches")
  })

  it("finds period content with query + window", async () => {
    const r = await search({ query: "metrics", since: "2026-07-01", until: "2026-07-03" })
    expect(r.output).toContain("2026-07-02T09-30-00-cd34-add_metrics.md")
    expect(r.output).not.toContain("fix_deploy")
  })

  it("lists the period chronologically when no query is given", async () => {
    const r = await search({ since: "2026-07-01", until: "2026-07-02" })
    const lines = r.output.split("\n")
    expect(lines[0]).toContain("2 memory file(s)")
    // Newest first, and both July files (summary + ad-hoc note) included.
    expect(lines[1]).toContain("remember-flag")
    expect(lines[2]).toContain("add_metrics")
    expect(lines[2]).toContain("Added metrics dashboard")
  })

  it("treats a date-only until as the whole day", async () => {
    const r = await search({ since: "2026-06-01", until: "2026-06-01" })
    expect(r.output).toContain("fix_deploy")
    expect(r.output).not.toContain("add_metrics")
  })

  it("rejects unparseable dates and empty argument sets", async () => {
    expect((await search({ since: "not-a-date", query: "x" })).output).toContain("could not parse")
    expect((await search({})).output).toContain("provide a query and/or since/until")
  })
})

describe("path guard hardening", () => {
  it("rejects symlinks anywhere in the path", async () => {
    const root = path.join(TEST_ROOT, "memories")
    const outside = path.join(TEST_ROOT, "outside.md")
    fs.writeFileSync(outside, "secret outside content\n")
    fs.symlinkSync(outside, path.join(root, "sneaky.md"))
    const { memory_read } = require("../tools/memory.js")
    const r = await memory_read.execute({ path: "sneaky.md" }, CTX)
    expect(r.output).toContain("symlinks are not allowed")
  })

  it("hides dot components like .git", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.mkdirSync(path.join(root, ".git"), { recursive: true })
    fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n")
    const { memory_read } = require("../tools/memory.js")
    const r = await memory_read.execute({ path: ".git/config" }, CTX)
    expect(r.output).toContain("not found")
  })

  it("search walker skips symlinked files and directories", async () => {
    const root = path.join(TEST_ROOT, "memories")
    const outsideDir = path.join(TEST_ROOT, "outside-dir")
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(outsideDir, "leak.md"), "blue-green rollout leak\n")
    fs.symlinkSync(outsideDir, path.join(root, "linked"))
    const r = await search({ query: "blue-green" })
    expect(r.output).not.toContain("leak")
    expect(r.output).toContain("MEMORY.md")
  })
})

describe("memory_search semantics", () => {
  it("is case-sensitive by default like codex", async () => {
    const r = await search({ query: "BLUE-GREEN" })
    expect(r.output).toContain("No matches")
    const r2 = await search({ query: "BLUE-GREEN", case_sensitive: false })
    expect(r2.output).toContain("MEMORY.md")
  })

  it("searches files regardless of extension", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "notes.rst"), "blue-green in rst\n")
    const r = await search({ query: "blue-green in rst" })
    expect(r.output).toContain("notes.rst")
  })
})

describe("memory_list", () => {
  it("lists sorted entries with types, skipping hidden files and symlinks", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, ".hidden.md"), "x")
    fs.symlinkSync(path.join(TEST_ROOT, "outside.txt"), path.join(root, "link.md"))
    const { memory_list } = require("../tools/memory.js")
    const r = await memory_list.execute({ path: "", max_results: 2000 }, CTX)
    expect(r.output).toContain("f MEMORY.md")
    expect(r.output).toContain("d rollout_summaries")
    expect(r.output).not.toContain(".hidden")
    expect(r.output).not.toContain("link.md")
    const names = (r.metadata.entries as Array<{ path: string }>).map((e) => e.path)
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names)
  })

  it("errors on files and reports missing paths", async () => {
    const { memory_list } = require("../tools/memory.js")
    const r = await memory_list.execute({ path: "MEMORY.md", max_results: 2000 }, CTX)
    expect(r.output).toContain("not a directory")
    const r2 = await memory_list.execute({ path: "nope", max_results: 2000 }, CTX)
    expect(r2.output).toContain("Not found")
  })
})

describe("memory_read line windows", () => {
  it("supports line_offset and max_lines with start-line reporting", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "long.md"), Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n"))
    const { memory_read } = require("../tools/memory.js")
    const r = await memory_read.execute({ path: "long.md", line_offset: 4, max_lines: 2 }, CTX)
    expect(r.output).toContain("[starting at line 4]")
    expect(r.output).toContain("line-4")
    expect(r.output).toContain("line-5")
    expect(r.output).not.toContain("line-6")
    const r2 = await memory_read.execute({ path: "long.md", line_offset: 99 }, CTX)
    expect(r2.output).toContain("exceeds file length")
  })
})

describe("memory_add_note collisions", () => {
  it("never overwrites an existing note (append-only)", async () => {
    const { memory_add_note } = require("../tools/memory.js")
    const a = await memory_add_note.execute({ note: "first", title: "same title" }, CTX)
    const b = await memory_add_note.execute({ note: "second", title: "same title" }, CTX)
    expect(a.metadata.file).not.toBe(b.metadata.file)
    const root = path.join(TEST_ROOT, "memories")
    const first = fs.readFileSync(path.join(root, a.metadata.file), "utf8")
    expect(first).toContain("first")
  })

  it("uses the hyphen-separated codex filename layout", async () => {
    const { memory_add_note } = require("../tools/memory.js")
    const r = await memory_add_note.execute({ note: "x", title: "my note" }, CTX)
    expect(r.metadata.file).toMatch(/notes\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-my-note\.md$/)
  })
})
