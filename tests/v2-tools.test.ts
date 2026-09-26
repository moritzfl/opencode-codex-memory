import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Schema } from "effect"
import { SessionEvent } from "@opencode/schema/session-event"
import { buildV2Tools } from "../src/v2/tools.js"
import { resetPluginOptions } from "../src/options.js"
import { applyPluginOptions } from "../src/index.js"
import { MemoryStore } from "../src/store.js"
import { buildV1ClientShim, rememberV2Session, resetV2ShimStateForTest, setV2Context } from "../src/v2/shim.js"
import { setV2ServiceDependenciesForTest } from "../src/v2/service.js"
import { readMemoryStatus } from "../src/v2/status.js"
import { resetAgentHealth } from "../src/agent-health.js"

const TEST_ROOT = path.join(os.tmpdir(), `ocm-v2tools-${process.pid}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
  // Module-singleton DB handle: drop any handle from another test file.
  require("../src/db.js").closeDb()
  const root = path.join(TEST_ROOT, "memories")
  fs.mkdirSync(root, { recursive: true })
  resetPluginOptions()
  resetAgentHealth()
  resetV2ShimStateForTest()
  setV2Context(null)
})

afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
  resetPluginOptions()
  setV2ServiceDependenciesForTest(null)
  resetV2ShimStateForTest()
  setV2Context(null)
})

const TCTX = { sessionID: "ses_test", messageID: "msg_test", agent: "build" }

// The host encodes this durable event before persisting a completed tool.
// Checking only the executor's content misses invalid UI metadata that strands
// the call in `running` and leaves the next provider request without a result.
function expectPersistableResult(result: { content: string | unknown[]; metadata?: unknown }) {
  const content: readonly unknown[] = typeof result.content === "string" ? [{ type: "text", text: result.content }] : result.content
  const encoded = Schema.encodeUnknownSync(SessionEvent.Tool.Success.data)({
    sessionID: TCTX.sessionID,
    assistantMessageID: TCTX.messageID,
    id: "call_test",
    content,
    ...(result.metadata === undefined ? {} : { metadata: result.metadata }),
    executed: false,
  })
  expect(content).toEqual(encoded.content)
  expect(result.metadata).toEqual(encoded.metadata)
}

describe("buildV2Tools gating", () => {
  it("registers all 6 tools by default (reset lives in the panel)", () => {
    const tools = buildV2Tools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["memory_add_note", "memory_inspect", "memory_list", "memory_mode", "memory_read", "memory_search"].sort(),
    )
    // Native tool list, not Code Mode. The read-path prompt calls these by name.
    expect(tools.every((t) => t.options?.codemode === false)).toBe(true)
  })

  it("registers only control tools when dedicated_tools is off", () => {
    applyPluginOptions({ dedicated_tools: false })
    expect(buildV2Tools().map((t) => t.name).sort()).toEqual(["memory_inspect", "memory_mode"])
  })

  it("registers only control tools when use_memories is off", () => {
    applyPluginOptions({ use_memories: false })
    expect(buildV2Tools().map((t) => t.name).sort()).toEqual(["memory_inspect", "memory_mode"])
  })
})

describe("adapted tool execution", () => {
  it("memory_read returns content through the V2 shape", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "memories", "READ.md"), "# hi\n")
    const def = buildV2Tools().find((t) => t.name === "memory_read")!
    const abort = new AbortController().signal
    const res = await def.execute({ path: "READ.md" }, { ...TCTX, abort })
    expect(res.content).toContain("# hi")
    expectPersistableResult(res)
  })

  it("memory_list applies schema defaults", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "memories", "a.md"), "x")
    const def = buildV2Tools().find((t) => t.name === "memory_list")!
    const parsed = (def.input as any).parse({})
    expect(parsed.path).toBe("")
    const res = await def.execute(parsed, TCTX)
    expect(res.content).toContain("a.md")
    expectPersistableResult(res)
  })

  it("memory_add_note + memory_mode round-trip with the calling session", async () => {
    const add = buildV2Tools().find((t) => t.name === "memory_add_note")!
    const saved = await add.execute({ note: "v2 note", title: "t" }, TCTX)
    expect(saved.content).toContain("Note saved to")
    expectPersistableResult(saved)
    const mode = buildV2Tools().find((t) => t.name === "memory_mode")!
    const set = await mode.execute({ mode: "disabled" }, TCTX)
    expect(set.content).toContain("ses_test")
    expect(new MemoryStore().getMemoryMode("ses_test")).toBe("disabled")
    expectPersistableResult(set)
  })

  it.each([
    ["unscoped matches", { queries: ["clipboard"] }, "clipboard"],
    ["scoped matches", { queries: ["clipboard", "paste", "Cachy"], path: "MEMORY.md", context_lines: 2, max_results: 18 }, "clipboard"],
    ["window matches", { queries: ["clipboard", "paste"], match_mode: "all_within_lines", line_count: 2 }, "clipboard"],
    ["time-filtered matches", { queries: ["clipboard"], since: "2026-09-26" }, "clipboard"],
    ["time listing", { until: "2026-09-26" }, "clipboard"],
    ["empty matches", { queries: ["nonexistent"] }, "No matches"],
  ])("memory_search persists %s through the V2 success-event schema", async (_label, input, expected) => {
    const root = path.join(TEST_ROOT, "memories")
    fs.writeFileSync(path.join(root, "MEMORY.md"), "clipboard paste Cachy\n")
    fs.mkdirSync(path.join(root, "rollout_summaries"))
    fs.writeFileSync(path.join(root, "rollout_summaries", "2026-09-26T12-00-00-review.md"), "clipboard paste\n")
    const def = buildV2Tools().find((t) => t.name === "memory_search")!
    const res = await def.execute(def.input.parse(input), TCTX)
    expect(res.content).toContain(expected)
    expectPersistableResult(res)
    if (res.metadata) expect(res.metadata).toMatchObject({ next_cursor: null, truncated: false })
  })

  it("memory_inspect renders state", async () => {
    const def = buildV2Tools().find((t) => t.name === "memory_inspect")!
    const res = await def.execute({}, TCTX)
    expect(res.content).toContain("stage1_outputs")
    expect(res.content).toContain("v2_discovery_source: not_checked")
    expectPersistableResult(res)
  })

  it.each(["service", "context"])("reports observed-only discovery until %s listing recovers", async (source) => {
    let available = false
    let probes = 0
    const session = { list: async () => ({ data: [] }) }
    setV2ServiceDependenciesForTest({
      service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
      make: () => ({ session }),
      probe: async () => {
        probes++
        if (!available) throw new Error("GET /api/info 401")
        return { version: "2.0.12", pid: process.pid }
      },
    })
    const shim = buildV1ClientShim() as any
    rememberV2Session("ses_observed", "/project")
    expect((await shim._client.get({ url: "/experimental/session" })).data).toHaveLength(1)
    const inspect = buildV2Tools().find((tool) => tool.name === "memory_inspect")!
    const fallback = await inspect.execute({}, TCTX)
    expect(fallback.content).toContain("v2_discovery_source: observed")
    expect(fallback.content).toContain("GET /api/info 401")
    expect(fallback.content).toContain("extraction limited to sessions observed by this process")
    expect(fallback.metadata).toMatchObject({ v2_discovery: { source: "observed" } })
    expectPersistableResult(fallback)
    const status = readMemoryStatus()
    expect(status.activity).toBe("error")
    expect(status.warnings.some((warning) => warning.includes("GET /api/info 401"))).toBe(true)
    expect(probes).toBe(1) // Inspection/status do not probe or run extraction.

    available = true
    if (source === "context") setV2Context({ session } as any)
    await shim._client.get({ url: "/experimental/session" })
    const recovered = await inspect.execute({}, TCTX)
    expect(recovered.content).toContain(`v2_discovery_source: ${source}`)
    expect(recovered.content).not.toContain("v2_discovery_warning")
    expectPersistableResult(recovered)
    expect(readMemoryStatus().warnings).toEqual([])
    expect(readMemoryStatus().activity).toBe("idle")
  })
})
