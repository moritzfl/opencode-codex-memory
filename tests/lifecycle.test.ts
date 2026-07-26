import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { handleSessionDeleted, shouldHandleIdle } from "../src/index.js"
import plugin from "../src/index.js"

describe("hook wiring", () => {
  it("registers tool.execute.after as a top-level hook (not an event-bus type)", async () => {
    // Regression: pollution marking once lived inside the event() bus handler
    // under a nonexistent "tool.execute.after" event type and never fired.
    const hooks = (await plugin.server({ client: {} } as any, undefined)) as Record<string, unknown>
    expect(typeof hooks["tool.execute.before"]).toBe("function")
    expect(typeof hooks["tool.execute.after"]).toBe("function")
    expect(typeof hooks.event).toBe("function")
  })

  it("uses live sanitized MCP server names for pollution marking", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-mcp-pollution-"))
    const previousRoot = process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    let statusResponse: unknown = { data: { "first.server": { status: "connected" } } }
    try {
      require("../src/db.js").closeDb()
      process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = testRoot
      const hooks = (await plugin.server(
        { client: { mcp: { status: async () => statusResponse } } } as any,
        { disable_on_external_context: true } as any,
      )) as any

      await hooks["tool.execute.before"]({ tool: "first_server_tool", sessionID: "ses_first", callID: "call_1" })
      statusResponse = { data: {} }
      await hooks["tool.execute.after"]({ tool: "first_server_tool", sessionID: "ses_first", callID: "call_1" })
      const { MemoryStore } = require("../src/store.js")
      expect(new MemoryStore().getMemoryMode("ses_first")).toBe("polluted")

      statusResponse = { data: { "added.later": { status: "connected" } } }
      await hooks["tool.execute.before"]({ tool: "added_later_tool", sessionID: "ses_added", callID: "call_2" })
      await hooks["tool.execute.after"]({ tool: "added_later_tool", sessionID: "ses_added", callID: "call_2" })
      expect(new MemoryStore().getMemoryMode("ses_added")).toBe("polluted")

      statusResponse = { data: { first: { status: "connected" } } }
      await hooks["tool.execute.before"]({ tool: "first_tool", sessionID: "ses_reused_external", callID: "call_reused" })
      statusResponse = { data: {} }
      await hooks["tool.execute.before"]({ tool: "local_tool", sessionID: "ses_reused_local", callID: "call_reused" })
      await hooks["tool.execute.after"]({ tool: "first_tool", sessionID: "ses_reused_external", callID: "call_reused" })
      await hooks["tool.execute.after"]({ tool: "local_tool", sessionID: "ses_reused_local", callID: "call_reused" })
      expect(new MemoryStore().getMemoryMode("ses_reused_external")).toBe("polluted")
      expect(new MemoryStore().getMemoryMode("ses_reused_local")).toBeNull()

      statusResponse = { data: undefined, error: { message: "status failed" } }
      await hooks["tool.execute.before"]({ tool: "error_tool", sessionID: "ses_error", callID: "call_3" })
      await hooks["tool.execute.after"]({ tool: "error_tool", sessionID: "ses_error", callID: "call_3" })
      expect(new MemoryStore().getMemoryMode("ses_error")).toBeNull()
    } finally {
      await plugin.server({ client: {} } as any, { disable_on_external_context: false } as any)
      require("../src/db.js").closeDb()
      if (previousRoot === undefined) delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
      else process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = previousRoot
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("does not inject memory into the sessionless agent-generation hook", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-system-hook-"))
    const previousRoot = process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    try {
      process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = testRoot
      const root = path.join(testRoot, "memories")
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(path.join(root, "memory_summary.md"), "v1\n\nremember this\n")
      const hooks = (await plugin.server({ client: {} } as any, { use_memories: true } as any)) as any

      const agentOutput = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ model: {} }, agentOutput)
      expect(agentOutput.system).toEqual([])

      const sessionOutput = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "ses_real", model: {} }, sessionOutput)
      expect(sessionOutput.system.join("\n")).toContain("remember this")
    } finally {
      if (previousRoot === undefined) delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
      else process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = previousRoot
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })
})

describe("idle event handling", () => {
  const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-idle-"))
  beforeEach(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true })
    // The DB handle is a module singleton; drop any handle another test file
    // opened against its own (since-deleted) root.
    require("../src/db.js").closeDb()
  })
  afterEach(() => {
    delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
    require("../src/db.js").closeDb()
  })

  it("dedupes the session.status/session.idle twin events per session", () => {
    expect(shouldHandleIdle("ses_twin", 1000)).toBe(true)
    // The deprecated twin arrives a moment later: swallowed.
    expect(shouldHandleIdle("ses_twin", 1005)).toBe(false)
    // A later real idle transition is handled again.
    expect(shouldHandleIdle("ses_twin", 1000 + 60_000)).toBe(true)
    // Other sessions are independent.
    expect(shouldHandleIdle("ses_other", 1006)).toBe(true)
  })

  it("stamps memory mode at turn start via chat.message (codex stamp-at-thread-creation)", async () => {
    process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
    const hooks = (await plugin.server({ client: {} } as any, undefined)) as any
    expect(typeof hooks["chat.message"]).toBe("function")
    await hooks["chat.message"]({ sessionID: "ses_turn_start" })
    const { MemoryStore } = require("../src/store.js")
    expect(new MemoryStore().getMemoryMode("ses_turn_start")).toBe("enabled")
    // Second message in the same session is a no-op (once per process).
    const { markTurnSeen } = require("../src/index.js")
    expect(markTurnSeen("ses_turn_start")).toBe(false)
    expect(markTurnSeen("ses_turn_other")).toBe(true)
  })

  it("stamps memory mode from session.status idle events (deprecated session.idle successor)", async () => {
    process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
    const hooks = (await plugin.server({ client: {} } as any, undefined)) as any
    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_status_idle", status: { type: "idle" } } },
    })
    const { MemoryStore } = require("../src/store.js")
    expect(new MemoryStore().getMemoryMode("ses_status_idle")).toBe("enabled")
    // Non-idle status updates are ignored.
    await hooks.event({
      event: { type: "session.status", properties: { sessionID: "ses_busy", status: { type: "busy" } } },
    })
    expect(new MemoryStore().getMemoryMode("ses_busy")).toBe(null)
  })
})

describe("session deletion lifecycle", () => {
  it("schedules phase 2 when deletion enqueues forgetting", () => {
    const deleted: string[] = []
    let scheduled = 0
    handleSessionDeleted(
      "s1",
      {
        deleteSessionMemory(sessionId: string) {
          deleted.push(sessionId)
          return true
        },
      },
      () => { scheduled++ },
    )
    expect(deleted).toEqual(["s1"])
    expect(scheduled).toBe(1)
  })

  it("does not schedule phase 2 for an unconsolidated deletion", () => {
    let scheduled = 0
    handleSessionDeleted(
      "s1",
      { deleteSessionMemory: () => false },
      () => { scheduled++ },
    )
    expect(scheduled).toBe(0)
  })
})
