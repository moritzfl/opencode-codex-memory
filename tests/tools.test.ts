import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-memex-tools-${process.pid}-${Date.now()}`)
const CTX = { sessionID: "ses_test" } as any

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_MEMEX_TEST_ROOT = TEST_ROOT
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
  delete process.env.OPENCODE_MEMEX_TEST_ROOT
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
