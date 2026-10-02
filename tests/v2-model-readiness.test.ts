import { beforeEach, describe, expect, it } from "bun:test"
import { getRecentDiagnostics, resetDiagnosticsForTest } from "../src/diagnostics.js"
import { isModelSelectionUnavailable, retryModelSelection } from "../src/v2/model-readiness.js"

const model = { providerID: "openai", id: "gpt-6-luna" }
const unavailable = { _tag: "InvalidRequestError", message: "Model unavailable: openai/gpt-6-luna" }

beforeEach(resetDiagnosticsForTest)

describe("V2 model startup readiness", () => {
  it("recognizes exact host errors, including SDK wrappers and local generation", () => {
    expect(isModelSelectionUnavailable(unavailable, model)).toBe(true)
    expect(isModelSelectionUnavailable(new Error("SDK error", { cause: unavailable }), model)).toBe(true)
    expect(isModelSelectionUnavailable({ error: unavailable }, model)).toBe(true)
    expect(isModelSelectionUnavailable({ ...unavailable, _tag: "Generate.ModelSelectionError" }, model)).toBe(true)
    expect(isModelSelectionUnavailable({ ...unavailable, message: "No model specified and no supported model is available" })).toBe(true)
    const cyclic: any = { cause: null }
    cyclic.cause = cyclic
    expect(isModelSelectionUnavailable(cyclic, model)).toBe(false)
  })

  it.each([
    new Error("fetch failed"),
    { _tag: "ServiceUnavailableError", message: unavailable.message },
    { ...unavailable, message: "Variant unavailable for openai/gpt-6-luna: low" },
    { ...unavailable, message: "Model unavailable: openai/different" },
    { ...unavailable, message: "Bad schema" },
    { status: 429, message: "Rate limit" },
    { status: 401, message: "Unauthorized" },
  ])("does not replay transport/provider/config errors (%j)", async (error) => {
    let calls = 0
    await expect(retryModelSelection(async () => { calls++; throw error }, model, undefined, [0, 0])).rejects.toBe(error)
    expect(calls).toBe(1)
    expect(getRecentDiagnostics()).toEqual([])
  })

  it("waits through missing registrations and succeeds without changing the model", async () => {
    let calls = 0
    await expect(retryModelSelection(async () => {
      if (++calls < 3) throw unavailable
      return "OK"
    }, model, undefined, [0, 0])).resolves.toBe("OK")
    expect(calls).toBe(3)
    expect(getRecentDiagnostics().map((event) => event.level)).toEqual(["warn", "info"])
  })

  it("bounds persistent absence and preserves the original error", async () => {
    let calls = 0
    await expect(retryModelSelection(async () => { calls++; throw unavailable }, model, undefined, [0, 0])).rejects.toBe(unavailable)
    expect(calls).toBe(3)
    expect(getRecentDiagnostics().at(-1)?.message).toContain("still unavailable")
  })

  it("cancels the backoff immediately without another generation request", async () => {
    let calls = 0
    const controller = new AbortController()
    const result = retryModelSelection(async () => { calls++; throw unavailable }, model, controller.signal, [60_000])
    await Promise.resolve()
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(1)
  })

  it("does not start generation when already cancelled", async () => {
    let calls = 0
    const controller = new AbortController()
    controller.abort()
    await expect(retryModelSelection(async () => { calls++ }, model, controller.signal)).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(0)
  })
})
