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
    expect(typeof hooks["tool.execute.after"]).toBe("function")
    expect(typeof hooks.event).toBe("function")
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
