import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { memoryRoot } from "../src/paths.js"
import { consolidationPermissions } from "../src/v2/agents.js"
import { guardMemorySearchTools } from "../src/v2/search-sandbox.js"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-search-sandbox-"))
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = root
  for (const version of ["v1", "v2"] as const) fs.mkdirSync(memoryRoot(version))
})
afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(root, { recursive: true, force: true })
})

function sandbox() {
  const calls: any[] = []
  const tools: Record<string, any> = Object.fromEntries(["glob", "grep"].map((name) => [name, {
    execute: async (input: unknown) => { calls.push(input); return { content: "found" } },
  }]))
  guardMemorySearchTools({ update: (id, update) => update(tools[id]) }, async (sessionID) => ({
    permissions: sessionID === "unknown" ? [] : consolidationPermissions(memoryRoot(sessionID === "v2" ? "v2" : "v1")),
  }))
  return { tools, calls }
}

describe("V2 memory search sandbox", () => {
  it("routes each writer's searches to its root, including omitted and relative paths", async () => {
    const { tools, calls } = sandbox()
    for (const sessionID of ["v1", "v2"] as const) {
      await tools.glob.execute({ pattern: "**/*.md" }, { agent: "memorize", sessionID })
      await tools.grep.execute({ pattern: "deployment", path: "rollout_summaries" }, { agent: "memorize", sessionID })
      expect(calls.slice(-2).map((call) => call.path)).toEqual([memoryRoot(sessionID), path.join(memoryRoot(sessionID), "rollout_summaries")])
    }
  })

  it("blocks traversal, project paths, other memory versions and symlink paths before execution", async () => {
    const { tools, calls } = sandbox()
    fs.symlinkSync(root, path.join(memoryRoot(), "escape"))
    for (const name of ["glob", "grep"]) {
      for (const requested of [root, memoryRoot("v2"), "../memories_v2", "escape", "escape/private.md"]) {
        await expect(tools[name].execute({ pattern: "*", path: requested }, { agent: "memorize", sessionID: "v1" })).rejects.toThrow()
      }
    }
    for (const pattern of ["../*", "/etc/*", "{../*,**/*.md}"]) {
      await expect(tools.glob.execute({ pattern }, { agent: "memorize", sessionID: "v1" })).rejects.toThrow()
    }
    expect(calls).toEqual([])
  })

  it("fails closed without a scoped helper and preserves ordinary-agent searches", async () => {
    const { tools, calls } = sandbox()
    const input = { pattern: "foo", path: root }
    await expect(tools.grep.execute(input, { agent: "memorize", sessionID: "unknown" })).rejects.toThrow(/session-scoped/)
    await tools.grep.execute(input, { agent: "build", sessionID: "unknown" })
    expect(calls).toEqual([input])
  })
})
