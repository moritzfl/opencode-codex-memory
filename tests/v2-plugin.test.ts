import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { setup, waitForV2BackgroundTasks, resetV2ModuleStateForTest } from "../src/v2/plugin.js"
import { setV2Context, clearSessionRegistryForTest } from "../src/v2/shim.js"
import { setPluginInput } from "../src/llm.js"
import { resetPluginOptions } from "../src/options.js"
import { resetAgentHealth } from "../src/agent-health.js"
import { MemoryStore } from "../src/store.js"
import { parseMemoryStatus } from "../src/v2/status-rpc.js"

const TEST_ROOT = path.join(os.tmpdir(), `ocm-v2plugin-${process.pid}`)

function fakeCtx(options: Record<string, unknown> = {}) {
  const added: any[] = []
  const hooks: Record<string, ((ev: any) => unknown)[]> = {}
  const agentUpdates: string[] = []
  const rpcHandlers: Record<string, () => Promise<unknown>> = {}
  const ctx: any = {
    location: { directory: TEST_ROOT },
    options,
    rpc: {
      register: async (_definition: unknown, handlers: typeof rpcHandlers) => {
        Object.assign(rpcHandlers, handlers)
        return { events: { emit: async () => {} } }
      },
    },
    agent: {
      get: async () => {
        throw new Error("Agent not found")
      },
      transform: async (cb: (e: any) => void) => {
        cb({ update: (id: string, fn: (a: any) => void) => {
          agentUpdates.push(id)
          fn({ id })
        } })
      },
    },
    tool: {
      transform: async (cb: (e: any) => void) => {
        cb({ add: (t: any) => added.push(t) })
      },
      hook: async (name: string, cb: (e: any) => unknown) => {
        ;(hooks[name] ??= []).push(cb)
      },
    },
    session: {
      hook: async (name: string, cb: (e: any) => unknown) => {
        ;(hooks[name] ??= []).push(cb)
      },
      create: async () => ({ data: { id: "ses_helper" } }),
      get: async () => ({ id: "ses_helper", parentID: null }),
      context: async () => [],
      prompt: async () => ({ id: "msg_1" }),
      wait: async () => {},
      interrupt: async () => ({ interrupted: true }),
      switchAgent: async () => {},
      switchModel: async () => {},
    },
    generate: { text: async () => ({ text: "{}" }) },
    catalog: { model: { list: async () => ({ data: [] }) } },
    mcp: { list: async () => ({ data: [] }) },
    event: {
      subscribe: async function* () {},
    },
  }
  return { ctx, added, hooks, agentUpdates, rpcHandlers }
}

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
  // Module-singleton DB handle: drop any handle from another test file.
  require("../src/db.js").closeDb()
  fs.mkdirSync(path.join(TEST_ROOT, "memories"), { recursive: true })
  resetPluginOptions()
  resetV2ModuleStateForTest()
})

afterEach(() => {
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
  resetPluginOptions()
  resetAgentHealth()
  resetV2ModuleStateForTest()
  clearSessionRegistryForTest()
  setV2Context(null)
  setPluginInput({ client: undefined } as any)
})

describe("v2 setup", () => {
  it("serves read-only status with effective options without starting memory jobs", async () => {
    const f = fakeCtx({
      generate_memories: false,
      extract_model: "foundry-local/gpt-5.6-luna",
      consolidation_model: "foundry-local/gpt-5.6-luna",
      codex_interop: { import: true },
    })
    const cleanup = await setup(f.ctx)
    const snapshot = parseMemoryStatus(await f.rpcHandlers.status())
    expect(snapshot).toMatchObject({
      activity: "read_only",
      extractModel: "foundry-local/gpt-5.6-luna",
      consolidationModel: "foundry-local/gpt-5.6-luna",
      codexImport: true,
      lastSuccessAt: null,
      warnings: [],
    })
    expect(new MemoryStore().phase2JobSnapshot()).toBeNull()
    expect(new MemoryStore().stage1JobSnapshot().by_status).toEqual({})
    await cleanup?.()
  })

  it("reports durable consolidation state and never labels a failure timestamp as success", async () => {
    const f = fakeCtx()
    const cleanup = await setup(f.ctx)
    const store = new MemoryStore()
    const first = store.claimGlobalPhase2Job()
    if (first.type !== "claimed") throw new Error("expected claim")
    expect(parseMemoryStatus(await f.rpcHandlers.status()).activity).toBe("consolidating")
    store.markPhase2Succeeded(first.ownershipToken, [])
    const success = parseMemoryStatus(await f.rpcHandlers.status())
    expect(success.activity).toBe("idle")
    expect(success.lastSuccessAt).toBeGreaterThan(0)
    require("../src/db.js").openDb().prepare("UPDATE memory_jobs SET finished_at=1 WHERE kind='memory_consolidate_global'").run()
    const next = store.claimGlobalPhase2Job()
    if (next.type !== "claimed") throw new Error("expected retry claim")
    store.markPhase2Failed(next.ownershipToken, "test failure")
    const failed = parseMemoryStatus(await f.rpcHandlers.status())
    expect(failed.activity).toBe("retrying")
    expect(failed.retryAt).toBeGreaterThan(Date.now())
    expect(failed.lastSuccessAt).toBeNull()
    expect(failed.warnings.length).toBeGreaterThan(0)
    await cleanup?.()
  })

  it("reports extraction claims and distinguishes disabled memory from read-only", async () => {
    const f = fakeCtx({ generate_memories: false, use_memories: false })
    const cleanup = await setup(f.ctx)
    expect(parseMemoryStatus(await f.rpcHandlers.status()).activity).toBe("disabled")
    // A job already claimed by another worker remains visible even if this
    // location disables future generation.
    const store = new MemoryStore()
    store.claimStage1Jobs([{ id: "ses_extracting", updated_at: Date.now() }])
    expect(parseMemoryStatus(await f.rpcHandlers.status()).activity).toBe("extracting")
    await cleanup?.()
  })

  it("registers tools, hooks and the memorize agent; applies options", async () => {    const f = fakeCtx({ generate_memories: false })
    const cleanup = await setup(f.ctx)
    expect(f.added.map((t) => t.name).sort()).toEqual(
      ["memory_add_note", "memory_inspect", "memory_list", "memory_mode", "memory_read", "memory_reset", "memory_search"].sort(),
    )
    expect(Object.keys(f.hooks).sort()).toEqual(["context", "execute.before", "prompt"])
    expect(f.agentUpdates).toEqual([])
    await (cleanup as () => unknown)?.()
    await waitForV2BackgroundTasks()
  })

  it("prompt hook stamps the session mode without running the pipeline when generation is off", async () => {
    const f = fakeCtx({ generate_memories: false })
    await setup(f.ctx)
    await f.hooks.prompt[0]({ sessionID: "ses_new1", prompt: { text: "hi" } })
    await waitForV2BackgroundTasks()
    expect(new MemoryStore().getMemoryMode("ses_new1")).toBe("disabled")
  })

  it("context hook injects the summary as a text system part", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "memories", "memory_summary.md"), "- v2 memory [[ses_x]]\n")
    const f = fakeCtx()
    await setup(f.ctx)
    const ev: any = { sessionID: "ses_x", system: [], messages: [] }
    await f.hooks.context[0](ev)
    expect(ev.system).toHaveLength(1)
    expect(ev.system[0].type).toBe("text")
    expect(ev.system[0].text).toContain("v2 memory")
  })

  it("context hook strips citations from assistant parts", async () => {
    const f = fakeCtx()
    await setup(f.ctx)
    const ev: any = {
      sessionID: "ses_x",
      system: [],
      messages: [
        {
          id: "m1",
          type: "assistant",
          content: [{ type: "text", text: "x <memory-citation><session_ids><id>ses_q</id></session_ids></memory-citation>" }],
        },
      ],
    }
    await f.hooks.context[0](ev)
    expect(ev.messages[0].content[0].text).toBe("x")
    expect(ev.messages[0].content[0].text).not.toContain("memory-citation")
  })

  it("tool hook marks websearch sessions polluted when the guard is on", async () => {
    const f = fakeCtx()
    await setup(f.ctx)
    const { applyPluginOptions } = require("../src/index.js")
    applyPluginOptions({ disable_on_external_context: true })
    await f.hooks["execute.before"][0]({ tool: "websearch", sessionID: "ses_pol" })
    expect(new MemoryStore().isPolluted("ses_pol")).toBe(true)
  })
})

describe("v2 tui status panel", () => {
  function fakeTuiCtx(status: unknown) {
    const claims: any[] = []
    const layers: any[] = []
    const ctx: any = {
      location: { directory: TEST_ROOT },
      data: { location: { default: () => ({ directory: TEST_ROOT }) } },
      client: {
        rpc: () => ({
          status: async () => structuredClone(status),
          events: { on: () => () => {} },
        }),
      },
      keymap: { layer: (fn: () => unknown) => { layers.push(fn()); return () => {} } },
      ui: {
        slot: (claim: unknown) => { claims.push(claim); return () => {} },
        dialog: { alert: async () => {} },
      },
      theme: {
        text: {
          default: "#fff",
          subdued: "#888",
          status: { running: "#0f0" },
          feedback: { error: { default: "#f00" }, warning: { default: "#ff0" } },
        },
      },
    }
    return { ctx, claims, layers }
  }

  it("registers sidebar + app slots in setup without touching Solid-scoped APIs", async () => {
    const tui = await import("../src/v2/tui.js")
    const f = fakeTuiCtx(null)
    // Must not throw: keymap.layer outside a component scope fails on the host.
    const cleanup = await (tui.default.setup as any)(f.ctx)
    expect(claimsTargets(f)).toEqual(["app", "sidebar.content"])
    expect(f.layers).toEqual([])
    await (cleanup as any)?.()
  })

  function claimsTargets(f: { claims: any[] }): string[] {
    return f.claims.map((c) => c.append).sort()
  }

  it("mounts the app layer from a component scope and serves the status command", async () => {
    const { createRoot } = await import("solid-js")
    const tui = await import("../src/v2/tui.js")
    const seen: any[] = []
    const f = fakeTuiCtx(null)
    f.ctx.ui.dialog.alert = async (opts: unknown) => { seen.push(opts) }
    const cleanup = await (tui.default.setup as any)(f.ctx)
    const app = f.claims.find((c) => c.append === "app")
    createRoot((dispose: () => void) => {
      app.render({})
      dispose()
    })
    expect(f.layers).toHaveLength(1)
    const run = f.layers[0].commands[0].run
    expect(f.layers[0].commands[0].slash).toEqual({ name: "memory-status" })
    await run()
    expect((seen[0] as any).title).toBe("Memory status")
    expect((seen[0] as any).message).toContain("Memory status is unavailable")
    await (cleanup as any)?.()
  })

  it("renders the sidebar panel without orphan-text errors", async () => {
    const { testRender } = await import("@opentui/solid")
    const tui = await import("../src/v2/tui.js")
    const f = fakeTuiCtx({
      activity: "idle",
      useMemories: true,
      generateMemories: true,
      extractModel: "m",
      consolidationModel: "m",
      codexImport: false,
      lastSuccessAt: null,
      retryAt: null,
      warnings: [],
    })
    const cleanup = await (tui.default.setup as any)(f.ctx)
    const panel = f.claims.find((c) => c.append === "sidebar.content")
    // Threw before the <Show> placeholder fix: a bare text node under <box>.
    const rendered: any = await testRender(() => panel.render({ sessionID: "ses_x" }) as any)
    await rendered.flush()
    const frame = rendered.captureCharFrame() as string
    expect(frame).toContain("Memory")
    expect(frame).toContain("/memory-status")
    // JSX trims leading whitespace of inline literals, so the hint line must
    // be a string expression to keep its indent aligned with the labels.
    expect(frame.split("\n").some((line) => line.startsWith("  /memory-status"))).toBe(true)
    try {
      ;(rendered.renderer as any)?.dispose?.()
      ;(rendered.renderer as any)?.stop?.()
    } catch {
    }
    await (cleanup as any)?.()
  })
})
