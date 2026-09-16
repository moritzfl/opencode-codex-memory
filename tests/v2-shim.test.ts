import { describe, it, expect, beforeEach } from "bun:test"
import {
  setV2Context,
  buildV1ClientShim,
  resetV2ShimStateForTest,
  adaptV2Messages,
  adaptProviderCatalog,
  adaptMcpStatus,
} from "../src/v2/shim.js"
import { discoverOwnService, setV2ServiceDependenciesForTest } from "../src/v2/service.js"
import { catalogVariantKeys } from "../src/reasoning-variant.js"

const ASSISTANT_TOOL_MSG = {
  id: "msg_tool1",
  time: { created: 1788872021828, streamed: 1788872023623, completed: 1788872023624 },
  type: "assistant",
  agent: "build",
  model: { id: "gpt-6-astra", providerID: "github-copilot" },
  content: [
    {
      type: "tool",
      id: "call_1",
      name: "execute",
      executed: false,
      state: {
        status: "completed",
        input: { code: 'return await tools.memory_read({path: "MEMORY.md"});' },
        content: [{ type: "text", text: "# memories" }],
        metadata: { toolCalls: [{ tool: "memory_read", status: "completed", input: { path: "MEMORY.md" } }] },
      },
    },
    { type: "text", text: "done <memory-citation><session_ids><id>ses_abc</id></session_ids></memory-citation>" },
    { type: "reasoning", text: "should be dropped" },
  ],
  finish: "tool-calls",
}

let serviceRows: unknown[] = []
let servicePageResponses: unknown[] = []
let serviceListInputs: unknown[] = []

function fakeCtx() {
  const calls: { name: string; args: unknown }[] = []
  const ctx: any = {
    location: { directory: "/tmp/v2test" },
    options: {},
    session: {
      create: async (a: unknown) => {
        calls.push({ name: "create", args: a })
        return { data: { id: "ses_created1" } }
      },
      prompt: async (a: unknown) => {
        calls.push({ name: "prompt", args: a })
        return { id: "msg_1" }
      },
      wait: async (a: unknown) => {
        calls.push({ name: "wait", args: a })
      },
      context: async (a: unknown) => {
        calls.push({ name: "context", args: a })
        return [{ id: "m1", time: { created: 1 }, text: "hi", type: "user" }]
      },
      get: async (a: any) => {
        calls.push({ name: "get", args: a })
        if (a.sessionID === "ses_gone") throw { _tag: "SessionNotFoundError" }
        return { id: a.sessionID, parentID: null }
      },
      switchAgent: async (a: unknown) => {
        calls.push({ name: "switchAgent", args: a })
      },
      switchModel: async (a: unknown) => {
        calls.push({ name: "switchModel", args: a })
      },
      interrupt: async (a: unknown) => {
        calls.push({ name: "interrupt", args: a })
        return { interrupted: true }
      },
    },
    generate: {
      text: async (a: unknown) => {
        calls.push({ name: "generate", args: a })
        return { text: '{"raw_memory":"m","rollout_summary":"s","rollout_slug":"t"}' }
      },
    },
    catalog: {
      model: {
        list: async () => ({
          data: [{ providerID: "acme", modelID: "m1", variants: [{ id: "low" }, { id: "high" }] }],
        }),
      },
    },
    mcp: {
      list: async () => ({ data: [{ name: "srv", status: { status: "connected" } }] }),
    },
  }
  return { ctx, calls }
}

beforeEach(() => {
  resetV2ShimStateForTest()
  setV2Context(null)
  servicePageResponses = []
  serviceListInputs = []
  const serviceClient: any = {
    health: { get: async () => ({ healthy: true, version: "2.0.3", pid: process.pid }) },
    session: {
      list: async (input: unknown) => {
        serviceListInputs.push(input)
        return servicePageResponses.shift() ?? { data: serviceRows, cursor: { next: null } }
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "ses_gone") throw { _tag: "SessionNotFoundError" }
        return { id: sessionID, parentID: null }
      },
      remove: async () => {},
      interrupt: async () => {},
    },
    message: { list: async () => ({ data: [{ id: "m1", time: { created: 1 }, text: "hi", type: "user" }] }) },
    config: { get: async () => [{ type: "document", info: { model: "acme/m1" } }] },
  }
  setV2ServiceDependenciesForTest({
    service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
    make: () => serviceClient,
  })
})

describe("adaptV2Messages", () => {
  it("maps user/assistant rows to V1 capture shape", () => {
    const rows = adaptV2Messages([
      { id: "u1", time: { created: 1 }, text: "hello", type: "user" },
      ASSISTANT_TOOL_MSG,
      { id: "s1", time: { created: 2 }, text: "sys", type: "system" },
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] })
    expect(rows[2].info?.role).toBe("system")
    const parts = rows[1].parts as any[]
    // execute wrapper expands to per-tool rows; text kept; reasoning dropped.
    expect(parts[0]).toEqual({
      type: "tool",
      tool: "memory_read",
      state: { input: { path: "MEMORY.md" }, output: "# memories" },
    })
    expect(parts[1]).toEqual({
      type: "text",
      text: "done <memory-citation><session_ids><id>ses_abc</id></session_ids></memory-citation>",
    })
    expect(parts.some((p) => p.type === "reasoning" && (p as any).text !== undefined)).toBe(false)
  })

  it("returns [] for non-arrays", () => {
    expect(adaptV2Messages(null)).toEqual([])
  })
})

describe("catalog/mcp adapters", () => {
  it("adapts provider catalog for variant mapping", () => {
    const v1 = adaptProviderCatalog({ data: [{ providerID: "acme", modelID: "m1", variants: [{ id: "low" }, { id: "high" }] }] })
    expect(catalogVariantKeys(v1, "acme", "m1")?.sort()).toEqual(["high", "low"])
    expect(catalogVariantKeys(v1, "nope", "m1")).toBeUndefined()
  })

  it("adapts mcp list to status map", () => {
    expect(adaptMcpStatus({ data: [{ name: "srv", status: { status: "connected" } }] })).toEqual({
      srv: { status: "connected" },
    })
  })
})

describe("V1 client shim", () => {
  it("accepts only the registered service owned by this host process", async () => {
    const calls: string[] = []
    const endpoint = { url: "http://127.0.0.1:4096", auth: { type: "basic" as const, username: "opencode", password: "secret" } }
    const client = { health: { get: async () => ({ healthy: true, version: "2.0.3", pid: process.pid }) } }
    const found = await discoverOwnService({
      service: {
        discover: async () => { calls.push("discover"); return endpoint },
        headers: () => { calls.push("headers"); return { authorization: "Basic test" } },
      },
      make: (options) => { calls.push(`make:${options.baseUrl}`); return client as any },
    })
    expect(found?.client).toBe(client)
    expect(found?.endpoint).toBe(endpoint)
    expect(calls).toEqual(["discover", "headers", "make:http://127.0.0.1:4096"])
  })

  it("rejects a registered endpoint whose health PID is not this process", async () => {
    const client = { health: { get: async () => ({ healthy: true, version: "2.0.3", pid: process.pid + 1 }) } }
    await expect(
      discoverOwnService({
        service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
        make: () => client as any,
      }),
    ).rejects.toThrow(/PID/i)
  })

  it("rejects a registered endpoint that is not healthy", async () => {
    const client = { health: { get: async () => ({ healthy: false, version: "2.0.3", pid: process.pid }) } }
    await expect(
      discoverOwnService({
        service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
        make: () => client as any,
      }),
    ).rejects.toThrow(/healthy/i)
  })

  it("serves global paginated discovery from the registered service", async () => {
    serviceRows = [
      { id: "ses_b", title: "b", directory: "/p", time: { created: 1, updated: 3 }, parentID: null },
      { id: "ses_a", title: "codex-memory-x", directory: "/p", time: { created: 1, updated: 2 }, parentID: null },
    ]
    const client = buildV1ClientShim() as any
    const res = await client._client.get({ url: "/experimental/session", query: { roots: true, limit: 10, directory: "" } })
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data).toHaveLength(2)
    expect(res.data[0].time.updated).toBeGreaterThanOrEqual(res.data[1].time.updated)
    expect(res.data[0].id).toBe("ses_b")
  })

  it("follows the public session cursor until the requested global page is complete", async () => {
    servicePageResponses = [
      { data: [{ id: "ses_1", time: { created: 1, updated: 3 }, parentID: null }], cursor: { next: "cursor-1" } },
      { data: [{ id: "ses_2", time: { created: 1, updated: 2 }, parentID: null }], cursor: { next: null } },
    ]
    const client = buildV1ClientShim() as any
    const res = await client._client.get({ url: "/experimental/session", query: { limit: 2, directory: "" } })
    expect(res.data.map((row: any) => row.id)).toEqual(["ses_1", "ses_2"])
    expect(serviceListInputs).toEqual([
      { limit: 2, order: "desc", parentID: null },
      { limit: 2, order: "desc", parentID: null, cursor: "cursor-1" },
    ])
  })

  it("routes structured extraction through generate.text", async () => {
    const { ctx, calls } = fakeCtx()
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const res = await client.session.prompt({
      path: { id: "ses_x" },
      body: {
        agent: "memorize-extract",
        system: "SYS",
        model: { providerID: "acme", modelID: "m1" },
        variant: "low",
        format: { type: "json_schema" },
        parts: [{ type: "text", text: "TRANSCRIPT" }],
      },
    })
    expect(calls.map((c) => c.name)).toEqual(["generate"])
    const gen = calls[0].args as any
    expect(gen.prompt).toContain("SYS")
    expect(gen.prompt).toContain("TRANSCRIPT")
    expect(gen.model).toEqual({ providerID: "acme", id: "m1", variant: "low" })
    expect(JSON.stringify(res.data)).toContain("raw_memory")
  })

  it("adapts public config documents for the V1 model resolver", async () => {
    setV2Context(fakeCtx().ctx as any)
    const client = buildV1ClientShim() as any
    await expect(client.config.get()).resolves.toEqual({ data: { model: "acme/m1" } })
  })

  it("forwards cancellation to structured extraction", async () => {
    const seen: { input: unknown; options: unknown }[] = []
    const { ctx } = fakeCtx()
    ctx.generate.text = async (input: unknown, options: unknown) => {
      seen.push({ input, options })
      return { text: "{}" }
    }
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const controller = new AbortController()
    await client.session.prompt({
      path: { id: "ses_extract" },
      signal: controller.signal,
      body: {
        agent: "memorize-extract",
        format: { type: "json_schema" },
        parts: [{ type: "text", text: "TRANSCRIPT" }],
      },
    })
    expect(seen[0]?.options).toEqual({ signal: controller.signal })
  })

  it("waits for helper cleanup after cancellation is acknowledged", async () => {
    let resolveWait!: () => void
    let cleanupDone = false
    const { ctx } = fakeCtx()
    ctx.session.wait = async () => new Promise<void>((resolve) => { resolveWait = resolve })
    ctx.session.interrupt = async () => {
      setTimeout(() => {
        cleanupDone = true
        resolveWait()
      }, 0)
    }
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const controller = new AbortController()
    const resultP = client.session.prompt({
      path: { id: "ses_cancel" },
      signal: controller.signal,
      body: { agent: "memorize", parts: [{ type: "text", text: "DO" }] },
    })
    await Promise.resolve()
    controller.abort()
    const result = await resultP
    expect(result.error?.message).toMatch(/cancelled/i)
    expect(cleanupDone).toBe(true)
  })

  it("routes agentic prompts through switch + prompt + wait", async () => {
    const { ctx, calls } = fakeCtx()
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    await client.session.prompt({
      path: { id: "ses_y" },
      body: { agent: "memorize", model: { providerID: "acme", modelID: "m1" }, parts: [{ type: "text", text: "DO" }] },
    })
    expect(calls.map((c) => c.name)).toEqual(["switchAgent", "switchModel", "prompt", "wait"])
    expect((calls[2].args as any).text).toBe("DO")
  })

  it("maps NotFound gets to 404 and released ids stay 404", async () => {
    const { ctx } = fakeCtx()
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const gone = await client.session.get({ path: { id: "ses_gone" } })
    expect(gone.response?.status).toBe(404)
    const live = await client.session.get({ path: { id: "ses_live" } })
    expect(live.data?.id).toBe("ses_live")
    await client.session.delete({ path: { id: "ses_live" } })
    const after = await client.session.get({ path: { id: "ses_live" } })
    expect(after.response?.status).toBe(404)
  })

  it("adapts context() into messages rows", async () => {
    const client = buildV1ClientShim() as any
    const res = await client.session.messages({ path: { id: "ses_live" } })
    expect(res.data).toEqual([{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }])
  })
})
