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
  delete process.env.OPENCODE_CODEX_MEMORY_HOME
  try {
    require("../src/options.js").resetPluginOptions()
  } catch {
  }
  try {
    require("../src/db.js").closeDb()
  } catch {
  }
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
})

describe("paths", () => {
  it("memoryRoot points to the memories dir", () => {
    const { memoryRoot } = require("../src/paths.js")
    expect(memoryRoot()).toBe(path.join(TEST_ROOT, "memories"))
  })

  it("memoryDbPath ends with memory.db", () => {
    const { memoryDbPath } = require("../src/paths.js")
    expect(memoryDbPath()).toBe(path.join(TEST_ROOT, "memory.db"))
  })

  it("memorySummaryPath is inside memoryRoot", () => {
    const { memorySummaryPath, memoryRoot } = require("../src/paths.js")
    expect(memorySummaryPath()).toBe(path.join(memoryRoot(), "memory_summary.md"))
  })
})

describe("memory home", () => {
  it("resolveHomePath expands ~ and rejects relative or empty", () => {
    const { resolveHomePath } = require("../src/paths.js")
    expect(resolveHomePath("~/sandbox-memory")).toBe(path.join(os.homedir(), "sandbox-memory"))
    expect(resolveHomePath("~")).toBe(os.homedir())
    expect(resolveHomePath("relative/path")).toBeNull()
    expect(resolveHomePath("  ")).toBeNull()
    expect(resolveHomePath("/abs/memory-home")).toBe(path.normalize("/abs/memory-home"))
  })

  it("TEST_ROOT wins over option and env", () => {
    process.env.OPENCODE_CODEX_MEMORY_HOME = path.join(TEST_ROOT, "from-env")
    const { applyPluginOptions } = require("../src/index.js")
    applyPluginOptions({ home: path.join(TEST_ROOT, "from-option") })
    const { dataRoot, memoryHomeSource } = require("../src/paths.js")
    expect(dataRoot()).toBe(TEST_ROOT)
    expect(memoryHomeSource()).toBe("test")
  })

  it("option relocates db and memories together", () => {
    delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    const home = path.join(TEST_ROOT, "sandbox-mount")
    const { applyPluginOptions } = require("../src/index.js")
    applyPluginOptions({ home })
    const { memoryRoot, memoryDbPath, dataRoot, memoryHomeSource } = require("../src/paths.js")
    expect(dataRoot()).toBe(home)
    expect(memoryRoot()).toBe(path.join(home, "memories"))
    expect(memoryDbPath()).toBe(path.join(home, "memory.db"))
    expect(memoryHomeSource()).toBe("option")
  })

  it("OPENCODE_CODEX_MEMORY_HOME relocates when option is unset", () => {
    delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    const home = path.join(TEST_ROOT, "from-env")
    process.env.OPENCODE_CODEX_MEMORY_HOME = home
    const { resetPluginOptions } = require("../src/options.js")
    resetPluginOptions()
    const { dataRoot, memoryRoot, memoryDbPath, memoryHomeSource } = require("../src/paths.js")
    expect(dataRoot()).toBe(home)
    expect(memoryRoot()).toBe(path.join(home, "memories"))
    expect(memoryDbPath()).toBe(path.join(home, "memory.db"))
    expect(memoryHomeSource()).toBe("env")
  })

  it("option wins over OPENCODE_CODEX_MEMORY_HOME and warns", () => {
    delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    const optionHome = path.join(TEST_ROOT, "from-option")
    process.env.OPENCODE_CODEX_MEMORY_HOME = path.join(TEST_ROOT, "from-env")
    const { applyPluginOptions } = require("../src/index.js")
    applyPluginOptions({ home: optionHome })
    const { dataRoot, memoryHomeSource } = require("../src/paths.js")
    const { getConfigWarnings } = require("../src/options.js")
    expect(dataRoot()).toBe(optionHome)
    expect(memoryHomeSource()).toBe("option")
    expect(getConfigWarnings().some((w: string) => w.includes("OPENCODE_CODEX_MEMORY_HOME ignored"))).toBe(true)
  })

  it("rejects a relative home option", () => {
    const { applyPluginOptions } = require("../src/index.js")
    applyPluginOptions({ home: "relative-memory" })
    const { getConfigWarnings, pluginOptions } = require("../src/options.js")
    expect(pluginOptions.home).toBeUndefined()
    expect(getConfigWarnings().some((w: string) => w.includes("absolute path"))).toBe(true)
  })

  it("openDb creates a missing home directory", () => {
    delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
    const home = path.join(TEST_ROOT, "nested", "memory-home")
    const { applyPluginOptions } = require("../src/index.js")
    applyPluginOptions({ home })
    const { openDb, closeDb } = require("../src/db.js")
    openDb()
    expect(fs.existsSync(path.join(home, "memory.db"))).toBe(true)
    closeDb()
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