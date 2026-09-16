import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { buildV2Tools } from "../src/v2/tools.js"
import { resetPluginOptions } from "../src/options.js"
import { applyPluginOptions } from "../src/index.js"
import { MemoryStore } from "../src/store.js"

const TEST_ROOT = path.join(os.tmpdir(), `ocm-v2tools-${process.pid}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
  // Module-singleton DB handle: drop any handle from another test file.
  require("../src/db.js").closeDb()
  const root = path.join(TEST_ROOT, "memories")
  fs.mkdirSync(root, { recursive: true })
  resetPluginOptions()
})

afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
  resetPluginOptions()
})

const TCTX = { sessionID: "ses_test", messageID: "msg_test", agent: "build" }

describe("buildV2Tools gating", () => {
  it("registers all 7 tools by default", () => {
    expect(buildV2Tools().map((t) => t.name).sort()).toEqual(
      ["memory_add_note", "memory_inspect", "memory_list", "memory_mode", "memory_read", "memory_reset", "memory_search"].sort(),
    )
  })

  it("registers only control tools when dedicated_tools is off", () => {
    applyPluginOptions({ dedicated_tools: false })
    expect(buildV2Tools().map((t) => t.name).sort()).toEqual(["memory_inspect", "memory_mode", "memory_reset"])
  })

  it("registers only control tools when use_memories is off", () => {
    applyPluginOptions({ use_memories: false })
    expect(buildV2Tools().map((t) => t.name).sort()).toEqual(["memory_inspect", "memory_mode", "memory_reset"])
  })
})

describe("adapted tool execution", () => {
  it("memory_read returns content through the V2 shape", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "memories", "READ.md"), "# hi\n")
    const def = buildV2Tools().find((t) => t.name === "memory_read")!
    const abort = new AbortController().signal
    const res = await def.execute({ path: "READ.md" }, { ...TCTX, abort })
    expect(res.content).toContain("# hi")
  })

  it("memory_list applies schema defaults", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "memories", "a.md"), "x")
    const def = buildV2Tools().find((t) => t.name === "memory_list")!
    const parsed = (def.input as any).parse({})
    expect(parsed.path).toBe("")
    const res = await def.execute(parsed, TCTX)
    expect(res.content).toContain("a.md")
  })

  it("memory_add_note + memory_mode round-trip with the calling session", async () => {
    const add = buildV2Tools().find((t) => t.name === "memory_add_note")!
    const saved = await add.execute({ note: "v2 note", title: "t" }, TCTX)
    expect(saved.content).toContain("Note saved to")
    const mode = buildV2Tools().find((t) => t.name === "memory_mode")!
    const set = await mode.execute({ mode: "disabled" }, TCTX)
    expect(set.content).toContain("ses_test")
    expect(new MemoryStore().getMemoryMode("ses_test")).toBe("disabled")
  })

  it("memory_search finds workspace content", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "memories", "MEMORY.md"), "quokka tracking\n")
    const def = buildV2Tools().find((t) => t.name === "memory_search")!
    const res = await def.execute({ queries: ["quokka"] }, TCTX)
    expect(res.content).toContain("quokka")
  })

  it("memory_inspect renders state", async () => {
    const def = buildV2Tools().find((t) => t.name === "memory_inspect")!
    const res = await def.execute({}, TCTX)
    expect(res.content).toContain("stage1_outputs")
  })
})
