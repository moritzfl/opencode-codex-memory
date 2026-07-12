import { describe, it, expect } from "bun:test"
import fs from "fs"
import path from "path"

const OPENCODE_JSON = path.join(import.meta.dirname, "..", "opencode.json")
const SHIPPED_AGENTS = JSON.parse(fs.readFileSync(OPENCODE_JSON, "utf8")).agent as Record<string, any>
const ALLOWED_BUILTIN_TOOLS = new Set(["read", "edit", "write", "glob", "grep"])

describe("agent auto-registration", () => {
  it("injects both sub-agents from the bundled opencode.json when absent", () => {
    const { injectAgentDefinitions } = require("../src/index.js")
    const config: { agent?: Record<string, any> } = {}
    injectAgentDefinitions(config)
    expect(Object.keys(config.agent ?? {}).sort()).toEqual(["memorize", "memorize-extract"])
    expect(config.agent!["memorize"].mode).toBe("subagent")
    expect(config.agent!["memorize-extract"].mode).toBe("subagent")
    expect(config.agent!["memorize"].permission.edit).toBe("allow")
    expect(config.agent!["memorize"].permission.write).toBe("allow")
    expect(config.agent!["memorize-extract"].permission.edit).toBe("deny")
    expect(config.agent!["memorize-extract"].permission.write).toBe("deny")
  })

  it("allowlists built-in tools for every shipped agent", () => {
    for (const [name, definition] of Object.entries(SHIPPED_AGENTS)) {
      const permission = definition.permission as Record<string, string>
      expect(Object.keys(permission)[0], `${name}: wildcard deny must be first`).toBe("*")
      expect(permission["*"], `${name}: unknown and MCP tools must be denied`).toBe("deny")
      for (const [tool, action] of Object.entries(permission)) {
        if (action === "allow") {
          expect(ALLOWED_BUILTIN_TOOLS.has(tool), `${name}: unexpected allowed tool ${tool}`).toBe(true)
        }
      }
    }
  })

  it("grants memorize external_directory access to the memory root (memories live outside every project)", () => {
    const { injectAgentDefinitions } = require("../src/index.js")
    const { memoryRoot } = require("../src/paths.js")
    const config: { agent?: Record<string, any> } = {}
    injectAgentDefinitions(config)
    const permission = config.agent!["memorize"].permission as Record<string, unknown>
    // Without this grant the wildcard deny matches opencode's
    // external_directory ask and consolidation cannot touch memory files.
    expect(permission.external_directory).toEqual({ [path.join(memoryRoot(), "*")]: "allow" })
    // Last-match-wins in opencode: the grant must come after the wildcard deny.
    const keys = Object.keys(permission)
    expect(keys[0]).toBe("*")
    expect(keys.indexOf("external_directory")).toBeGreaterThan(0)
    // The extractor works on an inline transcript and needs no filesystem grant.
    expect(config.agent!["memorize-extract"].permission.external_directory).toBeUndefined()
  })

  it("leaves user-defined agents of the same name untouched", () => {
    const { injectAgentDefinitions } = require("../src/index.js")
    const userDef = { mode: "subagent", model: "my/model", prompt: "custom" }
    const config: { agent?: Record<string, any> } = { agent: { memorize: userDef } }
    injectAgentDefinitions(config)
    expect(config.agent!["memorize"]).toBe(userDef)
    // The missing one is still filled in.
    expect(config.agent!["memorize-extract"]).toBeDefined()
  })

  it("bundled definitions stay in sync with the shipped opencode.json", () => {
    expect(Object.keys(SHIPPED_AGENTS).sort()).toEqual(["memorize", "memorize-extract"])
  })
})
