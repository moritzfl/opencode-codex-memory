import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { parseCitations, extractCitedSessionIds, stripCitations } from "../src/citation.js"
import { takeNewCitations } from "../src/index.js"

describe("takeNewCitations", () => {
  it("records each session id once per part across repeated streaming updates", () => {
    expect(takeNewCitations("ses:part1", ["a", "b"])).toEqual(["a", "b"])
    expect(takeNewCitations("ses:part1", ["a", "b"])).toEqual([])
    expect(takeNewCitations("ses:part1", ["a", "b", "c"])).toEqual(["c"])
    expect(takeNewCitations("ses:part2", ["a"])).toEqual(["a"])
  })
})

const SAMPLE = `Here is an answer from memory.

<memory-citation>
<citation_entries>session-1,session-2</citation_entries>
</memory-citation>`

const MULTI = `First answer.

<memory-citation>
<citation_entries>abc-1</citation_entries>
</memory-citation>

Second answer.

<memory-citation>
<citation_entries> def-2 , def-3 </citation_entries>
</memory-citation>`

const NONE = `No memory used here.`

const RICH = `The build command is bun run build.

<memory-citation>
<citation_entries>
MEMORY.md:12-14|note=[build command for the api service]
rollout_summaries/2026-02-17T21-23-02-ln3m-example.md:10-12|note=[weekly report format]
</citation_entries>
<session_ids>
ses_abc123
ses_def456
ses_abc123
</session_ids>
</memory-citation>`

describe("parseCitations (rich format)", () => {
  it("parses citation entries with paths, line ranges, and notes", () => {
    const r = parseCitations(RICH)
    expect(r.length).toBe(1)
    expect(r[0].entries).toEqual([
      { path: "MEMORY.md", lineStart: 12, lineEnd: 14, note: "build command for the api service" },
      { path: "rollout_summaries/2026-02-17T21-23-02-ln3m-example.md", lineStart: 10, lineEnd: 12, note: "weekly report format" },
    ])
  })

  it("parses and dedupes session ids from the session_ids block", () => {
    const r = parseCitations(RICH)
    expect(r[0].sessionIds).toEqual(["ses_abc123", "ses_def456"])
  })

  it("accepts an empty session_ids block", () => {
    const text = `<memory-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries>\n<session_ids>\n</session_ids>\n</memory-citation>`
    const r = parseCitations(text)
    expect(r.length).toBe(1)
    expect(r[0].sessionIds).toEqual([])
    expect(r[0].entries.length).toBe(1)
  })

  it("strips the rich block from the reply", () => {
    expect(stripCitations(RICH)).toBe("The build command is bun run build.")
  })
})

describe("parseCitations", () => {
  it("parses a single citation block", () => {
    const r = parseCitations(SAMPLE)
    expect(r.length).toBe(1)
    expect(r[0].sessionIds).toEqual(["session-1", "session-2"])
  })

  it("parses multiple citation blocks", () => {
    const r = parseCitations(MULTI)
    expect(r.length).toBe(2)
    expect(r[0].sessionIds).toEqual(["abc-1"])
    expect(r[1].sessionIds).toEqual(["def-2", "def-3"])
  })

  it("returns empty when no citations", () => {
    expect(parseCitations(NONE)).toEqual([])
  })

  it("ignores empty citation_entries", () => {
    const text = `<memory-citation><citation_entries></citation_entries></memory-citation>`
    expect(parseCitations(text)).toEqual([])
  })
})

describe("extractCitedSessionIds", () => {
  it("dedupes session ids across blocks", () => {
    const text = `<memory-citation><citation_entries>a,b</citation_entries></memory-citation>` +
      `<memory-citation><citation_entries>b,c</citation_entries></memory-citation>`
    expect(extractCitedSessionIds(text).sort()).toEqual(["a", "b", "c"])
  })
})

describe("experimental.text.complete hook", () => {
  const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-citation-"))
  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true })
    // Module-singleton DB handle: drop any handle from another test file.
    require("../src/db.js").closeDb()
  })
  afterEach(() => {
    delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
    require("../src/db.js").closeDb()
  })

  it("strips citations and records usage before the part is persisted", async () => {
    process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
    const plugin = require("../src/index.js").default
    const { MemoryStore } = require("../src/store.js")
    const hooks = await plugin.server({ client: {} } as any, undefined)
    expect(typeof hooks["experimental.text.complete"]).toBe("function")

    const store = new MemoryStore()
    store.upsertStage1Output({
      session_id: "ses_cited_tc",
      source_updated_at: 111,
      raw_memory: "m",
      rollout_summary: "s",
      rollout_slug: null,
      generated_at: Date.now(),
    })

    const output = { text: `answer\n\n<memory-citation>\n<citation_entries>ses_cited_tc</citation_entries>\n</memory-citation>` }
    await hooks["experimental.text.complete"](
      { sessionID: "ses_main_tc", messageID: "msg_1", partID: "prt_tc_1" },
      output,
    )
    expect(output.text).toBe("answer")
    const row = store.stage1Outputs().find((o: any) => o.session_id === "ses_cited_tc")
    expect(row.usage_count).toBe(1)

    // Second sight of the same part (e.g. the event fallback) records nothing.
    const again = { text: `answer\n\n<memory-citation>\n<citation_entries>ses_cited_tc</citation_entries>\n</memory-citation>` }
    await hooks["experimental.text.complete"](
      { sessionID: "ses_main_tc", messageID: "msg_1", partID: "prt_tc_1" },
      again,
    )
    const row2 = store.stage1Outputs().find((o: any) => o.session_id === "ses_cited_tc")
    expect(row2.usage_count).toBe(1)
  })

  it("leaves citation-free text untouched", async () => {
    process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
    const plugin = require("../src/index.js").default
    const hooks = await plugin.server({ client: {} } as any, undefined)
    const output = { text: "plain answer" }
    await hooks["experimental.text.complete"]({ sessionID: "s", messageID: "m", partID: "p" }, output)
    expect(output.text).toBe("plain answer")
  })
})

describe("stripCitations", () => {
  it("removes citation blocks and preserves prose", () => {
    const out = stripCitations(SAMPLE)
    expect(out).toBe("Here is an answer from memory.")
  })

  it("removes multiple citation blocks", () => {
    const out = stripCitations(MULTI)
    expect(out).toContain("First answer.")
    expect(out).toContain("Second answer.")
    expect(out).not.toContain("memory-citation")
  })

  it("leaves non-citation text unchanged", () => {
    expect(stripCitations(NONE)).toBe(NONE)
  })

  it("handles text with no citations", () => {
    expect(stripCitations("plain text")).toBe("plain text")
  })

  it("handles citation block with extra whitespace/newlines", () => {
    const text = `answer\n\n<memory-citation>\n  <citation_entries>  s1 , s2  </citation_entries>\n</memory-citation>\n\n`
    const ids = extractCitedSessionIds(text)
    expect(ids.sort()).toEqual(["s1", "s2"])
    const out = stripCitations(text)
    expect(out).toBe("answer")
  })
})