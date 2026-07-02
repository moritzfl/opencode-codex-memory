import { describe, it, expect } from "bun:test"
import { memoryRoot, memoryDbPath, opencodeDbPath, memorySummaryPath } from "../src/paths.js"

describe("paths", () => {
  it("memoryRoot points to ~/.local/share/opencode/memories", () => {
    const p = memoryRoot()
    expect(p).toMatch(/opencode\/memories$/)
  })

  it("memoryDbPath points to ~/.local/share/opencode/memory.db", () => {
    const p = memoryDbPath()
    expect(p).toMatch(/opencode\/memory\.db$/)
  })

  it("opencodeDbPath points to ~/.local/share/opencode/opencode.db", () => {
    const p = opencodeDbPath()
    expect(p).toMatch(/opencode\/opencode\.db$/)
  })

  it("memorySummaryPath is inside memoryRoot", () => {
    const p = memorySummaryPath()
    expect(p).toMatch(/memories\/memory_summary\.md$/)
  })
})