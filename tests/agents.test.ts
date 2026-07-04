import { describe, it, expect } from "bun:test"
import fs from "fs"
import path from "path"

const OPENCODE_JSON = path.join(import.meta.dirname, "..", "opencode.json")

describe("agent auto-registration", () => {
  it("injects both sub-agents from the bundled opencode.json when absent", () => {
    const { injectAgentDefinitions } = require("../src/index.js")
    const config: { agent?: Record<string, any> } = {}
    injectAgentDefinitions(config)
    expect(Object.keys(config.agent ?? {}).sort()).toEqual(["memorize", "memorize-extract"])
    expect(config.agent!["memorize"].mode).toBe("subagent")
    expect(config.agent!["memorize-extract"].mode).toBe("subagent")
    // The sandbox must survive injection: network/task tools stay denied.
    for (const name of ["memorize", "memorize-extract"]) {
      const perm = config.agent![name].permission
      for (const denied of ["bash", "webfetch", "websearch", "task"]) {
        expect(perm[denied]).toBe("deny")
      }
    }
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
    const shipped = JSON.parse(fs.readFileSync(OPENCODE_JSON, "utf8"))
    expect(Object.keys(shipped.agent ?? {}).sort()).toEqual(["memorize", "memorize-extract"])
  })
})
