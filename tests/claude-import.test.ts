import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-claude-import-${process.pid}-${Date.now()}`)
const CLAUDE_HOME = path.join(TEST_ROOT, "claude-home")

beforeEach(() => {
  fs.mkdirSync(path.join(TEST_ROOT, "plugin"), { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = path.join(TEST_ROOT, "plugin")
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {}
})

function mod() {
  return require("../src/claude-import.js")
}
function pluginMemoryRoot(): string {
  return require("../src/paths.js").memoryRoot()
}

function writeProjectSession(projectRoot: string, projectCwd: string): void {
  fs.mkdirSync(projectCwd, { recursive: true })
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.writeFileSync(
    path.join(projectRoot, "session.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: projectCwd,
      timestamp: "2026-07-13T00:00:00Z",
      message: { content: "remember this" },
    }) + "\n",
  )
}

function seedProject(key: string, cwdName: string, files: Record<string, string>): string {
  const projectRoot = path.join(CLAUDE_HOME, "projects", key)
  const memoryDir = path.join(projectRoot, "memory")
  fs.mkdirSync(memoryDir, { recursive: true })
  writeProjectSession(projectRoot, path.join(TEST_ROOT, cwdName))
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(memoryDir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
  }
  return memoryDir
}

describe("discoverExternalMemoryFiles", () => {
  it("finds nested markdown under projects/*/memory and resolves cwd", () => {
    const { discoverExternalMemoryFiles } = mod()
    seedProject("project-a", "cwd-a", {
      "MEMORY.md": "project A memory",
      "topics/release.md": "release notes",
    })
    seedProject("project-b", "cwd-b", { "MEMORY.md": "project B memory" })

    const files = discoverExternalMemoryFiles(CLAUDE_HOME)
    expect(files.map((f: { projectKey: string; relativePath: string }) => `${f.projectKey}:${f.relativePath}`).sort()).toEqual([
      "project-a:MEMORY.md",
      "project-a:topics/release.md",
      "project-b:MEMORY.md",
    ])
    const a = files.find((f: { projectKey: string }) => f.projectKey === "project-a")
    expect(a.projectCwd).toBe(fs.realpathSync.native(path.join(TEST_ROOT, "cwd-a")))
  })

  it("skips symlinks and unsafe project keys", () => {
    const { discoverExternalMemoryFiles } = mod()
    seedProject("ok", "cwd-ok", { "MEMORY.md": "ok" })
    fs.mkdirSync(path.join(CLAUDE_HOME, "projects", ".hidden", "memory"), { recursive: true })
    fs.writeFileSync(path.join(CLAUDE_HOME, "projects", ".hidden", "memory", "x.md"), "nope")
    const mem = path.join(CLAUDE_HOME, "projects", "ok", "memory")
    fs.symlinkSync(path.join(TEST_ROOT, "outside.md"), path.join(mem, "link.md"))
    fs.writeFileSync(path.join(TEST_ROOT, "outside.md"), "outside")

    const files = discoverExternalMemoryFiles(CLAUDE_HOME)
    expect(files.map((f: { relativePath: string }) => f.relativePath)).toEqual(["MEMORY.md"])
  })
})

describe("syncClaudeImport", () => {
  it("is a no-op when disabled or claude home missing", () => {
    const { syncClaudeImport } = mod()
    expect(syncClaudeImport({ enabled: false }).changed).toBe(false)
    expect(syncClaudeImport({ enabled: true, claude_home: path.join(TEST_ROOT, "missing") }).changed).toBe(false)
    expect(fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "external_agent_import"))).toBe(false)
  })

  it("copies selected projects with scope.json and is idempotent", () => {
    const { syncClaudeImport } = mod()
    seedProject("project-a", "cwd-a", {
      "MEMORY.md": "project A memory",
      "release-process.md": "process",
    })
    seedProject("project-b", "cwd-b", { "MEMORY.md": "project B memory" })

    const first = syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME, projects: ["project-a"] })
    expect(first.changed).toBe(true)
    expect(first.synchronizedProjects).toEqual(["project-a"])
    expect(first.failures).toEqual([])

    const res = path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "project-a")
    expect(fs.readFileSync(path.join(res, "MEMORY.md"), "utf8")).toBe("project A memory")
    expect(fs.readFileSync(path.join(res, "release-process.md"), "utf8")).toBe("process")
    const scope = JSON.parse(fs.readFileSync(path.join(res, "scope.json"), "utf8"))
    expect(scope.cwd).toBe(fs.realpathSync.native(path.join(TEST_ROOT, "cwd-a")))
    expect(fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "project-b"))).toBe(
      false,
    )
    const instructions = fs.readFileSync(
      path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "instructions.md"),
      "utf8",
    )
    expect(instructions).toContain("scope.json")
    expect(instructions).toContain("extension_resource_files")

    expect(syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME, projects: ["project-a"] }).changed).toBe(false)
  })

  it("imports all projects with cwd when no allowlist is set", () => {
    const { syncClaudeImport } = mod()
    seedProject("project-a", "cwd-a", { "MEMORY.md": "A" })
    seedProject("project-b", "cwd-b", { "MEMORY.md": "B" })
    const r = syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME })
    expect(r.synchronizedProjects.sort()).toEqual(["project-a", "project-b"])
    expect(
      fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "project-b", "MEMORY.md")),
    ).toBe(true)
  })

  it("re-syncs changed content and drops removed source files", () => {
    const { syncClaudeImport } = mod()
    const mem = seedProject("project-a", "cwd-a", {
      "MEMORY.md": "v1",
      "topic.md": "topic",
    })
    syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME, projects: ["project-a"] })
    fs.unlinkSync(path.join(mem, "topic.md"))
    fs.writeFileSync(path.join(mem, "MEMORY.md"), "v2")
    fs.writeFileSync(path.join(mem, "new.md"), "new")

    const r = syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME, projects: ["project-a"] })
    expect(r.changed).toBe(true)
    const res = path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "project-a")
    expect(fs.readFileSync(path.join(res, "MEMORY.md"), "utf8")).toBe("v2")
    expect(fs.existsSync(path.join(res, "topic.md"))).toBe(false)
    expect(fs.readFileSync(path.join(res, "new.md"), "utf8")).toBe("new")
  })

  it("removes resources when the source project disappears", () => {
    const { syncClaudeImport } = mod()
    seedProject("project-a", "cwd-a", { "MEMORY.md": "A" })
    syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME })
    fs.rmSync(path.join(CLAUDE_HOME, "projects", "project-a"), { recursive: true, force: true })
    const r = syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME })
    expect(r.changed).toBe(true)
    expect(
      fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "project-a")),
    ).toBe(false)
  })

  it("skips projects without a resolvable cwd and does not create them", () => {
    const { syncClaudeImport } = mod()
    const projectRoot = path.join(CLAUDE_HOME, "projects", "orphan")
    fs.mkdirSync(path.join(projectRoot, "memory"), { recursive: true })
    fs.writeFileSync(path.join(projectRoot, "memory", "MEMORY.md"), "no session")
    const r = syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME })
    expect(r.skippedNoCwd).toEqual(["orphan"])
    expect(r.synchronizedProjects).toEqual([])
    expect(
      fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "orphan")),
    ).toBe(false)
  })

  it("prunes owned projects outside a tightened allowlist", () => {
    const { syncClaudeImport } = mod()
    seedProject("project-a", "cwd-a", { "MEMORY.md": "A" })
    seedProject("project-b", "cwd-b", { "MEMORY.md": "B" })
    syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME })
    const r = syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME, projects: ["project-a"] })
    expect(r.changed).toBe(true)
    expect(
      fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "project-b")),
    ).toBe(false)
    expect(
      fs.existsSync(path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "project-a", "MEMORY.md")),
    ).toBe(true)
  })

  it("survives extension pruning (nested untimestamped resources)", () => {
    const { syncClaudeImport } = mod()
    const { ensureLayout, pruneExtensionResources } = require("../src/workspace.js")
    ensureLayout()
    seedProject("project-a", "cwd-a", { "MEMORY.md": "A" })
    syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME })
    pruneExtensionResources(0)
    expect(
      fs.readFileSync(
        path.join(pluginMemoryRoot(), "extensions", "external_agent_import", "resources", "project-a", "MEMORY.md"),
        "utf8",
      ),
    ).toBe("A")
  })

  it("first-run ordering surfaces copies as additions in the workspace diff", async () => {
    const { syncClaudeImport } = mod()
    const { ensureLayout } = require("../src/workspace.js")
    const { ensureBaseline, captureWorkspaceDiff } = require("../src/git-baseline.js")
    seedProject("project-a", "cwd-a", { "MEMORY.md": "A" })
    ensureLayout()
    expect(await ensureBaseline()).toBe(true)
    expect(syncClaudeImport({ enabled: true, claude_home: CLAUDE_HOME }).changed).toBe(true)
    const diff = await captureWorkspaceDiff()
    const added = diff.changes
      .filter((c: { status: string }) => c.status === "A")
      .map((c: { path: string }) => c.path)
    expect(added).toContain("extensions/external_agent_import/instructions.md")
    expect(added).toContain("extensions/external_agent_import/resources/project-a/MEMORY.md")
    expect(added).toContain("extensions/external_agent_import/resources/project-a/scope.json")
  })
})
