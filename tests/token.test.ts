import { describe, it, expect } from "bun:test"
import { MEMORY_V2_SUMMARY_MAX_BYTES, estimateTokens, truncateToBytes, truncateToTokens } from "../src/token.js"

describe("estimateTokens", () => {
  it("estimates tokens as chars/4", () => {
    expect(estimateTokens("")).toBe(0)
    expect(estimateTokens("hello")).toBe(1) // 5 chars / 4 = 1.25 → round → 1
    expect(estimateTokens("hello world")).toBe(3) // 11 chars / 4 = 2.75 → round → 3
  })
})

describe("truncateToTokens", () => {
  it("returns input when under limit", () => {
    expect(truncateToTokens("hello", 10)).toBe("hello")
  })

  it("truncates when over limit", () => {
    const input = "a".repeat(100)
    const result = truncateToTokens(input, 10) // 10 tokens = 40 chars
    expect(result.length).toBe(40)
  })

  it("handles 2500 token limit (10000 chars)", () => {
    const input = "x".repeat(15000)
    const result = truncateToTokens(input, 2500)
    expect(result.length).toBe(10000)
  })
})
describe("truncateToTokens middle truncation", () => {
  it("keeps head and tail with a marker like codex truncate_with_head_and_tail", () => {
    const { truncateToTokens } = require("../src/token.js")
    const input = "H".repeat(6000) + "T".repeat(6000)
    const out = truncateToTokens(input, 2500)
    expect(out.length).toBeLessThanOrEqual(10000)
    expect(out.startsWith("H")).toBe(true)
    expect(out.endsWith("T")).toBe(true)
    expect(out).toContain("[...truncated...]")
  })
})

describe("truncateToBytes", () => {
  it("preserves summaries at the exact byte limit", () => {
    const input = "ö".repeat(4999) + "x"
    expect(Buffer.byteLength(input)).toBe(MEMORY_V2_SUMMARY_MAX_BYTES)
    expect(truncateToBytes(input, MEMORY_V2_SUMMARY_MAX_BYTES)).toBe(input)
  })

  it.each(["x", "ö", "€", "😀"])("bounds %s summaries including the marker without splitting UTF-8", (char) => {
    const input = "HEAD\n" + char.repeat(12000) + "\nTAIL"
    const output = truncateToBytes(input, MEMORY_V2_SUMMARY_MAX_BYTES)
    expect(Buffer.byteLength(output)).toBeLessThan(10000)
    expect(output.startsWith("HEAD\n")).toBe(true)
    expect(output.endsWith("\nTAIL")).toBe(true)
    expect(output).toContain("[...truncated...]")
    expect(output).not.toContain("\uFFFD")
    expect(output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
  })
})
