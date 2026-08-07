import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { handleSessionDeleted, shouldHandleIdle } from "../src/index.js"
import {
  beginPhase2AbortScope,
  beginPluginShutdown,
  isPluginShuttingDown,
  resetPluginLifecycle,
} from "../src/lifecycle.js"
import plugin from "../src/index.js"

describe("hook wiring", () => {
  it("registers tool.execute.before as a top-level hook (not an event-bus type)", async () => {
    // Regression: pollution marking once lived inside the event() bus handler
    // under a nonexistent "tool.execute.*" event type and never fired.
    const hooks = (await plugin.server({ client: {} } as any, undefined)) as Record<string, unknown>
    expect(typeof hooks["tool.execute.before"]).toBe("function")
    expect(typeof hooks.event).toBe("function")
  })

  it("finishes sub-session reseeding before exposing hooks", async () => {
    let resolveList!: (value: unknown) => void
    const listResult = new Promise((resolve) => {
      resolveList = resolve
    })
    let settled = false
    const serverPromise = plugin.server(
      { client: { session: { list: () => listResult } } } as any,
      undefined,
    ).then((hooks) => {
      settled = true
      return hooks
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    resolveList({
      data: [
        {
          id: "sub-reseed-before-hooks",
          title: "codex-memory-consolidate",
          metadata: { "opencode-codex-memory": true },
          time: { created: Date.now() },
        },
      ],
    })
    await serverPromise

    const { isMemorySubSession } = require("../src/llm.js")
    expect(isMemorySubSession("sub-reseed-before-hooks")).toBe(true)
  })

  it("marks pollution without ever seeing tool.execute.after", async () => {
    // opencode skips tool.execute.after when the tool throws or the turn is
    // aborted (session/tools.ts has no ensuring/catchAll), so marking must not
    // depend on it. codex marks before the call runs (mcp_tool_call.rs).
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-pollution-before-"))
    const previousRoot = process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    try {
      require("../src/db.js").closeDb()
      process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = testRoot
      const hooks = (await plugin.server(
        { client: {} } as any,
        { disable_on_external_context: true } as any,
      )) as any
      expect(hooks["tool.execute.after"]).toBeUndefined()
      // Only the before hook fires — the tool then "throws".
      await hooks["tool.execute.before"]({ tool: "webfetch", sessionID: "ses_failed_fetch", callID: "c1" })
      const { MemoryStore } = require("../src/store.js")
      expect(new MemoryStore().getMemoryMode("ses_failed_fetch")).toBe("polluted")
    } finally {
      await plugin.server({ client: {} } as any, { disable_on_external_context: false } as any)
      require("../src/db.js").closeDb()
      if (previousRoot === undefined) delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
      else process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = previousRoot
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
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

      const { MemoryStore } = require("../src/store.js")
      // Sanitized server name: "first.server" -> tool prefix "first_server_".
      await hooks["tool.execute.before"]({ tool: "first_server_tool", sessionID: "ses_first", callID: "call_1" })
      expect(new MemoryStore().getMemoryMode("ses_first")).toBe("polluted")

      // A server connected later is picked up (status is queried live, never
      // cached with a TTL).
      statusResponse = { data: { "added.later": { status: "connected" } } }
      await hooks["tool.execute.before"]({ tool: "added_later_tool", sessionID: "ses_added", callID: "call_2" })
      expect(new MemoryStore().getMemoryMode("ses_added")).toBe("polluted")

      // A local (non-MCP) tool never marks.
      statusResponse = { data: {} }
      await hooks["tool.execute.before"]({ tool: "local_tool", sessionID: "ses_local", callID: "call_3" })
      expect(new MemoryStore().getMemoryMode("ses_local")).toBeNull()

      // Web tools classify without consulting MCP status at all.
      statusResponse = { data: undefined, error: { message: "status failed" } }
      await hooks["tool.execute.before"]({ tool: "websearch", sessionID: "ses_web", callID: "call_4" })
      expect(new MemoryStore().getMemoryMode("ses_web")).toBe("polluted")
      // ...but an unclassifiable MCP tool stays unmarked when status is down.
      await hooks["tool.execute.before"]({ tool: "error_tool", sessionID: "ses_error", callID: "call_5" })
      expect(new MemoryStore().getMemoryMode("ses_error")).toBeNull()
    } finally {
      await plugin.server({ client: {} } as any, { disable_on_external_context: false } as any)
      require("../src/db.js").closeDb()
      if (previousRoot === undefined) delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
      else process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = previousRoot
      fs.rmSync(testRoot, { recursive: true, force: true })
    }
  })

  it("bounds a stalled MCP status lookup before tool execution", async () => {
    const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-memory-mcp-timeout-"))
    const previousRoot = process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    let statusSignal: AbortSignal | undefined
    try {
      require("../src/db.js").closeDb()
      process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = testRoot
      const hooks = (await plugin.server(
        {
          client: {
            session: { list: async () => ({ data: [] }) },
            mcp: {
              status: async (options: { signal?: AbortSignal }) => {
                statusSignal = options.signal
                return new Promise(() => {})
              },
            },
          },
        } as any,
        { disable_on_external_context: true } as any,
      )) as any

      const started = Date.now()
      await hooks["tool.execute.before"]({ tool: "local_tool", sessionID: "ses_stalled_mcp", callID: "call_1" })
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(statusSignal?.aborted).toBe(true)
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

  it("does not extend the dedup window through a stream of twins", () => {
    expect(shouldHandleIdle("ses_stream", 0)).toBe(true)
    // Repeated twins keep the ORIGINAL stamp, so the 5s window still expires
    // on schedule instead of sliding forward with every event.
    expect(shouldHandleIdle("ses_stream", 2000)).toBe(false)
    expect(shouldHandleIdle("ses_stream", 4000)).toBe(false)
    expect(shouldHandleIdle("ses_stream", 5001)).toBe(true)
  })

  it("evicts least-recently-used idle entries, not first-inserted", () => {
    // Cap is 500. Insert the victim first, then fill to the cap.
    expect(shouldHandleIdle("lru_keep", 0)).toBe(true)
    for (let i = 0; i < 499; i++) expect(shouldHandleIdle(`lru_filler_${i}`, 0)).toBe(true)
    // Touch the oldest entry: dedup path must still refresh its LRU position.
    expect(shouldHandleIdle("lru_keep", 1)).toBe(false)
    // Overflow by one: the evicted entry is filler_0, not the refreshed one.
    expect(shouldHandleIdle("lru_overflow", 0)).toBe(true)
    // Still tracked (deduped) => survived eviction.
    expect(shouldHandleIdle("lru_keep", 2)).toBe(false)
    // Evicted => treated as unseen, so it is handled again.
    expect(shouldHandleIdle("lru_filler_0", 1)).toBe(true)
  })

  it("evicts least-recently-used turn sessions, not first-inserted", () => {
    const { markTurnSeen } = require("../src/index.js")
    // Cap is 1000; this test owns a fresh key space.
    expect(markTurnSeen("turn_keep")).toBe(true)
    for (let i = 0; i < 999; i++) expect(markTurnSeen(`turn_filler_${i}`)).toBe(true)
    // Re-marking refreshes LRU order without changing the "already seen" answer.
    expect(markTurnSeen("turn_keep")).toBe(false)
    expect(markTurnSeen("turn_overflow")).toBe(true)
    expect(markTurnSeen("turn_keep")).toBe(false)
    expect(markTurnSeen("turn_filler_0")).toBe(true)
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

describe("plugin lifecycle reset", () => {
  afterEach(() => {
    resetPluginLifecycle()
  })

  it("aborts an in-scope consolidator signal before clearing on reset", () => {
    const signal = beginPhase2AbortScope()
    expect(signal.aborted).toBe(false)
    beginPluginShutdown()
    expect(isPluginShuttingDown()).toBe(true)
    expect(signal.aborted).toBe(true)

    // Re-boot without an explicit dispose of a second scope must still abort.
    const signal2 = beginPhase2AbortScope()
    expect(signal2.aborted).toBe(false)
    resetPluginLifecycle()
    expect(signal2.aborted).toBe(true)
    expect(isPluginShuttingDown()).toBe(false)
  })
})
