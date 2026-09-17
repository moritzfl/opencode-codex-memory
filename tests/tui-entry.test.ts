import { describe, expect, it } from "bun:test"
import fs from "fs"
import path from "path"
import tui from "../src/tui.js"

const ROOT = path.join(import.meta.dir, "..")

/** Mirror of OpenCode 1.18.30 `readV1Plugin` (shared.ts) for kind=tui, strict. */
function readV1TuiPlugin(mod: Record<string, unknown>, spec: string) {
  const value = mod.default
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Plugin ${spec} must default export an object with tui()`)
  }
  const record = value as Record<string, unknown>
  const server = "server" in record ? record.server : undefined
  const tuiFn = "tui" in record ? record.tui : undefined
  if (server !== undefined && typeof server !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid server export`)
  }
  if (tuiFn !== undefined && typeof tuiFn !== "function") {
    throw new TypeError(`Plugin ${spec} has invalid tui export`)
  }
  if (server !== undefined && tuiFn !== undefined) {
    throw new TypeError(`Plugin ${spec} must default export either server() or tui(), not both`)
  }
  if (tuiFn === undefined) {
    throw new TypeError(`Plugin ${spec} must default export an object with tui()`)
  }
  return record
}

describe("dual-host ./tui entry", () => {
  it("does not statically import the V2 TUI SDK", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "tui.ts"), "utf8")
    expect(src).not.toMatch(/from ["']@opencode\/plugin/)
    expect(src).not.toMatch(/import\(["']@opencode\/plugin/)
    expect(src).toContain('import("./v2/tui.js")')
  })

  it("satisfies OpenCode 1.18.30 TUI readV1Plugin without loading V2", async () => {
    const plugin = readV1TuiPlugin({ default: tui }, "opencode-codex-memory")
    expect(plugin.id).toBe("opencode-codex-memory.tui")
    expect(typeof plugin.tui).toBe("function")
    expect(typeof plugin.setup).toBe("function")
    await expect((plugin.tui as () => Promise<void>)()).resolves.toBeUndefined()
  })
})
