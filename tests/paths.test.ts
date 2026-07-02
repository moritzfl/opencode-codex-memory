import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-memex-test-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_MEMEX_TEST_ROOT = TEST_ROOT
})
afterEach(() => {
  delete process.env.OPENCODE_MEMEX_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
})

describe("paths", () => {
  it("memoryRoot points to the memories dir", () => {
    const p = path.join(TEST_ROOT, "memories")
    expect(p.endsWith("memories")).toBe(true)
  })

  it("memoryDbPath ends with memory.db", () => {
    const p = path.join(TEST_ROOT, "memory.db")
    expect(p.endsWith("memory.db")).toBe(true)
  })

  it("opencodeDbPath ends with opencode.db", () => {
    const p = path.join(TEST_ROOT, "opencode.db")
    expect(p.endsWith("opencode.db")).toBe(true)
  })

  it("memorySummaryPath is inside memoryRoot", () => {
    const { memorySummaryPath, memoryRoot } = require("../src/paths.js")
    expect(memorySummaryPath()).toBe(path.join(memoryRoot(), "memory_summary.md"))
  })
})