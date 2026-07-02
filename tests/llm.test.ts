import { describe, it, expect } from "bun:test"
import { parseExtraction } from "../src/llm.js"

describe("parseExtraction", () => {
  it("parses a clean JSON object", () => {
    const raw = JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "slug-1" })
    const r = parseExtraction(raw)
    expect(r.raw_memory).toBe("rm")
    expect(r.rollout_summary).toBe("rs")
    expect(r.rollout_slug).toBe("slug-1")
  })

  it("parses JSON wrapped in code fences", () => {
    const raw = "```json\n" + JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "x" }) + "\n```"
    expect(parseExtraction(raw).raw_memory).toBe("rm")
  })

  it("parses JSON embedded in prose", () => {
    const raw = "Here is the result:\n" + JSON.stringify({ raw_memory: "rm", rollout_summary: "rs" }) + "\nDone."
    const r = parseExtraction(raw)
    expect(r.raw_memory).toBe("rm")
    expect(r.rollout_slug).toBeNull()
  })

  it("throws when no JSON object is present", () => {
    expect(() => parseExtraction("no json here")).toThrow()
  })

  it("throws when required fields are missing", () => {
    expect(() => parseExtraction(JSON.stringify({ rollout_summary: "rs" }))).toThrow()
  })
})