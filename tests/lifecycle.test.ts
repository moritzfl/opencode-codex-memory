import { describe, expect, it } from "bun:test"
import { handleSessionDeleted } from "../src/index.js"

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
