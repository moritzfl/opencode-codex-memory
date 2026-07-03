import { describe, it, expect } from "bun:test"
import { parseExtraction, fillTemplate } from "../src/llm.js"

describe("fillTemplate", () => {
  it("substitutes placeholders", () => {
    expect(fillTemplate("id: {{ session_id }}", { session_id: "s1" })).toBe("id: s1")
  })

  it("does not expand $-patterns in the value", () => {
    const out = fillTemplate("body: {{ transcript }}", { transcript: "price is $& and $' and $1" })
    expect(out).toBe("body: price is $& and $' and $1")
  })
})

describe("parseExtraction", () => {
  it("parses a clean JSON object", () => {
    const raw = JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "slug-1" })
    const r = parseExtraction(raw)!
    expect(r.raw_memory).toBe("rm")
    expect(r.rollout_summary).toBe("rs")
    expect(r.rollout_slug).toBe("slug-1")
  })

  it("parses JSON wrapped in code fences", () => {
    const raw = "```json\n" + JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "x" }) + "\n```"
    expect(parseExtraction(raw)!.raw_memory).toBe("rm")
  })

  it("parses JSON embedded in prose", () => {
    const raw = "Here is the result:\n" + JSON.stringify({ raw_memory: "rm", rollout_summary: "rs" }) + "\nDone."
    const r = parseExtraction(raw)!
    expect(r.raw_memory).toBe("rm")
    expect(r.rollout_slug).toBeNull()
  })

  it("returns null for the all-empty no-op response", () => {
    const raw = JSON.stringify({ raw_memory: "", rollout_summary: "", rollout_slug: "" })
    expect(parseExtraction(raw)).toBeNull()
  })

  it("treats a whitespace-only response as a no-op", () => {
    const raw = JSON.stringify({ raw_memory: "  \n", rollout_summary: " ", rollout_slug: "" })
    expect(parseExtraction(raw)).toBeNull()
  })

  it("normalizes an empty slug to null", () => {
    const raw = JSON.stringify({ raw_memory: "rm", rollout_summary: "rs", rollout_slug: "" })
    expect(parseExtraction(raw)!.rollout_slug).toBeNull()
  })

  it("throws when no JSON object is present", () => {
    expect(() => parseExtraction("no json here")).toThrow()
  })

  it("throws when required fields are missing", () => {
    expect(() => parseExtraction(JSON.stringify({ rollout_summary: "rs" }))).toThrow()
  })

  it("throws when raw_memory echoes the template skeleton", () => {
    const raw = JSON.stringify({
      raw_memory: "task_outcome: <success|partial|fail|uncertain>",
      rollout_summary: "rs",
      rollout_slug: "slug",
    })
    expect(() => parseExtraction(raw)).toThrow()
  })
})
