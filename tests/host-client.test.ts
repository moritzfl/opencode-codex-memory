import { describe, expect, it } from "bun:test"
import { hostListSessionsGlobal, withHostTimeout } from "../src/host-client.js"

describe("withHostTimeout", () => {
  it("aborts the controller when the timeout wins", async () => {
    const controller = new AbortController()
    await expect(withHostTimeout(new Promise(() => {}), 20, "hung", controller)).rejects.toThrow(
      "hung timed out after 20ms",
    )
    expect(controller.signal.aborted).toBe(true)
  })

  it("does not surface a late rejection after the timeout wins", async () => {
    let rejectLate!: (err: Error) => void
    const pending = new Promise<void>((_, reject) => {
      rejectLate = reject
    })
    await expect(withHostTimeout(pending, 20, "late")).rejects.toThrow("timed out")
    let unhandled: unknown
    const onUnhandled = (err: unknown) => {
      unhandled = err
    }
    process.on("unhandledRejection", onUnhandled)
    rejectLate(new Error("late reject"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    process.off("unhandledRejection", onUnhandled)
    expect(unhandled).toBeUndefined()
  })
})

describe("hostListSessionsGlobal", () => {
  it("calls experimental.session with roots, limit, and empty directory", async () => {
    const seen: { url?: string; query?: unknown; signal?: AbortSignal } = {}
    const client = {
      _client: {
        get: async (opts: { url?: string; query?: unknown; signal?: AbortSignal }) => {
          seen.url = opts.url
          seen.query = opts.query
          seen.signal = opts.signal
          return { data: [] }
        },
      },
    }
    const controller = new AbortController()
    await hostListSessionsGlobal(client as never, { limit: 17, signal: controller.signal })
    expect(seen.url).toBe("/experimental/session")
    expect(seen.query).toEqual({ roots: true, limit: 17, directory: "" })
    expect(seen.signal).toBe(controller.signal)
  })
})
