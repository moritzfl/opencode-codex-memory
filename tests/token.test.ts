import { describe, it, expect } from "bun:test"
import { estimateTokens, truncateToTokens } from "../src/token.js"

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