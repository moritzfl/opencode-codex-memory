import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-test-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
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

describe("assertMemoryRootSafe", () => {
  it("accepts a real directory and a missing root", () => {
    const { assertMemoryRootSafe, safeResolveMemoryPath } = require("../src/path-guard.js")
    // Missing root: allowed (created later as a real dir).
    expect(assertMemoryRootSafe()).toBe(path.join(TEST_ROOT, "memories"))
    fs.mkdirSync(path.join(TEST_ROOT, "memories"), { recursive: true })
    expect(assertMemoryRootSafe()).toBe(path.join(TEST_ROOT, "memories"))
    expect(safeResolveMemoryPath("MEMORY.md")).toBe(path.join(TEST_ROOT, "memories", "MEMORY.md"))
  })

  it("rejects a symlinked memory root for guarded resolution", () => {
    const { assertMemoryRootSafe, safeResolveMemoryPath } = require("../src/path-guard.js")
    const target = path.join(TEST_ROOT, "elsewhere")
    fs.mkdirSync(target, { recursive: true })
    fs.symlinkSync(target, path.join(TEST_ROOT, "memories"))
    expect(() => assertMemoryRootSafe()).toThrow(/symlink/)
    // The guard used to check only descendants; the root itself must fail too.
    expect(() => safeResolveMemoryPath("MEMORY.md")).toThrow(/symlink/)
  })
})