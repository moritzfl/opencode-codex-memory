import { describe, expect, it } from "bun:test"
import { handleSessionDeleted } from "../src/index.js"
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
