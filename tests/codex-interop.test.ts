import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-interop-${process.pid}-${Date.now()}`)
const CODEX_HOME = path.join(TEST_ROOT, "codex-home")
const CODEX_MEM = path.join(CODEX_HOME, "memories")

beforeEach(() => {
  fs.mkdirSync(path.join(TEST_ROOT, "plugin"), { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = path.join(TEST_ROOT, "plugin")
  delete process.env.CODEX_HOME
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  delete process.env.CODEX_HOME
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {}
})

function interop() {
  return require("../src/codex-interop.js")
}
function pluginMemoryRoot(): string {
  return require("../src/paths.js").memoryRoot()
}
function seedCodexMemory(memory = "# Codex MEMORY\n\n- codex fact\n", summary = "v1\n\ncodex summary\n"): void {
  fs.mkdirSync(CODEX_MEM, { recursive: true })
  fs.writeFileSync(path.join(CODEX_MEM, "MEMORY.md"), memory)
  fs.writeFileSync(path.join(CODEX_MEM, "memory_summary.md"), summary)
}

describe("resolveCodexInterop", () => {
  it("returns null when both directions are disabled", () => {
    const { resolveCodexInterop } = interop()
    expect(resolveCodexInterop({ import: false, export: false })).toBeNull()
  })

  it("resolves codex_home option over CODEX_HOME env over ~/.codex", () => {
    const { resolveCodexInterop } = interop()
    process.env.CODEX_HOME = path.join(TEST_ROOT, "env-home")
    const viaOption = resolveCodexInterop({ import: true, export: false, codex_home: CODEX_HOME })
    expect(viaOption?.codexMemoryRoot).toBe(CODEX_MEM)
    const viaEnv = resolveCodexInterop({ import: true, export: false })
    expect(viaEnv?.codexMemoryRoot).toBe(path.join(TEST_ROOT, "env-home", "memories"))
    delete process.env.CODEX_HOME
    const viaDefault = resolveCodexInterop({ import: true, export: false })
    expect(viaDefault?.codexMemoryRoot).toBe(path.join(os.homedir(), ".codex", "memories"))
  })

  it("ignores an empty CODEX_HOME env like codex find_codex_home", () => {
    const { resolveCodexInterop } = interop()
    process.env.CODEX_HOME = ""
    const resolved = resolveCodexInterop({ import: true, export: false })
    expect(resolved?.codexMemoryRoot).toBe(path.join(os.homedir(), ".codex", "memories"))
  })

  it("fails closed when the codex memory root overlaps the plugin memory root", () => {
    const { resolveCodexInterop } = interop()
    // codex home = plugin data root → codex memories == plugin memories
    expect(resolveCodexInterop({ import: true, export: true, codex_home: path.join(TEST_ROOT, "plugin") })).toBeNull()
    // codex home inside the plugin memory root
    expect(
      resolveCodexInterop({ import: true, export: true, codex_home: path.join(pluginMemoryRoot(), "nested") }),
    ).toBeNull()
  })

  it("detects overlap through a symlinked codex home (inode identity)", () => {
    const { resolveCodexInterop } = interop()
    fs.mkdirSync(pluginMemoryRoot(), { recursive: true })
    const link = path.join(TEST_ROOT, "aliased-home")
    fs.symlinkSync(path.join(TEST_ROOT, "plugin"), link)
    expect(resolveCodexInterop({ import: true, export: true, codex_home: link })).toBeNull()
  })

  it("decides case-aliased roots by filesystem behavior, not platform guess", () => {
    const { resolveCodexInterop } = interop()
    fs.mkdirSync(pluginMemoryRoot(), { recursive: true })
    // Case-variant of the plugin data root ("plugin" → "PLUGIN").
    const variantHome = path.join(TEST_ROOT, "PLUGIN")
    const aliased = fs.existsSync(variantHome) // does this fs fold case?
    const resolved = resolveCodexInterop({ import: true, export: true, codex_home: variantHome })
    if (aliased) {
      // case-insensitive volume: same directory → must fail closed
      expect(resolved).toBeNull()
    } else {
      // case-sensitive volume: genuinely different directory → stays enabled
      // (inode ground truth beats the lexical case-folding guess)
      fs.mkdirSync(path.join(variantHome, "memories"), { recursive: true })
      expect(resolveCodexInterop({ import: true, export: true, codex_home: variantHome })).not.toBeNull()
    }
  })
})

describe("syncCodexImport", () => {
  it("creates nothing when the codex memory does not exist", () => {
    const { syncCodexImport } = interop()
    expect(syncCodexImport(CODEX_MEM)).toBe(false)
    expect(fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "codex_import"))).toBe(false)
  })

  it("copies codex artifacts into the extension and is idempotent", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    expect(syncCodexImport(CODEX_MEM)).toBe(true)
    const extDir = path.join(pluginMemoryRoot(), "extensions", "codex_import")
    const instructions = fs.readFileSync(path.join(extDir, "instructions.md"), "utf8")
    expect(instructions).toContain("[from codex]")
    expect(instructions).toContain("extension_resource_files")
    expect(fs.readFileSync(path.join(extDir, "resources", "codex", "MEMORY.md"), "utf8")).toContain("codex fact")
    expect(fs.readFileSync(path.join(extDir, "resources", "codex", "memory_summary.md"), "utf8")).toStartWith("v1")
    // unchanged source → no workspace change
    expect(syncCodexImport(CODEX_MEM)).toBe(false)
  })

  it("re-syncs changed artifacts and drops copies whose source disappeared", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    syncCodexImport(CODEX_MEM)
    fs.writeFileSync(path.join(CODEX_MEM, "MEMORY.md"), "# Codex MEMORY\n\n- updated fact\n")
    fs.unlinkSync(path.join(CODEX_MEM, "memory_summary.md"))
    expect(syncCodexImport(CODEX_MEM)).toBe(true)
    const resDir = path.join(pluginMemoryRoot(), "extensions", "codex_import", "resources", "codex")
    expect(fs.readFileSync(path.join(resDir, "MEMORY.md"), "utf8")).toContain("updated fact")
    expect(fs.existsSync(path.join(resDir, "memory_summary.md"))).toBe(false)
  })

  it("removes all resources when the codex artifacts are gone, keeping instructions", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    syncCodexImport(CODEX_MEM)
    // memories root still exists — only the artifacts disappeared
    fs.unlinkSync(path.join(CODEX_MEM, "MEMORY.md"))
    fs.unlinkSync(path.join(CODEX_MEM, "memory_summary.md"))
    expect(syncCodexImport(CODEX_MEM)).toBe(true)
    const extDir = path.join(pluginMemoryRoot(), "extensions", "codex_import")
    expect(fs.existsSync(path.join(extDir, "resources", "codex"))).toBe(false)
    expect(fs.existsSync(path.join(extDir, "instructions.md"))).toBe(true)
    // gone and already cleaned → nothing to do
    expect(syncCodexImport(CODEX_MEM)).toBe(false)
  })

  it("treats an unreachable codex root as no-op, never as a deletion signal", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    syncCodexImport(CODEX_MEM)
    // whole codex home vanishes (unmounted disk, wrong codex_home, missing env)
    fs.rmSync(CODEX_HOME, { recursive: true, force: true })
    expect(syncCodexImport(CODEX_MEM)).toBe(false)
    const resDir = path.join(pluginMemoryRoot(), "extensions", "codex_import", "resources", "codex")
    expect(fs.readdirSync(resDir).sort()).toEqual(["MEMORY.md", "memory_summary.md"])
  })

  it("replaces a symlink at a target path instead of writing through it", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    const victim = path.join(TEST_ROOT, "victim.md")
    fs.writeFileSync(victim, "victim content")
    const resDir = path.join(pluginMemoryRoot(), "extensions", "codex_import", "resources", "codex")
    fs.mkdirSync(resDir, { recursive: true })
    fs.symlinkSync(victim, path.join(resDir, "MEMORY.md"))
    expect(syncCodexImport(CODEX_MEM)).toBe(true)
    expect(fs.readFileSync(victim, "utf8")).toBe("victim content")
    expect(fs.lstatSync(path.join(resDir, "MEMORY.md")).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(resDir, "MEMORY.md"), "utf8")).toContain("codex fact")
  })

  it("first-run ordering: baseline before sync surfaces copies as additions in the diff", async () => {
    const { syncCodexImport } = interop()
    const { ensureLayout } = require("../src/workspace.js")
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    seedCodexMemory()
    // phase-2 order: layout → baseline (fresh init commits current state) → sync → diff
    ensureLayout()
    expect(await ensureBaseline()).toBe(true)
    expect(syncCodexImport(CODEX_MEM)).toBe(true)
    const diff = await captureWorkspaceDiff()
    const added = diff.changes.filter((c: { status: string; path: string }) => c.status === "A").map((c: { path: string }) => c.path)
    expect(added).toContain("extensions/codex_import/resources/codex/MEMORY.md")
    expect(added).toContain("extensions/codex_import/resources/codex/memory_summary.md")
    expect(added).toContain("extensions/codex_import/instructions.md")
  })

  it("imported resources survive extension pruning (nested, untimestamped)", () => {
    const { syncCodexImport } = interop()
    const { ensureLayout, pruneExtensionResources } = require("../src/workspace.js")
    ensureLayout()
    seedCodexMemory()
    syncCodexImport(CODEX_MEM)
    pruneExtensionResources(0)
    const resDir = path.join(pluginMemoryRoot(), "extensions", "codex_import", "resources", "codex")
    expect(fs.readdirSync(resDir).sort()).toEqual(["MEMORY.md", "memory_summary.md"])
  })
})

describe("exportToCodexMemory", () => {
  function seedPluginMemory(): void {
    const root = pluginMemoryRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "MEMORY.md"), "# MEMORY.md\n\n- opencode fact\n")
    fs.writeFileSync(path.join(root, "memory_summary.md"), "v1\n\nopencode summary\n")
  }

  it("never bootstraps a missing codex memory workspace", () => {
    const { exportToCodexMemory } = interop()
    seedPluginMemory()
    expect(exportToCodexMemory(CODEX_MEM)).toBe(false)
    expect(fs.existsSync(CODEX_MEM)).toBe(false)
  })

  it("does not export unconsolidated artifacts (summary without v1 header)", () => {
    const { exportToCodexMemory } = interop()
    fs.mkdirSync(CODEX_MEM, { recursive: true })
    const root = pluginMemoryRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "MEMORY.md"), "# MEMORY.md\n")
    fs.writeFileSync(path.join(root, "memory_summary.md"), "")
    expect(exportToCodexMemory(CODEX_MEM)).toBe(false)
    expect(fs.existsSync(path.join(CODEX_MEM, "extensions"))).toBe(false)
  })

  it("writes the opencode_import extension into the codex workspace and is idempotent", () => {
    const { exportToCodexMemory } = interop()
    fs.mkdirSync(CODEX_MEM, { recursive: true })
    seedPluginMemory()
    expect(exportToCodexMemory(CODEX_MEM)).toBe(true)
    const extDir = path.join(CODEX_MEM, "extensions", "opencode_import")
    const instructions = fs.readFileSync(path.join(extDir, "instructions.md"), "utf8")
    expect(instructions).toContain("[from opencode]")
    expect(instructions).toContain("extension_resource_files")
    expect(fs.readFileSync(path.join(extDir, "resources", "opencode", "MEMORY.md"), "utf8")).toContain("opencode fact")
    expect(fs.readFileSync(path.join(extDir, "resources", "opencode", "memory_summary.md"), "utf8")).toStartWith("v1")
    expect(exportToCodexMemory(CODEX_MEM)).toBe(false)
  })
})
