import { describe, it, expect, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import { buildMemorizeAgent, buildMemorizeExtractAgent, ensureV2Agents, toV1AgentDefinition, MEMORIZE_SYSTEM, MEMORIZE_EXTRACT_SYSTEM } from "../src/v2/agents.js"
import { getAgentHealth, resetAgentHealth } from "../src/agent-health.js"
import { resetPluginOptions } from "../src/options.js"
import { applyPluginOptions } from "../src/index.js"

const OPENCODE_JSON = path.join(import.meta.dirname, "..", "opencode.json")
const SHIPPED_V2 = (JSON.parse(fs.readFileSync(OPENCODE_JSON, "utf8")).agents ?? {}) as Record<string, any>
const ALLOWED_V2_ACTIONS = new Set(["read", "edit", "glob", "grep", "external_directory"])

function fakeAgentCtx(existing: Record<string, any> = {}) {
  const updates: { id: string; applied: Record<string, unknown> }[] = []
  const removed: string[] = []
  return {
    updates,
    removed,
    ctx: {
      agent: {
        get: async (input: { agentID: string }) => {
          if (existing[input.agentID]) return { data: existing[input.agentID] }
          throw new Error("Agent not found: " + input.agentID)
        },
        transform: async (cb: (editor: any) => void) => {
          const editor = {
            get: (id: string) => existing[id],
            update: (id: string, fn: (a: Record<string, unknown>) => void) => {
              const cur: Record<string, unknown> = { ...(existing[id] ?? { id, name: id }) }
              fn(cur)
              updates.push({ id, applied: cur })
            },
            remove: (id: string) => {
              removed.push(id)
            },
          }
          cb(editor)
        },
      },
    },
  }
}

afterEach(() => {
  resetAgentHealth()
  resetPluginOptions()
})

describe("v2 agent definitions (opencode.json agents)", () => {
  it("ships both agents in V2 form (extract is hidden: extraction uses generate.text)", () => {
    expect(Object.keys(SHIPPED_V2).sort()).toEqual(["memorize", "memorize-extract"])
    expect(SHIPPED_V2["memorize-extract"].hidden).toBe(true)
    expect(SHIPPED_V2["memorize-extract"].system).toBe(MEMORIZE_EXTRACT_SYSTEM)
  })

  it("memorize uses a deny-first allowlist with V2 action names", () => {
    const def = SHIPPED_V2.memorize
    expect(def.mode).toBe("subagent")
    expect(typeof def.system).toBe("string")
    expect(def.system).toBe(MEMORIZE_SYSTEM)
    const rules = def.permissions as { action: string; resource: string; effect: string }[]
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    for (const rule of rules) {
      if (rule.effect === "allow") {
        expect(ALLOWED_V2_ACTIONS.has(rule.action), `unexpected allowed action ${rule.action}`).toBe(true)
      }
    }
    const allows = new Set(rules.filter((r) => r.effect === "allow").map((r) => r.action))
    for (const tool of ["read", "edit", "glob", "grep"]) {
      expect(allows.has(tool), `missing allow for ${tool}`).toBe(true)
    }
    // V2 folds write/patch into edit; shell/subagent/network tools stay denied.
    expect(allows.has("write")).toBe(false)
    expect(allows.has("shell")).toBe(false)
    expect(allows.has("subagent")).toBe(false)
  })

  it("built memorize agent adds the memory-root external_directory grant", () => {
    const { memoryRoot } = require("../src/paths.js")
    const def = buildMemorizeAgent()
    expect(def.system).toBe(SHIPPED_V2.memorize.system)
    const grant = def.permissions.find((r) => r.action === "external_directory")
    expect(grant).toEqual({ action: "external_directory", resource: path.join(memoryRoot(), "*"), effect: "allow" })
  })

  it("built extract agent is hidden and deny-all", () => {
    const def = buildMemorizeExtractAgent()
    expect(def.hidden).toBe(true)
    expect(def.mode).toBe("subagent")
    expect(def.system).toBe(SHIPPED_V2["memorize-extract"].system)
    expect(def.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }])
  })
})

describe("ensureV2Agents", () => {
  it("creates both agents when absent and records shipped health", async () => {
    const f = fakeAgentCtx()
    await ensureV2Agents(f.ctx as any)
    expect(f.updates.map((u) => u.id)).toEqual(["memorize", "memorize-extract"])
    const applied = f.updates[0].applied as any
    expect(applied.mode).toBe("subagent")
    expect(applied.system).toBe(MEMORIZE_SYSTEM)
    expect(f.updates[1].applied).toMatchObject({ mode: "subagent", hidden: true })
    expect(getAgentHealth().agents.memorize).toMatchObject({ source: "shipped", healthy: true, issues: [] })
    expect(getAgentHealth().agents["memorize-extract"]).toMatchObject({ source: "shipped", healthy: true, issues: [] })
  })

  it("leaves a user-defined memorize untouched and records override health", async () => {
    const userDef = { id: "memorize", mode: "subagent", system: "custom", permissions: [{ action: "*", resource: "*", effect: "allow" }] }
    const f = fakeAgentCtx({ memorize: userDef })
    await ensureV2Agents(f.ctx as any)
    // Only the absent extract agent is created; the override is preserved.
    expect(f.updates.map((u) => u.id)).toEqual(["memorize-extract"])
    const health = getAgentHealth()
    expect(health.agents.memorize.source).toBe("user_override")
    expect(health.agents.memorize.healthy).toBe(false)
  })

  it("skips provisioning when generation is off", async () => {
    applyPluginOptions({ generate_memories: false })
    const f = fakeAgentCtx()
    await ensureV2Agents(f.ctx as any)
    expect(f.updates).toEqual([])
    expect(getAgentHealth().generationEnabled).toBe(false)
  })

  it("V1-health conversion maps edit to edit+write", () => {
    const v1 = toV1AgentDefinition(buildMemorizeAgent()) as any
    expect(v1.mode).toBe("subagent")
    expect(v1.permission["*"]).toBe("deny")
    expect(v1.permission.edit).toBe("allow")
    expect(v1.permission.write).toBe("allow")
    expect(v1.permission.read).toBe("allow")
    expect(v1.permission.glob).toBe("allow")
    expect(v1.permission.grep).toBe("allow")
  })
})
