import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-tools-${process.pid}-${Date.now()}`)
const CTX = { sessionID: "ses_test" } as any

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
  // Module-singleton DB handle: drop any handle from another test file.
  require("../src/db.js").closeDb()
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
  return memory_search.execute({ max_results: 50, ...args }, CTX)
}

describe("memory_search time filters", () => {
  it("still searches everything without time filters", async () => {
    const r = await search({ queries: ["blue-green"] })
    expect(r.output).toContain("MEMORY.md")
    expect(r.output).toContain("2026-06-01T10-00-00-ab12-fix_deploy.md")
  })

  it("restricts query matches to time-anchored files in the window", async () => {
    const r = await search({ queries: ["blue-green"], since: "2026-07-01" })
    // MEMORY.md has no timestamp and the June summary is out of range.
    expect(r.output).toContain("No matches")
  })

  it("finds period content with query + window", async () => {
    const r = await search({ queries: ["metrics"], since: "2026-07-01", until: "2026-07-03" })
    expect(r.output).toContain("2026-07-02T09-30-00-cd34-add_metrics.md")
    expect(r.output).not.toContain("fix_deploy")
  })

  it("lists the period chronologically when no queries are given", async () => {
    const r = await search({ since: "2026-07-01", until: "2026-07-02" })
    const lines = r.output.split("\n")
    expect(lines[0]).toContain("2 of 2 memory file(s)")
    // Newest first, and both July files (summary + ad-hoc note) included.
    expect(lines[1]).toContain("remember-flag")
    expect(lines[2]).toContain("add_metrics")
    expect(lines[2]).toContain("Added metrics dashboard")
    expect(r.metadata.next_cursor).toBe(null)
    expect(r.metadata.truncated).toBe(false)
  })

  it("paginates the no-query chronological listing", async () => {
    const page1 = await search({ since: "2026-06-01", until: "2026-07-03", max_results: 1 })
    expect(page1.metadata.count).toBe(1)
    expect(page1.metadata.truncated).toBe(true)
    expect(page1.metadata.next_cursor).toBe("1")
    expect(page1.output).toContain("remember-flag")
    expect(page1.output).not.toContain("add_metrics")
    const page2 = await search({
      since: "2026-06-01",
      until: "2026-07-03",
      max_results: 1,
      cursor: page1.metadata.next_cursor,
    })
    expect(page2.metadata.count).toBe(1)
    expect(page2.output).toContain("add_metrics")
    expect(page2.metadata.next_cursor).toBe("2")
    expect((await search({ since: "2026-06-01", cursor: "notanint" })).output).toContain("invalid cursor")
    expect((await search({ since: "2026-06-01", cursor: "999" })).output).toContain("exceeds result count")
  })

  it("treats a date-only until as the whole day", async () => {
    const r = await search({ since: "2026-06-01", until: "2026-06-01" })
    expect(r.output).toContain("fix_deploy")
    expect(r.output).not.toContain("add_metrics")
  })

  it("rejects unparseable dates, empty queries, and empty argument sets", async () => {
    expect((await search({ since: "not-a-date", queries: ["x"] })).output).toContain("could not parse")
    expect((await search({})).output).toContain("provide queries and/or since/until")
    expect((await search({ queries: ["  "] })).output).toContain("non-empty")
  })
})

describe("memory_search match modes (codex parity)", () => {
  it("any: a line matching any query counts, with matched_queries reported", async () => {
    const r = await search({ queries: ["blue-green", "does-not-exist-anywhere"] })
    expect(r.output).toContain("MEMORY.md")
    const m = (r.metadata.matches as any[])[0]
    expect(m.matched_queries).toEqual(["blue-green"])
  })

  it("all_on_same_line requires every query on one line", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "same.md"), "alpha beta\nalpha\nbeta\n")
    const r = await search({ queries: ["alpha", "beta"], match_mode: "all_on_same_line" })
    expect(r.metadata.matches.length).toBe(1)
    expect(r.metadata.matches[0].match_line_number).toBe(1)
  })

  it("all_within_lines matches a window and keeps only minimal windows", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "window.md"), "alpha\nfiller\nbeta\nnothing\n")
    const hit = await search({ queries: ["alpha", "beta"], match_mode: "all_within_lines", line_count: 3 })
    expect(hit.metadata.matches.length).toBe(1)
    expect(hit.metadata.matches[0].match_line_number).toBe(1)
    expect(hit.metadata.matches[0].content).toContain("alpha")
    expect(hit.metadata.matches[0].content).toContain("beta")
    const miss = await search({ queries: ["alpha", "beta"], match_mode: "all_within_lines", line_count: 2 })
    expect(miss.output).toContain("No matches")
    const invalid = await search({ queries: ["alpha"], match_mode: "all_within_lines" })
    expect(invalid.output).toContain("requires line_count")
  })

  it("normalized comparison ignores separators (case handled separately, like codex)", async () => {
    const r = await search({ queries: ["bluegreen"], normalized: true })
    expect(r.output).toContain("MEMORY.md")
    // normalized does NOT imply case-insensitive…
    const miss = await search({ queries: ["BlueGreen"], normalized: true })
    expect(miss.output).toContain("No matches")
    // …but combines with case_sensitive: false.
    const combo = await search({ queries: ["BlueGreen"], normalized: true, case_sensitive: false })
    expect(combo.output).toContain("MEMORY.md")
  })

  it("context_lines widens the reported content", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "ctx.md"), "before\nneedle-xyz\nafter\n")
    const r = await search({ queries: ["needle-xyz"], context_lines: 1 })
    const m = (r.metadata.matches as any[]).find((x) => x.path === "ctx.md")
    expect(m.content_start_line_number).toBe(1)
    expect(m.content).toBe("before\nneedle-xyz\nafter")
  })

  it("orders matches by byte path, not locale collation", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "B.md"), "lexorder-token\n")
    fs.writeFileSync(path.join(root, "a.md"), "lexorder-token\n")
    const r = await search({ queries: ["lexorder-token"], max_results: 1 })
    expect(r.metadata.matches[0].path).toBe("B.md")
    expect(r.metadata.next_cursor).toBe("1")
  })

  it("paginates with an integer cursor over the (path, line)-sorted result set", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "aaa.md"), "pagetok one\npagetok two\npagetok three\n")
    const page1 = await search({ queries: ["pagetok"], max_results: 2 })
    expect(page1.metadata.matches.length).toBe(2)
    expect(page1.metadata.truncated).toBe(true)
    expect(page1.metadata.next_cursor).toBe("2")
    const page2 = await search({ queries: ["pagetok"], max_results: 2, cursor: page1.metadata.next_cursor })
    expect(page2.metadata.matches.length).toBe(1)
    expect(page2.metadata.truncated).toBe(false)
    expect(page2.metadata.next_cursor).toBe(null)
    expect((await search({ queries: ["pagetok"], cursor: "notanint" })).output).toContain("invalid cursor")
    expect((await search({ queries: ["pagetok"], cursor: "999" })).output).toContain("exceeds result count")
  })

  it("path scoping searches a subtree or a single file", async () => {
    const scoped = await search({ queries: ["blue-green"], path: "rollout_summaries" })
    expect(scoped.output).toContain("fix_deploy")
    expect(scoped.output).not.toContain("MEMORY.md")
    const single = await search({ queries: ["blue-green"], path: "MEMORY.md" })
    expect(single.output).toContain("MEMORY.md:")
    expect((await search({ queries: ["x"], path: "missing-dir" })).output).toContain("Not found")
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
    const r = await search({ queries: ["blue-green"] })
    expect(r.output).not.toContain("leak")
    expect(r.output).toContain("MEMORY.md")
  })

  it("refuses to write an ad-hoc note through a symlinked notes directory", async () => {
    const root = path.join(TEST_ROOT, "memories")
    const notes = path.join(root, "extensions", "ad_hoc", "notes")
    const outside = path.join(TEST_ROOT, "outside-notes")
    fs.rmSync(notes, { recursive: true, force: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, notes)

    const { memory_add_note } = require("../tools/memory.js")
    const r = await memory_add_note.execute({ note: "must stay inside memory" }, CTX)
    expect(r.output).toContain("symlinks are not allowed")
    expect(fs.readdirSync(outside)).toEqual([])
  })
})

describe("memory_search semantics", () => {
  it("is case-sensitive by default like codex", async () => {
    const r = await search({ queries: ["BLUE-GREEN"] })
    expect(r.output).toContain("No matches")
    const r2 = await search({ queries: ["BLUE-GREEN"], case_sensitive: false })
    expect(r2.output).toContain("MEMORY.md")
  })

  it("searches files regardless of extension", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "notes.rst"), "blue-green in rst\n")
    const r = await search({ queries: ["blue-green in rst"] })
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
    expect(names).toEqual(["MEMORY.md", "extensions", "rollout_summaries"])
  })

  it("lists files and reports missing paths", async () => {
    const { memory_list } = require("../tools/memory.js")
    const r = await memory_list.execute({ path: "MEMORY.md", max_results: 2000 }, CTX)
    expect(r.output).toBe("f MEMORY.md")
    expect(r.metadata.entries).toEqual([{ path: "MEMORY.md", entry_type: "file" }])
    const r2 = await memory_list.execute({ path: "nope", max_results: 2000 }, CTX)
    expect(r2.output).toContain("Not found")
  })

  it("paginates directory entries with a Codex-compatible cursor", async () => {
    const root = path.join(TEST_ROOT, "memories")
    const paginationDir = path.join(root, "pagination")
    fs.mkdirSync(paginationDir)
    fs.writeFileSync(path.join(paginationDir, "aaa.md"), "a")
    fs.writeFileSync(path.join(paginationDir, "bbb.md"), "b")
    fs.writeFileSync(path.join(paginationDir, "ccc.md"), "c")
    const { memory_list } = require("../tools/memory.js")

    const first = await memory_list.execute({ path: "pagination", max_results: 2 }, CTX)
    expect(first.metadata.entries).toEqual([
      { path: "pagination/aaa.md", entry_type: "file" },
      { path: "pagination/bbb.md", entry_type: "file" },
    ])
    expect(first.metadata.next_cursor).toBe("2")
    expect(first.metadata.truncated).toBe(true)

    const second = await memory_list.execute({ path: "pagination", cursor: first.metadata.next_cursor, max_results: 2 }, CTX)
    expect(second.metadata.entries).toEqual([
      { path: "pagination/ccc.md", entry_type: "file" },
    ])
    expect(second.metadata.next_cursor).toBe(null)
    expect(second.metadata.truncated).toBe(false)

    expect((await memory_list.execute({ path: "pagination", cursor: "not-an-int", max_results: 2 }, CTX)).output).toContain("invalid cursor")
    expect((await memory_list.execute({ path: "pagination", cursor: "99", max_results: 2 }, CTX)).output).toContain("exceeds result count")
    const exhausted = await memory_list.execute({ path: "pagination", cursor: "3", max_results: 2 }, CTX)
    expect(exhausted.output).toContain("No entries at cursor 3")
    expect(exhausted.metadata).toMatchObject({ entries: [], next_cursor: null, truncated: false })

    // A cursor from a prior page remains valid if concurrent deletion shrinks
    // the listing to exactly that offset.
    fs.rmSync(path.join(paginationDir, "ccc.md"))
    const shrunk = await memory_list.execute({ path: "pagination", cursor: first.metadata.next_cursor, max_results: 2 }, CTX)
    expect(shrunk.output).toContain("No entries at cursor 2")
    expect(shrunk.output).not.toContain("exceeds result count")
    expect(shrunk.metadata.entries).toEqual([])
  })
})

describe("memory_read directory listing", () => {
  it("skips hidden files and symlinks, like memory_list", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, ".hidden.md"), "x")
    fs.symlinkSync(path.join(TEST_ROOT, "outside.txt"), path.join(root, "link.md"))
    const { memory_read } = require("../tools/memory.js")
    const r = await memory_read.execute({ path: "." }, CTX)
    expect(r.metadata.kind).toBe("directory")
    expect(r.metadata.entries).toEqual(["MEMORY.md", "extensions", "rollout_summaries"])
    expect(r.output).not.toContain(".hidden")
    expect(r.output).not.toContain("link.md")
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

describe("memory_reset", () => {
  it("reports wipe failures instead of claiming success", async () => {
    const root = path.join(TEST_ROOT, "memories")
    // Root without write permission: entry deletion must fail and propagate.
    fs.chmodSync(root, 0o555)
    try {
      const { memory_reset } = require("../tools/control.js")
      const r = await memory_reset.execute({ confirm: true }, CTX)
      expect(r.output).toContain("memory_reset error:")
    } finally {
      fs.chmodSync(root, 0o755)
    }
  })

  it("refuses while a consolidation is in flight in this process", async () => {
    const phase2 = require("../src/phase2.js")
    const { MemoryStore } = require("../src/store.js")
    const { setPluginInput } = require("../src/llm.js")
    const { memory_reset } = require("../tools/control.js")
    // Stall the consolidator so phase2 stays in-flight (claim alone is too fast
    // without an await after setting the flag — there is no process rate gate).
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-phase2-reset-guard" } }),
          prompt: async () => {
            await gate
            return { data: { info: {}, parts: [{ type: "text", text: "done" }] } }
          },
          abort: async () => ({ data: {} }),
          delete: async () => ({ data: {} }),
        },
        config: { get: async () => ({ data: {} }) },
      },
    })
    // Empty DB still claims the global job (first-run insert).
    const running = phase2.runPhase2(new MemoryStore(), {
      ...phase2.DEFAULT_PHASE2_OPTIONS,
      heartbeatIntervalMs: 60_000,
    })
    for (let i = 0; i < 100 && !phase2.isPhase2InFlight(); i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(phase2.isPhase2InFlight()).toBe(true)
    const r = await memory_reset.execute({ confirm: true }, CTX)
    expect(r.output).toContain("Reset refused: memory consolidation is currently running")
    release()
    await running
    expect(phase2.isPhase2InFlight()).toBe(false)
  })
})

describe("memory_read paging", () => {
  it("reaches lines beyond 256KiB via line_offset (byte cap applies to output only)", async () => {
    const root = path.join(TEST_ROOT, "memories")
    const line = "x".repeat(1024)
    const lines = Array.from({ length: 400 }, (_, i) => `line-${i + 1}-${line}`)
    fs.writeFileSync(path.join(root, "big.md"), lines.join("\n")) // ~400 KiB
    const { memory_read } = require("../tools/memory.js")
    const r = await memory_read.execute({ path: "big.md", line_offset: 390, max_lines: 2 }, CTX)
    expect(r.output).toContain("line-390-")
    expect(r.output).toContain("line-391-")
    expect(r.output).not.toContain("line-392-")
  })

  it("caps oversized windows at the byte limit with a paging hint", async () => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "huge.md"), "y".repeat(300 * 1024))
    const { memory_read } = require("../tools/memory.js")
    const r = await memory_read.execute({ path: "huge.md" }, CTX)
    expect(r.output).toContain("[output truncated at")
    expect(r.metadata.truncated).toBe(true)
  })
})

describe("memory_inspect", () => {
  it("reports the phase-2 success watermark and never walks through symlinked dirs", async () => {
    const { MemoryStore } = require("../src/store.js")
    const { memory_inspect } = require("../tools/control.js")
    const store = new MemoryStore()
    const ts = Date.UTC(2026, 5, 1)
    store.upsertStage1Output({
      session_id: "ses_w",
      source_updated_at: ts,
      raw_memory: "m",
      rollout_summary: "s",
      rollout_slug: null,
      generated_at: Date.now(),
    })
    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") throw new Error("expected claimed")
    store.markPhase2Succeeded(claim.ownershipToken, [{ session_id: "ses_w", source_updated_at: ts }])

    // Self-referential dir symlink: without lstat the walk would loop forever.
    const root = path.join(TEST_ROOT, "memories")
    fs.symlinkSync(root, path.join(root, "loop"))
    const r = await memory_inspect.execute({}, CTX)
    expect(r.output).toContain("phase2_status: done")
    expect(r.output).toContain("phase2_last_error: none")
    expect(r.output).toContain(`phase2_last_success_watermark: ${new Date(ts).toISOString()}`)
    expect(r.output).toMatch(/phase2_last_success_finished_at: \d{4}-/)
    expect(r.output).toContain("loop@")
    expect(r.output).not.toContain("loop/MEMORY.md")
  })

  it("reports 'none' before any phase-2 success", async () => {
    const { memory_inspect } = require("../tools/control.js")
    const r = await memory_inspect.execute({}, CTX)
    expect(r.output).toContain("phase2_status: none")
    expect(r.output).toContain("phase2_last_success_watermark: none")
    expect(r.output).toContain("phase2_last_success_finished_at: none")
  })

  it("surfaces a failed phase-2 job without labeling the failure as success", async () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const { memory_inspect } = require("../tools/control.js")
    const store = new MemoryStore()
    const ts = Date.UTC(2026, 5, 1)
    store.upsertStage1Output({
      session_id: "ses_fail",
      source_updated_at: ts,
      raw_memory: "m",
      rollout_summary: "s",
      rollout_slug: null,
      generated_at: Date.now(),
    })
    const ok = store.claimGlobalPhase2Job()
    if (ok.type !== "claimed") throw new Error("expected claimed")
    store.markPhase2Succeeded(ok.ownershipToken, [{ session_id: "ses_fail", source_updated_at: ts }])
    // Expire success cooldown so the next claim is allowed.
    openDb().prepare("UPDATE memory_jobs SET finished_at=1 WHERE kind='memory_consolidate_global'").run()
    const retry = store.claimGlobalPhase2Job()
    if (retry.type !== "claimed") throw new Error("expected retry claim")
    store.markPhase2Failed(retry.ownershipToken, "prompt failed: boom")

    const r = await memory_inspect.execute({}, CTX)
    expect(r.output).toContain("phase2_status: failed")
    expect(r.output).toContain("phase2_last_error: prompt failed: boom")
    expect(r.output).toContain(`phase2_last_success_watermark: ${new Date(ts).toISOString()}`)
    expect(r.output).toContain("phase2_last_success_finished_at: none")
    expect(r.output).toMatch(/phase2_last_attempt_finished_at: \d{4}-/)
    expect(r.output).toMatch(/phase2_retry_at: \d{4}-/)
    expect(r.metadata.phase2_status).toBe("failed")
    expect(r.metadata.phase2_last_success_finished_at).toBeNull()
  })

  it("does not read a memory summary through a symlink", async () => {
    const root = path.join(TEST_ROOT, "memories")
    const outside = path.join(TEST_ROOT, "outside-summary.md")
    fs.writeFileSync(outside, "v1\noutside secret\n")
    fs.symlinkSync(outside, path.join(root, "memory_summary.md"))
    const { memory_inspect } = require("../tools/control.js")

    const r = await memory_inspect.execute({}, CTX)
    expect(r.output).toContain("memory_inspect error:")
    expect(r.output).not.toContain("outside secret")
  })

  it("echoes the effective options as the config-verification surface", async () => {
    const { memory_inspect } = require("../tools/control.js")
    const r = await memory_inspect.execute({}, CTX)
    expect(r.output).toContain("Effective options:")
    expect(r.output).toContain("generate_memories: true")
    expect(r.output).toContain("codex_interop: off")
    expect(r.output).toContain("claude_import: off")
    expect(r.output).toContain("config_warnings: none")
    expect(r.metadata.effective_options.dedicated_tools).toBe(true)
  })

  it("reports effective agent health after config injection", async () => {
    const { injectAgentDefinitions } = require("../src/index.js")
    const config: { agent?: Record<string, unknown> } = {}
    injectAgentDefinitions(config)
    const { memory_inspect } = require("../tools/control.js")
    const r = await memory_inspect.execute({}, CTX)
    expect(r.output).toContain("agent_config: observed")
    expect(r.output).toContain("agent_memorize: source=shipped status=healthy")
    expect(r.output).toContain("agent_memorize-extract: source=shipped status=healthy")
    expect(r.metadata.agent_health.agents.memorize.healthy).toBe(true)
    expect(r.metadata.agent_health.agents["memorize-extract"].healthy).toBe(true)
  })

  it("surfaces unknown/malformed option warnings recorded at apply time", async () => {
    const { memory_inspect } = require("../tools/control.js")
    const { applyPluginOptions } = require("../src/index.js")
    const { resetConfigWarningsForTest, pluginOptions } = require("../src/options.js")
    resetConfigWarningsForTest()
    try {
      applyPluginOptions({ generate_memoriez: true, codex_interop: "yes please" })
      const r = await memory_inspect.execute({}, CTX)
      expect(r.output).toContain("config_warnings (2):")
      expect(r.output).toContain("unknown/unsupported option 'generate_memoriez' ignored")
      expect(r.output).toContain("codex_interop must be an object")
      expect(r.metadata.config_warnings).toHaveLength(2)
      // Re-apply with clean opts drops prior warnings (no stale inspect noise).
      applyPluginOptions({ generate_memories: true })
      const r2 = await memory_inspect.execute({}, CTX)
      expect(r2.output).toContain("config_warnings: none")
      expect(r2.metadata.config_warnings).toHaveLength(0)
    } finally {
      resetConfigWarningsForTest()
      pluginOptions.codex_interop = { import: false, export: false }
      pluginOptions.claude_import = { enabled: false }
    }
  })

  it("warns on wrong-typed known options and restores clean defaults", async () => {
    const { memory_inspect } = require("../tools/control.js")
    const { applyPluginOptions } = require("../src/index.js")
    const { pluginOptions } = require("../src/options.js")
    applyPluginOptions({
      generate_memories: "yes",
      max_raw_memories_for_consolidation: "many",
      codex_interop: { import: "yes", mystery: true },
      claude_import: { enabled: "yes", mystery: true, projects: "all" },
    } as any)

    const r = await memory_inspect.execute({}, CTX)
    expect(r.output).toContain("generate_memories must be a boolean")
    expect(r.output).toContain("max_raw_memories_for_consolidation must be a finite number")
    expect(r.output).toContain("codex_interop.import must be a boolean")
    expect(r.output).toContain("unknown codex_interop option 'mystery'")
    expect(r.output).toContain("claude_import.enabled must be a boolean")
    expect(r.output).toContain("unknown claude_import option 'mystery'")
    expect(r.output).toContain("claude_import.projects must be an array of strings")
    expect(pluginOptions.generate_memories).toBe(true)
    expect(pluginOptions.max_raw_memories_for_consolidation).toBe(256)
    expect(pluginOptions.codex_interop.import).toBe(false)
    expect(pluginOptions.claude_import.enabled).toBe(false)
  })

  it("reports the resolved codex memories root when interop is enabled", async () => {
    const { memory_inspect } = require("../tools/control.js")
    const { pluginOptions } = require("../src/options.js")
    pluginOptions.codex_interop = { import: true, export: false, codex_home: path.join(TEST_ROOT, "codex-home") }
    try {
      const r = await memory_inspect.execute({}, CTX)
      expect(r.output).toContain("codex_interop: import=true export=false")
      expect(r.output).toContain(path.join(TEST_ROOT, "codex-home", "memories"))
      expect(r.output).toContain("not found yet")
    } finally {
      pluginOptions.codex_interop = { import: false, export: false }
    }
  })

  it("reports claude_import home when enabled", async () => {
    const { memory_inspect } = require("../tools/control.js")
    const { pluginOptions } = require("../src/options.js")
    const claudeHome = path.join(TEST_ROOT, "claude-home")
    pluginOptions.claude_import = { enabled: true, claude_home: claudeHome }
    try {
      const r = await memory_inspect.execute({}, CTX)
      expect(r.output).toContain("claude_import: enabled projects=all")
      expect(r.output).toContain(claudeHome)
      expect(r.output).toContain("not found")
    } finally {
      pluginOptions.claude_import = { enabled: false }
    }
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

  it("persists note content verbatim like Codex", async () => {
    const { memory_add_note } = require("../tools/memory.js")
    const secretShaped = "password=sk-" + "a".repeat(30)
    const r = await memory_add_note.execute({ note: secretShaped, title: "verbatim note" }, CTX)
    const root = path.join(TEST_ROOT, "memories")
    const written = fs.readFileSync(path.join(root, r.metadata.file), "utf8")
    expect(written).toContain(secretShaped)
  })
})

describe("memory_mode", () => {
  it("defaults to the current session and accepts an explicit target", async () => {
    const { memory_mode } = require("../tools/control.js")
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()

    await memory_mode.execute({ mode: "disabled" }, CTX)
    await memory_mode.execute({ mode: "enabled", sessionId: "ses_other" }, CTX)

    expect(store.getMemoryMode(CTX.sessionID)).toBe("disabled")
    expect(store.getMemoryMode("ses_other")).toBe("enabled")
  })
})
