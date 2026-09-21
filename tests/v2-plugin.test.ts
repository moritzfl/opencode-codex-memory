import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { setup, waitForV2BackgroundTasks, resetV2ModuleStateForTest } from "../src/v2/plugin.js"
import { setV2Context, resetV2ShimStateForTest } from "../src/v2/shim.js"
import { setV2ServiceDependenciesForTest } from "../src/v2/service.js"
import { setPluginInput } from "../src/llm.js"
import { resetPluginOptions } from "../src/options.js"
import { resetAgentHealth } from "../src/agent-health.js"
import { MemoryStore } from "../src/store.js"
import { parseMemoryStatus } from "../src/v2/status-rpc.js"

const TEST_ROOT = path.join(os.tmpdir(), `ocm-v2plugin-${process.pid}`)

function fakeCtx(options: Record<string, unknown> = {}, events: any[] = []) {
  const added: any[] = []
  const toolTransforms: ((editor: any) => void)[] = []
  let toolReloads = 0
  const rebuildTools = () => {
    added.length = 0
    for (const transform of toolTransforms) transform({ add: (t: any) => added.push(t), update: () => {} })
  }
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
        toolTransforms.push(cb)
        rebuildTools()
      },
      reload: async () => { toolReloads++; rebuildTools() },
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
      subscribe: async function* () {
        for (const event of events) yield event
      },
    },
  }
  return { ctx, added, hooks, agentUpdates, rpcHandlers, toolReloads: () => toolReloads }
}

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
  // Module-singleton DB handle: drop any handle from another test file.
  require("../src/db.js").closeDb()
  fs.mkdirSync(path.join(TEST_ROOT, "memories"), { recursive: true })
  resetPluginOptions()
  resetV2ModuleStateForTest()
  setV2ServiceDependenciesForTest({
    service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
    make: () => ({
      health: { get: async () => ({ healthy: true, version: "2.0.3", pid: process.pid }) },
      session: {
        list: async () => ({ data: [], cursor: { next: null } }),
        get: async (input?: unknown) => ({
          id: (input as { sessionID?: string } | undefined)?.sessionID ?? "",
          parentID: null,
        }),
        remove: async () => {},
        interrupt: async () => {},
      },
      message: { list: async () => ({ data: [] }) },
    }),
  })
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
  setV2ServiceDependenciesForTest(null)
  resetV2ShimStateForTest()
  setV2Context(null)
  setPluginInput({ client: undefined } as any)
})

describe("v2 setup", () => {
  it("publishes the V2 SDK as an optional peer at the package boundary", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
      exports?: Record<string, { import?: string }>
    }
    expect(pkg.dependencies?.["@opencode/plugin"]).toBeUndefined()
    expect(pkg.peerDependencies?.["@opencode/plugin"]).toBe(">=2.0.3")
    expect(pkg.dependencies?.zod).toBeUndefined()
    expect(pkg.peerDependencies?.zod).toBe(">=4")
    expect(pkg.peerDependenciesMeta?.zod?.optional).toBe(true)
    expect(pkg.peerDependenciesMeta?.["@opencode/plugin"]?.optional).toBe(true)
    expect(pkg.exports?.["."]?.import).toBe("./dist/src/index.js")
    expect(pkg.exports?.["./server"]?.import).toBe("./dist/src/index.js")
    expect(pkg.exports?.["./v2"]?.import).toBe("./dist/src/v2/index.js")
    expect(pkg.exports?.["./tui"]?.import).toBe("./dist/src/tui.js")
  })

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
    // A running row this process is not executing is a foreign/orphaned
    // lease, not "consolidating" — it surfaces as a warning instead.
    const leased = parseMemoryStatus(await f.rpcHandlers.status())
    expect(leased.activity).toBe("error")
    expect(leased.warnings.some((w) => w.startsWith("Consolidation lease held by another process"))).toBe(true)
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

  it("serves the /memory controls: option toggles, session mode, and consolidate-now", async () => {
    const f = fakeCtx({ generate_memories: false })
    const cleanup = await setup(f.ctx)
    const handlers = f.rpcHandlers as Record<string, (input?: unknown) => Promise<any>>

    expect(parseMemoryStatus(await handlers.status()).useMemories).toBe(true)
    expect(await handlers.setOption({ key: "use_memories", value: false })).toEqual({ ok: true })
    expect(parseMemoryStatus(await handlers.status()).useMemories).toBe(false)
    // Read path honours the runtime toggle.
    const ev: any = { sessionID: "ses_ctl", system: [], messages: [] }
    for (const h of f.hooks["context"]) await h(ev)
    expect(ev.system).toEqual([])
    // Unknown keys and non-boolean values are refused.
    expect(await handlers.setOption({ key: "extract_model", value: true })).toEqual({ ok: false })
    expect(await handlers.setOption({ key: "use_memories", value: "yes" })).toEqual({ ok: false })

    expect(parseMemoryStatus(await handlers.status({ sessionID: "ses_ctl" })).sessionMode).toBeNull()
    expect(await handlers.setSessionMode({ sessionID: "ses_ctl", mode: "disabled" })).toEqual({ ok: true })
    expect(parseMemoryStatus(await handlers.status({ sessionID: "ses_ctl" })).sessionMode).toBe("disabled")
    expect(new MemoryStore().getMemoryMode("ses_ctl")).toBe("disabled")
    expect(await handlers.setSessionMode({ sessionID: "ses_ctl", mode: "polluted" })).toEqual({ ok: false })

    // consolidateNow returns immediately and runs detached; with generation off
    // it is a no-op rather than an error.
    expect(await handlers.consolidateNow()).toEqual({ status: "started" })
    await waitForV2BackgroundTasks()
    expect(new MemoryStore().phase2JobSnapshot()).toBeNull()
    await cleanup?.()
  })

  it("provisions V2 agents before enabling generation at runtime", async () => {
    const f = fakeCtx({ generate_memories: false })
    const cleanup = await setup(f.ctx)
    const handlers = f.rpcHandlers as Record<string, (input?: unknown) => Promise<any>>
    expect(f.agentUpdates).toEqual([])
    expect(await handlers.setOption({ key: "generate_memories", value: true })).toEqual({ ok: true })
    expect(f.agentUpdates).toEqual(["memorize", "memorize-extract"])
    expect(parseMemoryStatus(await handlers.status()).generateMemories).toBe(true)
    await cleanup?.()
  })

  it.each([true, false])("refreshes read tools on both toggle directions (dedicated tools: %s)", async (dedicated) => {
    const f = fakeCtx({ generate_memories: false, use_memories: false, dedicated_tools: dedicated })
    const cleanup = await setup(f.ctx)
    const handlers = f.rpcHandlers as Record<string, (input?: unknown) => Promise<any>>
    const names = () => f.added.map((tool) => tool.name)
    expect(names()).toEqual(["memory_reset", "memory_inspect", "memory_mode"])
    expect(await handlers.setOption({ key: "use_memories", value: true })).toEqual({ ok: true })
    expect(names().includes("memory_read")).toBe(dedicated)
    expect(names().includes("memory_add_note")).toBe(dedicated)
    expect(await handlers.setOption({ key: "use_memories", value: false })).toEqual({ ok: true })
    expect(names()).toEqual(["memory_reset", "memory_inspect", "memory_mode"])
    expect(await handlers.setOption({ key: "use_memories", value: false })).toEqual({ ok: true })
    expect(f.toolReloads()).toBe(2)
    await cleanup?.()
  })

  it("rolls back the read toggle if tool reload fails", async () => {
    const f = fakeCtx({ generate_memories: false, use_memories: false })
    const cleanup = await setup(f.ctx)
    f.ctx.tool.reload = async () => { throw new Error("reload failed") }
    const handlers = f.rpcHandlers as Record<string, (input?: unknown) => Promise<any>>
    expect(await handlers.setOption({ key: "use_memories", value: true })).toEqual({ ok: false })
    expect(parseMemoryStatus(await handlers.status()).useMemories).toBe(false)
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
    expect(Object.keys(f.hooks).sort()).toEqual(["compaction", "context", "execute.before", "generate", "prompt"])
    expect(f.hooks.title).toBeUndefined()
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
    expect(ev.system[0].text).toContain("```memory-citation")
    expect(ev.system[0].text).not.toContain("<citation_entries>")
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
          role: "assistant",
          content: [{ type: "text", text: "x <memory-citation><session_ids><id>ses_q</id></session_ids></memory-citation>" }],
        },
      ],
    }
    await f.hooks.context[0](ev)
    expect(ev.messages[0].content[0].text).toBe("x")
    expect(ev.messages[0].content[0].text).not.toContain("memory-citation")
  })

  it("compaction hook strips citations without injecting memory", async () => {
    fs.writeFileSync(path.join(TEST_ROOT, "memories", "memory_summary.md"), "- v2 memory [[ses_x]]\n")
    const f = fakeCtx()
    await setup(f.ctx)
    const ev: any = {
      sessionID: "ses_x",
      system: [],
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: [{ type: "text", text: "x <memory-citation><session_ids><id>ses_q</id></session_ids></memory-citation>" }],
        },
      ],
    }
    await f.hooks.compaction[0](ev)
    expect(ev.messages[0].content[0].text).toBe("x")
    expect(ev.system).toEqual([])
  })

  it("session.deleted drops extracted memory like V1", async () => {
    const store = new MemoryStore()
    store.upsertStage1Output({ session_id: "ses_gone_user", source_updated_at: 1, raw_memory: "m", rollout_summary: "s", rollout_slug: null, generated_at: 1 })
    const f = fakeCtx({}, [{ type: "session.deleted", data: { info: { id: "ses_gone_user" } } }])
    await setup(f.ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(new MemoryStore().stage1Outputs().some((row) => row.session_id === "ses_gone_user")).toBe(false)
  })

  it("accounts citations from durable text.ended events and reconciles later context", async () => {
    const store = new MemoryStore()
    store.upsertStage1Output({ session_id: "ses_cited", source_updated_at: 1, raw_memory: "m", rollout_summary: "s", rollout_slug: null, generated_at: 1 })
    const f = fakeCtx({}, [{
      type: "session.text.ended",
      data: {
        sessionID: "ses_main",
        assistantMessageID: "msg_durable",
        text: "answer\n```memory-citation\nsessions: ses_cited\n```",
      },
    }])
    await setup(f.ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(new MemoryStore().stage1Outputs().find((row) => row.session_id === "ses_cited")?.usage_count).toBe(1)

    const ev: any = {
      sessionID: "ses_main",
      system: [],
      messages: [{
        id: "msg_durable",
        role: "assistant",
        content: [{ type: "text", text: "answer\n```memory-citation\nsessions: ses_cited\n```" }],
      }],
    }
    await f.hooks.context[0](ev)
    expect(new MemoryStore().stage1Outputs().find((row) => row.session_id === "ses_cited")?.usage_count).toBe(1)
  })

  it.each(["context", "compaction", "generate"])("strips id-less %s context without double-counting durable citations", async (hook) => {
    const text = "answer\n```memory-citation\nsessions: ses_cited\n```"
    const store = new MemoryStore()
    store.upsertStage1Output({ session_id: "ses_cited", source_updated_at: 1, raw_memory: "m", rollout_summary: "s", rollout_slug: null, generated_at: 1 })
    const f = fakeCtx({}, [{ type: "session.text.ended", data: { sessionID: "ses_main", assistantMessageID: "msg_reply", text } }])
    const cleanup = await setup(f.ctx)
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 2; i++) {
      const ev: any = { sessionID: "ses_main", system: [], messages: [
        { role: "user", content: [{ type: "text", text }] },
        { role: "tool", content: [{ type: "text", text }] },
        { role: "assistant", content: [{ type: "text", text }] },
      ] }
      await f.hooks[hook][0](ev)
      expect(ev.messages.map((m: any) => m.content[0].text)).toEqual([text, text, "answer"])
    }
    expect(store.stage1Outputs()[0].usage_count).toBe(1)
    await cleanup?.()
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
        dialog: { alert: async () => {}, show: () => {}, set: () => {} },
        router: { current: () => ({ type: "session", sessionID: "ses_x" }) },
      },
      theme: {
        text: {
          default: "#fff",
          subdued: "#888",
          status: { running: "#0f0" },
          action: { primary: { default: "#08f" } },
          feedback: { error: { default: "#f00" }, warning: { default: "#ff0" }, success: { default: "#0f0" } },
        },
        background: { action: { primary: { $focused: "#224" } } },
      },
    }
    return { ctx, claims, layers }
  }

  const FULL_STATUS = {
    activity: "idle",
    version: "v1",
    sessionVersion: "v1",
    dualWrite: true,
    v2ConsolidatedThreads: 12,
    v2Ready: false,
    minConsolidatedThreads: 20,
    pipelines: [],
    useMemories: true,
    generateMemories: true,
    extractModel: "m",
    consolidationModel: "m",
    codexImport: false,
    lastSuccessAt: null,
    retryAt: null,
    warnings: ["Consolidation lease held by another process until 01:21."],
    sessionMode: "enabled",
    memoryRoot: "/tmp/mem",
    injected: { sessionTokens: 4200, sessionRequests: 1, totalTokens: 8400, totalRequests: 2 },
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

  it("mounts the app layer from a component scope and opens the /memory dialog", async () => {
    const { createRoot } = await import("solid-js")
    const { testRender } = await import("@opentui/solid")
    const tui = await import("../src/v2/tui.js")
    const shown: Array<() => unknown> = []
    const f = fakeTuiCtx(null)
    f.ctx.ui.dialog.show = (render: () => unknown) => { shown.push(render) }
    const cleanup = await (tui.default.setup as any)(f.ctx)
    const app = f.claims.find((c) => c.append === "app")
    createRoot((dispose: () => void) => {
      app.render({})
      dispose()
    })
    expect(f.layers).toHaveLength(1)
    const cmd = f.layers[0].commands[0]
    expect(cmd.slash).toEqual({ name: "memory", aliases: ["memory-status"] })
    await cmd.run()
    expect(shown).toHaveLength(1)
    // Unavailable status must still render (no orphan text nodes under <box>).
    // Tall enough for the full dialog: an overflowing 80x24 frame wraps rows
    // over each other and produces garbled assertions.
    const rendered: any = await testRender(() => shown[0]() as any, { width: 100, height: 40 })
    await rendered.renderOnce()
    const frame = rendered.captureCharFrame() as string
    expect(frame).toContain("Overview")
    expect(frame).toContain("Controls")
    expect(frame).toContain("unavailable")
    try {
      ;(rendered.renderer as any)?.dispose?.()
      ;(rendered.renderer as any)?.stop?.()
    } catch {
    }
    await (cleanup as any)?.()
  })

  it("renders the populated /memory overview and controls", async () => {
    const { testRender } = await import("@opentui/solid")
    const tui = await import("../src/v2/tui.js")
    const shown: Array<() => unknown> = []
    const f = fakeTuiCtx(FULL_STATUS)
    f.ctx.ui.dialog.show = (render: () => unknown) => { shown.push(render) }
    const cleanup = await (tui.default.setup as any)(f.ctx)
    const app = f.claims.find((c) => c.append === "app")
    const { createRoot } = await import("solid-js")
    createRoot((dispose: () => void) => {
      app.render({})
      dispose()
    })
    await f.layers[0].commands[0].run()
    const rendered: any = await testRender(() => shown[0]() as any, { width: 100, height: 40 })
    await rendered.renderOnce()
    const frame = rendered.captureCharFrame() as string
    expect(frame).toContain("STATUS")
    expect(frame).toContain("Read memories")
    expect(frame).toContain("This session")
    expect(frame).toContain("Learning")
    expect(frame).toContain("CONTEXT USAGE")
    expect(frame).toContain("4.2K")
    expect(frame).toContain("ATTENTION")
    expect(frame).toContain("lease held")
    expect(frame).toContain("/tmp/mem")
    // Tabs are not numbered and digits do nothing.
    expect(frame).not.toContain("1  Overview")
    // The dialog owns a tab layer plus a control layer gated to Controls.
    expect(f.layers).toHaveLength(3)
    const dialogLayer = f.layers[2]
    expect(typeof dialogLayer.enabled).toBe("function")
    expect(dialogLayer.enabled()).toBe(false)
    expect(dialogLayer.commands.map((c: any) => c.bind).sort()).toEqual(["down", "return", "space", "up"])
    try {
      ;(rendered.renderer as any)?.dispose?.()
      ;(rendered.renderer as any)?.stop?.()
    } catch {
    }
    await (cleanup as any)?.()
  })

  it("controls tab: arrow keys move the cursor and enter toggles via RPC", async () => {
    const { testRender } = await import("@opentui/solid")
    const tui = await import("../src/v2/tui.js")
    const calls: any[] = []
    const shown: Array<() => unknown> = []
    const f = fakeTuiCtx(FULL_STATUS)
    f.ctx.client.rpc = () => ({
      status: async () => structuredClone(FULL_STATUS),
      setOption: async (input: unknown) => { calls.push(["setOption", input]); return { ok: true } },
      setSessionMode: async (input: unknown) => { calls.push(["setSessionMode", input]); return { ok: true } },
      consolidateNow: async () => { calls.push(["consolidateNow"]); return { status: "started" } },
      events: { on: () => () => {} },
    })
    f.ctx.ui.dialog.show = (render: () => unknown) => { shown.push(render) }
    const cleanup = await (tui.default.setup as any)(f.ctx)
    const app = f.claims.find((c) => c.append === "app")
    const { createRoot } = await import("solid-js")
    createRoot((dispose: () => void) => {
      app.render({})
      dispose()
    })
    await f.layers[0].commands[0].run()
    const rendered: any = await testRender(() => shown[0]() as any, { width: 100, height: 40 })
    await rendered.renderOnce()
    const layer = f.layers[2]
    const cmd = (bind: string) => layer.commands.find((c: any) => c.bind === bind).run
    // Controls fire-and-forget their RPC; settle it before asserting.
    const press = async (bind: string) => { cmd(bind)(); await new Promise((r) => setTimeout(r, 5)) }
    // Cursor starts on "Use memories"; enter flips use_memories.
    await press("return")
    expect(calls[0]).toEqual(["setOption", { key: "use_memories", value: false }])
    // Down twice -> "Learn from this session"; enter sets the session mode.
    await press("down"); await press("down")
    await press("return")
    expect(calls[1]).toEqual(["setSessionMode", { sessionID: "ses_x", mode: "disabled" }])
    // Down -> "Consolidate now"; wraps back to the top afterwards.
    await press("down")
    await press("return")
    expect(calls[2]).toEqual(["consolidateNow"])
    await press("down")
    await press("return")
    expect(calls[3][0]).toBe("setOption")
    try {
      ;(rendered.renderer as any)?.dispose?.()
      ;(rendered.renderer as any)?.stop?.()
    } catch {
    }
    await (cleanup as any)?.()
  })

  it("renders the sidebar panel without orphan-text errors", async () => {
    const { testRender } = await import("@opentui/solid")
    const tui = await import("../src/v2/tui.js")
    const f = fakeTuiCtx(FULL_STATUS)
    const cleanup = await (tui.default.setup as any)(f.ctx)
    const panel = f.claims.find((c) => c.append === "sidebar.content")
    // Threw before the <Show> placeholder fix: a bare text node under <box>.
    const rendered: any = await testRender(() => panel.render({ sessionID: "ses_x" }) as any)
    await rendered.renderOnce()
    // The test renderer does not redraw on post-mount signal updates, so only
    // the initial (loading) frame is asserted; the dialog tests cover the
    // populated rows.
    const frame = rendered.captureCharFrame() as string
    expect(frame).toContain("Memory")
    expect(frame).toContain("Loading")
    expect(frame).toContain("/memory")
    // JSX trims leading whitespace of inline literals, so the hint line must
    // be a string expression to keep its indent aligned with the labels.
    expect(frame.split("\n").some((line) => line.startsWith("  /memory"))).toBe(true)
    try {
      ;(rendered.renderer as any)?.dispose?.()
      ;(rendered.renderer as any)?.stop?.()
    } catch {
    }
    await (cleanup as any)?.()
  })
})
