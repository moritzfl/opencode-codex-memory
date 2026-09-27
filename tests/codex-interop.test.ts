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
  const { applyPluginOptions } = require("../src/index.js")
  applyPluginOptions({})
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

  it("disables handbook exchange while version=v2", () => {
    const { applyPluginOptions } = require("../src/index.js")
    const { resolveCodexInterop } = interop()
    applyPluginOptions({ version: "v2" })
    expect(resolveCodexInterop({ import: true, export: true, codex_home: CODEX_HOME })).toBeNull()
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
    expect(viaDefault?.codexMemoryRoot).toBe(path.join(os.homedir(), ".codex", viaDefault?.codexVersion === "v2" ? "memories_v2" : "memories"))
  })

  it("ignores an empty CODEX_HOME env like codex find_codex_home", () => {
    const { resolveCodexInterop } = interop()
    process.env.CODEX_HOME = ""
    const resolved = resolveCodexInterop({ import: true, export: false })
    expect(resolved?.codexMemoryRoot).toBe(path.join(os.homedir(), ".codex", resolved?.codexVersion === "v2" ? "memories_v2" : "memories"))
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
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(false)
    expect(fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "codex_import"))).toBe(false)
  })

  it("copies codex artifacts into the extension and is idempotent", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(true)
    const extDir = path.join(pluginMemoryRoot(), "extensions", "codex_import")
    const instructions = fs.readFileSync(path.join(extDir, "instructions.md"), "utf8")
    expect(instructions).toContain("[from codex]")
    expect(instructions).toContain("extension_resource_files")
    expect(fs.readFileSync(path.join(extDir, "resources", "codex", "MEMORY.md"), "utf8")).toContain("codex fact")
    expect(fs.readFileSync(path.join(extDir, "resources", "codex", "memory_summary.md"), "utf8")).toStartWith("v1")
    // unchanged source → no workspace change
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(false)
  })

  it("re-syncs changed artifacts and drops copies whose source disappeared", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    syncCodexImport(CODEX_MEM, "v1")
    fs.writeFileSync(path.join(CODEX_MEM, "MEMORY.md"), "# Codex MEMORY\n\n- updated fact\n")
    fs.unlinkSync(path.join(CODEX_MEM, "memory_summary.md"))
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(true)
    const resDir = path.join(pluginMemoryRoot(), "extensions", "codex_import", "resources", "codex")
    expect(fs.readFileSync(path.join(resDir, "MEMORY.md"), "utf8")).toContain("updated fact")
    expect(fs.existsSync(path.join(resDir, "memory_summary.md"))).toBe(false)
  })

  it("removes all resources when the codex artifacts are gone, keeping instructions", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    syncCodexImport(CODEX_MEM, "v1")
    // memories root still exists — only the artifacts disappeared
    fs.unlinkSync(path.join(CODEX_MEM, "MEMORY.md"))
    fs.unlinkSync(path.join(CODEX_MEM, "memory_summary.md"))
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(true)
    const extDir = path.join(pluginMemoryRoot(), "extensions", "codex_import")
    expect(fs.existsSync(path.join(extDir, "resources", "codex"))).toBe(false)
    expect(fs.existsSync(path.join(extDir, "instructions.md"))).toBe(true)
    // gone and already cleaned → nothing to do
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(false)
  })

  it("treats an unreachable codex root as no-op, never as a deletion signal", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    syncCodexImport(CODEX_MEM, "v1")
    // whole codex home vanishes (unmounted disk, wrong codex_home, missing env)
    fs.rmSync(CODEX_HOME, { recursive: true, force: true })
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(false)
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
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(true)
    expect(fs.readFileSync(victim, "utf8")).toBe("victim content")
    expect(fs.lstatSync(path.join(resDir, "MEMORY.md")).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(resDir, "MEMORY.md"), "utf8")).toContain("codex fact")
  })

  it("refuses to import through a symlinked extension directory", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    const outside = path.join(TEST_ROOT, "outside-import")
    const extensions = path.join(pluginMemoryRoot(), "extensions")
    fs.mkdirSync(extensions, { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(extensions, "codex_import"))

    expect(() => syncCodexImport(CODEX_MEM, "v1")).toThrow(/symlinks are not allowed/)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it("first-run ordering: baseline before sync surfaces copies as additions in the diff", async () => {
    const { syncCodexImport } = interop()
    const { ensureLayout } = require("../src/workspace.js")
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    seedCodexMemory()
    // phase-2 order: layout → baseline (fresh init commits current state) → sync → diff
    ensureLayout()
    expect(await ensureBaseline()).toBe(true)
    expect(syncCodexImport(CODEX_MEM, "v1")).toBe(true)
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
    syncCodexImport(CODEX_MEM, "v1")
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
    expect(exportToCodexMemory(CODEX_MEM, "v1")).toBe(false)
    expect(fs.existsSync(CODEX_MEM)).toBe(false)
  })

  it("does not export unconsolidated artifacts (summary without v1 header)", () => {
    const { exportToCodexMemory } = interop()
    fs.mkdirSync(CODEX_MEM, { recursive: true })
    const root = pluginMemoryRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "MEMORY.md"), "# MEMORY.md\n")
    fs.writeFileSync(path.join(root, "memory_summary.md"), "")
    expect(exportToCodexMemory(CODEX_MEM, "v1")).toBe(false)
    expect(fs.existsSync(path.join(CODEX_MEM, "extensions"))).toBe(false)
  })

  it("writes the opencode_import extension into the codex workspace and is idempotent", () => {
    const { exportToCodexMemory } = interop()
    fs.mkdirSync(CODEX_MEM, { recursive: true })
    seedPluginMemory()
    expect(exportToCodexMemory(CODEX_MEM, "v1")).toBe(true)
    const extDir = path.join(CODEX_MEM, "extensions", "opencode_import")
    const instructions = fs.readFileSync(path.join(extDir, "instructions.md"), "utf8")
    expect(instructions).toContain("[from opencode]")
    expect(instructions).toContain("extension_resource_files")
    expect(fs.readFileSync(path.join(extDir, "resources", "opencode", "MEMORY.md"), "utf8")).toContain("opencode fact")
    expect(fs.readFileSync(path.join(extDir, "resources", "opencode", "memory_summary.md"), "utf8")).toStartWith("v1")
    expect(exportToCodexMemory(CODEX_MEM, "v1")).toBe(false)
  })

  it("refuses to export through a symlinked extension directory", () => {
    const { exportToCodexMemory } = interop()
    seedPluginMemory()
    fs.mkdirSync(path.join(CODEX_MEM, "extensions"), { recursive: true })
    const outside = path.join(TEST_ROOT, "outside-export")
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(CODEX_MEM, "extensions", "opencode_import"))

    expect(() => exportToCodexMemory(CODEX_MEM, "v1")).toThrow(/symlinks are not allowed/)
    expect(fs.readdirSync(outside)).toEqual([])
  })
})

describe("Codex memory version", () => {
  function writeConfig(body: string): void {
    fs.mkdirSync(CODEX_HOME, { recursive: true })
    fs.writeFileSync(path.join(CODEX_HOME, "config.toml"), body)
  }

  function warnsOf(run: () => void): string {
    const lines: string[] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "))
    }
    try {
      run()
    } finally {
      console.warn = orig
    }
    return lines.join("\n")
  }

  it("defaults to memories/ when config.toml is missing, even if memories_v2 exists", () => {
    const { resolveCodexInterop } = interop()
    const v2 = path.join(CODEX_HOME, "memories_v2")
    fs.mkdirSync(v2, { recursive: true })
    fs.writeFileSync(path.join(v2, "memory_summary.md"), "v1\n\nv2 fact\n")
    const resolved = resolveCodexInterop({ import: true, codex_home: CODEX_HOME })
    expect(resolved?.codexVersion).toBe("v1")
    expect(resolved?.codexMemoryRoot).toBe(CODEX_MEM)
  })

  it("selects memories_v2 from config and ignores a leftover memories/ handbook", () => {
    const { resolveCodexInterop, syncCodexImport } = interop()
    writeConfig('[memories]\nversion = "v2"\ndual_write = true\n')
    fs.mkdirSync(CODEX_MEM, { recursive: true })
    fs.writeFileSync(path.join(CODEX_MEM, "MEMORY.md"), "stale handbook\n")
    fs.writeFileSync(path.join(CODEX_MEM, "memory_summary.md"), "v1\n\nstale summary\n")
    const resolved = resolveCodexInterop({ import: true, codex_home: CODEX_HOME })
    expect(resolved?.codexVersion).toBe("v2")
    expect(resolved?.codexMemoryRoot).toBe(path.join(CODEX_HOME, "memories_v2"))
    expect(syncCodexImport(resolved!.codexMemoryRoot, resolved!.codexVersion)).toBe(false)
    expect(fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "codex_import"))).toBe(false)
    expect(fs.readFileSync(path.join(CODEX_MEM, "MEMORY.md"), "utf8")).toBe("stale handbook\n")
  })

  it("keeps an explicit v1 selection when memories_v2 also exists", () => {
    const { resolveCodexInterop } = interop()
    writeConfig('# version = "v2"\n[memories]\nversion = "v1"\n')
    fs.mkdirSync(path.join(CODEX_HOME, "memories_v2"), { recursive: true })
    fs.writeFileSync(path.join(CODEX_HOME, "memories_v2", "memory_summary.md"), "v1\n\nv2\n")
    const resolved = resolveCodexInterop({ import: true, codex_home: CODEX_HOME })
    expect(resolved?.codexVersion).toBe("v1")
    expect(resolved?.codexMemoryRoot).toBe(CODEX_MEM)
  })

  it("accepts dotted and inline memories.version", () => {
    const { resolveCodexInterop } = interop()
    writeConfig('memories.version = "v2"\n')
    expect(resolveCodexInterop({ import: true, codex_home: CODEX_HOME })?.codexVersion).toBe("v2")
    writeConfig('memories = { version = "v1" }\n')
    expect(resolveCodexInterop({ import: true, codex_home: CODEX_HOME })?.codexVersion).toBe("v1")
  })

  it("does not let a profile table override the user memories.version", () => {
    const { resolveCodexInterop } = interop()
    writeConfig('[memories]\nversion = "v1"\n\n[profiles.work.memories]\nversion = "v2"\n')
    expect(resolveCodexInterop({ import: true, codex_home: CODEX_HOME })?.codexVersion).toBe("v1")
  })

  it("fails closed on an unreadable, unparseable, or unknown version", () => {
    const { resolveCodexInterop, codexInteropBlockReason } = interop()
    const opts = { import: true, export: false, codex_home: CODEX_HOME }
    fs.mkdirSync(path.join(CODEX_HOME, "config.toml"), { recursive: true })
    let warned = ""
    expect(warnsOf(() => {
      expect(resolveCodexInterop(opts)).toBeNull()
    })).toContain("could not read")
    expect(codexInteropBlockReason(opts)).toContain("could not read")
    fs.rmSync(path.join(CODEX_HOME, "config.toml"), { recursive: true, force: true })

    writeConfig("version = = =\n")
    warned = warnsOf(() => {
      expect(resolveCodexInterop(opts)).toBeNull()
    })
    expect(warned).toContain("could not parse")

    writeConfig('[memories]\nversion = 2\n')
    warned = warnsOf(() => {
      expect(resolveCodexInterop(opts)).toBeNull()
    })
    expect(warned).toContain('not "v1" or "v2"')
    expect(codexInteropBlockReason(opts)).toContain('not "v1" or "v2"')
  })

  it("checks overlap against the selected root only", () => {
    const { resolveCodexInterop } = interop()
    const home = path.join(TEST_ROOT, "plugin")
    fs.writeFileSync(path.join(home, "config.toml"), '[memories]\nversion = "v2"\n')
    const resolved = resolveCodexInterop({ import: true, codex_home: home })
    expect(resolved?.codexMemoryRoot).toBe(path.join(home, "memories_v2"))

    const overlapHome = path.join(TEST_ROOT, "v2-overlap-home")
    fs.mkdirSync(overlapHome, { recursive: true })
    fs.mkdirSync(pluginMemoryRoot(), { recursive: true })
    fs.symlinkSync(pluginMemoryRoot(), path.join(overlapHome, "memories_v2"))
    fs.writeFileSync(path.join(overlapHome, "config.toml"), '[memories]\nversion = "v2"\n')
    expect(warnsOf(() => {
      expect(resolveCodexInterop({ import: true, codex_home: overlapHome })).toBeNull()
    })).toContain("overlaps")
  })
})

describe("syncCodexImport v2", () => {
  const V2_ROOT = path.join(CODEX_HOME, "memories_v2")
  const V2_SUMMARY = "v1\n\n## User Profile\nv2 fact\n\n## What's in Memory\nrollout_summaries/thread.md — detail; thread_id=abc\n"

  function seedV2(summary = V2_SUMMARY): void {
    fs.mkdirSync(V2_ROOT, { recursive: true })
    fs.writeFileSync(path.join(V2_ROOT, "memory_summary.md"), summary)
    fs.writeFileSync(path.join(V2_ROOT, "MEMORY.md"), "must not be copied\n")
  }

  it("copies only the summary and tells the consolidator it is the memory", () => {
    const { syncCodexImport } = interop()
    seedV2()
    expect(syncCodexImport(V2_ROOT, "v2")).toBe(true)
    const extDir = path.join(pluginMemoryRoot(), "extensions", "codex_import")
    const resDir = path.join(extDir, "resources", "codex")
    const instructions = fs.readFileSync(path.join(extDir, "instructions.md"), "utf8")
    expect(instructions).toContain("Codex Memory V2 has no `MEMORY.md`")
    expect(instructions).toContain("Do not invent those files")
    expect(instructions).toContain("[from codex]")
    expect(fs.readFileSync(path.join(resDir, "memory_summary.md"), "utf8")).toContain("v2 fact")
    expect(fs.existsSync(path.join(resDir, "MEMORY.md"))).toBe(false)
    expect(syncCodexImport(V2_ROOT, "v2")).toBe(false)
  })

  it("drops a previously imported handbook when the source switches to v2", () => {
    const { syncCodexImport } = interop()
    seedCodexMemory()
    syncCodexImport(CODEX_MEM, "v1")
    const resDir = path.join(pluginMemoryRoot(), "extensions", "codex_import", "resources", "codex")
    fs.writeFileSync(path.join(resDir, "note.md"), "keep")
    seedV2()
    expect(syncCodexImport(V2_ROOT, "v2")).toBe(true)
    expect(fs.existsSync(path.join(resDir, "MEMORY.md"))).toBe(false)
    expect(fs.readFileSync(path.join(resDir, "memory_summary.md"), "utf8")).toContain("v2 fact")
    expect(fs.readFileSync(path.join(resDir, "note.md"), "utf8")).toBe("keep")
    expect(fs.readFileSync(path.join(pluginMemoryRoot(), "extensions", "codex_import", "instructions.md"), "utf8")).toContain("no `MEMORY.md`")
  })

  it("forgets from the v2 root when its summary is gone, not from leftover v1 files", () => {
    const { syncCodexImport } = interop()
    seedV2()
    syncCodexImport(V2_ROOT, "v2")
    fs.unlinkSync(path.join(V2_ROOT, "memory_summary.md"))
    fs.mkdirSync(CODEX_MEM, { recursive: true })
    fs.writeFileSync(path.join(CODEX_MEM, "MEMORY.md"), "still here\n")
    expect(syncCodexImport(V2_ROOT, "v2")).toBe(true)
    const extDir = path.join(pluginMemoryRoot(), "extensions", "codex_import")
    expect(fs.existsSync(path.join(extDir, "resources", "codex"))).toBe(false)
    expect(fs.existsSync(path.join(extDir, "instructions.md"))).toBe(true)
    expect(fs.readFileSync(path.join(CODEX_MEM, "MEMORY.md"), "utf8")).toBe("still here\n")
  })

  it("does not treat a missing v2 root as deletion", () => {
    const { syncCodexImport } = interop()
    seedV2()
    syncCodexImport(V2_ROOT, "v2")
    fs.rmSync(V2_ROOT, { recursive: true, force: true })
    expect(syncCodexImport(V2_ROOT, "v2")).toBe(false)
    expect(fs.readFileSync(path.join(pluginMemoryRoot(), "extensions", "codex_import", "resources", "codex", "memory_summary.md"), "utf8")).toContain("v2 fact")
  })
})

describe("exportToCodexMemory v2", () => {
  const V2_ROOT = path.join(CODEX_HOME, "memories_v2")

  function seedPluginMemory(): void {
    const root = pluginMemoryRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, "MEMORY.md"), "# MEMORY.md\n\n- opencode fact\n")
    fs.writeFileSync(path.join(root, "memory_summary.md"), "v1\n\nopencode summary\n")
  }

  it("does not bootstrap a missing v2 workspace", () => {
    const { exportToCodexMemory } = interop()
    seedPluginMemory()
    expect(exportToCodexMemory(V2_ROOT, "v2")).toBe(false)
    expect(fs.existsSync(V2_ROOT)).toBe(false)
    expect(fs.existsSync(CODEX_MEM)).toBe(false)
  })

  it("writes v2 instructions into memories_v2 and still offers the handbook as source", () => {
    const { exportToCodexMemory } = interop()
    seedPluginMemory()
    fs.mkdirSync(V2_ROOT, { recursive: true })
    expect(exportToCodexMemory(V2_ROOT, "v2")).toBe(true)
    const extDir = path.join(V2_ROOT, "extensions", "opencode_import")
    const instructions = fs.readFileSync(path.join(extDir, "instructions.md"), "utf8")
    expect(instructions).toContain("Do not create, update, or restore a Codex `MEMORY.md`")
    expect(instructions).toContain("[from opencode]")
    expect(fs.readFileSync(path.join(extDir, "resources", "opencode", "MEMORY.md"), "utf8")).toContain("opencode fact")
    expect(fs.existsSync(path.join(CODEX_MEM, "extensions"))).toBe(false)
    expect(exportToCodexMemory(V2_ROOT, "v2")).toBe(false)
  })
})
