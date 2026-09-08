import { describe, it, expect, beforeEach } from "bun:test"
import {
  setV2Context,
  buildV1ClientShim,
  recordSessionSighting,
  clearSessionRegistryForTest,
  adaptV2Messages,
  adaptProviderCatalog,
  adaptMcpStatus,
} from "../src/v2/shim.js"
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
  clearSessionRegistryForTest()
  setV2Context(null)
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
  it("serves discovery from the registry in listGlobal shape", async () => {
    const { ctx } = fakeCtx()
    setV2Context(ctx as any)
    recordSessionSighting("ses_b", { title: "b", directory: "/p" })
    recordSessionSighting("ses_a", { title: "codex-memory-x", directory: "/p" })
    const client = buildV1ClientShim() as any
    const res = await client._client.get({ url: "/experimental/session", query: { roots: true, limit: 10, directory: "" } })
    expect(Array.isArray(res.data)).toBe(true)
    expect(res.data).toHaveLength(2)
    // capture.ts filters titles/parents itself; rows carry what it needs.
    expect(res.data[0].time.updated).toBeGreaterThanOrEqual(res.data[1].time.updated)
    await new Promise((r) => setTimeout(r, 10))
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
    const { ctx } = fakeCtx()
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const res = await client.session.messages({ path: { id: "ses_live" } })
    expect(res.data).toEqual([{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }])
  })
})
