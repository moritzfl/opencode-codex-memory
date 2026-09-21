import { describe, it, expect, beforeEach } from "bun:test"
import {
  setV2Context,
  buildV1ClientShim,
  resetV2ShimStateForTest,
  rememberV2Session,
  adaptV2Messages,
  adaptProviderCatalog,
  adaptMcpStatus,
  EXTRACT_STUB_SESSION_ID,
} from "../src/v2/shim.js"
import {
  discoverOwnService,
  fetchServiceStatus,
  lastServiceFailure,
  ownServiceClient,
  parseReadyStatus,
  readRegisteredEndpoint,
  serviceHeaders,
  setV2ServiceDependenciesForTest,
  serviceRequest,
} from "../src/v2/service.js"
import fs from "fs"
import os from "os"
import path from "path"
import { catalogVariantKeys } from "../src/reasoning-variant.js"
import { withMemoryVersion } from "../src/memory-version.js"
import { memoryRoot } from "../src/paths.js"
import { extractViaSubagent, setPluginInput } from "../src/llm.js"

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
let messagePageResponses: unknown[] = []
let messageListInputs: unknown[] = []
let serviceRemove: () => Promise<unknown> = async () => {}
let serviceConfigResponse: unknown = [{ type: "document", info: { model: "acme/m1" } }]

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
  messagePageResponses = []
  messageListInputs = []
  serviceRemove = async () => {}
  serviceConfigResponse = [{ type: "document", info: { model: "acme/m1" } }]
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
      remove: async () => serviceRemove(),
      interrupt: async () => {},
    },
    message: {
      list: async (input: unknown) => {
        messageListInputs.push(input)
        return messagePageResponses.shift() ?? { data: [{ id: "m1", time: { created: 1 }, text: "hi", type: "user" }] }
      },
    },
    config: { get: async () => serviceConfigResponse },
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
  it("uses selectable model ids and distinguishes unknown from empty variants", () => {
    const catalog = adaptProviderCatalog([
      { providerID: "acme", id: "alias", modelID: "wire-name", variants: [{ id: "medium" }] },
      { providerID: "acme", id: "plain", variants: [] },
      { providerID: "acme", id: "unknown" },
    ])
    expect(catalogVariantKeys(catalog, "acme", "alias")).toEqual(["medium"])
    expect(catalogVariantKeys(catalog, "acme", "wire-name")).toBeUndefined()
    expect(catalogVariantKeys(catalog, "acme", "plain")).toEqual([])
    expect(catalogVariantKeys(catalog, "acme", "unknown")).toBeUndefined()
  })

  it.each([false, true])("selects nearest extraction effort using current model API (legacy also present: %s)", async (legacy) => {
    const { ctx, calls } = fakeCtx()
    if (!legacy) delete ctx.catalog
    ctx.model = { list: async () => [
      { providerID: "acme", id: "alias", modelID: "wire-name", variants: [{ id: "medium" }, { id: "high" }] },
    ] }
    setV2Context(ctx)
    setPluginInput({ client: buildV1ClientShim() } as any)
    try {
      await withMemoryVersion("v1", () => extractViaSubagent("ses_source", "transcript", {
        model: "acme/alias", signal: new AbortController().signal,
      }))
      expect((calls.find((c) => c.name === "generate")?.args as any).model).toEqual({ providerID: "acme", id: "alias", variant: "medium" })
    } finally {
      setPluginInput({ client: undefined } as any)
    }
  })

  it("retains the legacy model catalog on older hosts", async () => {
    setV2Context(fakeCtx().ctx)
    const response = await (buildV1ClientShim() as any).provider.list()
    expect(catalogVariantKeys(response.data, "acme", "m1")).toEqual(["low", "high"])
  })

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
  it("restricts concurrent consolidators to their own versioned workspace", async () => {
    const { ctx, calls } = fakeCtx()
    setV2Context(ctx)
    const client = buildV1ClientShim() as any
    await Promise.all((["v1", "v2"] as const).map((version) => withMemoryVersion(version, () =>
      client.session.create({ body: { title: "codex-memory-consolidate", metadata: { version } } }),
    )))
    const rules = calls.filter((call) => call.name === "create").map((call) => call.args as any)
    expect(rules).toHaveLength(2)
    for (const version of ["v1", "v2"] as const) {
      const permissions = rules.find((row) => row.metadata.version === version).permissions
      expect(permissions[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
      expect(permissions.filter((rule: any) => rule.action === "read").map((rule: any) => rule.resource)).toEqual([
        memoryRoot(version), path.join(memoryRoot(version), "*"),
      ])
      expect(permissions.find((rule: any) => rule.action === "grep")).toMatchObject({ resource: "*", effect: "allow" })
    }
  })

  it("accepts only the registered service owned by this host process", async () => {
    const calls: string[] = []
    const endpoint = { url: "http://127.0.0.1:4096", auth: { type: "basic" as const, username: "opencode", password: "secret" } }
    const client = {
      session: {},
      health: { get: async () => ({ healthy: true, version: "2.0.3", pid: process.pid }) },
    }
    const found = await discoverOwnService({
      service: {
        discover: async () => { calls.push("discover"); return endpoint },
        headers: () => { calls.push("headers"); return { authorization: "Basic test" } },
      },
      make: (options) => { calls.push(`make:${options.baseUrl}`); return client },
    })
    expect(found?.client).toBe(client)
    expect(found?.endpoint).toBe(endpoint)
    expect(calls).toEqual(["discover", "headers", "make:http://127.0.0.1:4096"])
  })

  it("rejects a non-loopback registered endpoint whose health PID is not this process", async () => {
    const client = {
      session: {},
      health: { get: async () => ({ healthy: true, version: "2.0.3", pid: process.pid + 1 }) },
    }
    await expect(
      discoverOwnService({
        service: { discover: async () => ({ url: "http://192.0.2.1:4096" }), headers: () => undefined },
        make: () => client,
      }),
    ).rejects.toThrow(/PID/i)
  })

  it("accepts a loopback registered endpoint even when the health PID is not this process", async () => {
    const client = {
      session: {},
      health: { get: async () => ({ healthy: true, version: "2.0.5", pid: process.pid + 1 }) },
    }
    const found = await discoverOwnService({
      service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
      make: () => client,
    })
    expect(found?.client).toBe(client)
    expect(found?.health.pid).toBe(process.pid + 1)
  })

  it("rejects a registered endpoint that is not healthy", async () => {
    const client = {
      session: {},
      health: { get: async () => ({ healthy: false, version: "2.0.3", pid: process.pid }) },
    }
    await expect(
      discoverOwnService({
        service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
        make: () => client,
      }),
    ).rejects.toThrow(/healthy/i)
  })

  it("accepts GET /api/status with version+pid and no healthy field", async () => {
    const found = await discoverOwnService({
      service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
      make: () => ({ session: {} }) as any,
      probe: async () => ({ version: "2.0.5", pid: process.pid }),
    })
    expect(found?.health).toEqual({ version: "2.0.5", pid: process.pid })
  })

  it("does not treat a non-object health body as ready", () => {
    expect(parseReadyStatus("<!doctype html>")).toBeNull()
    expect(parseReadyStatus(undefined)).toBeNull()
    expect(parseReadyStatus({ pid: process.pid })).toBeNull()
    expect(parseReadyStatus({ version: "2.0.5", pid: process.pid, healthy: false })).toBeNull()
    expect(parseReadyStatus({ version: "2.0.5", pid: process.pid })).toEqual({
      version: "2.0.5",
      pid: process.pid,
    })
  })

  it("reads the XDG service.json registration without calling Service.discover", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-svc-"))
    const file = path.join(dir, "service.json")
    fs.writeFileSync(file, JSON.stringify({ url: "http://127.0.0.1:49374", pid: 1, password: "secret" }))
    expect(await readRegisteredEndpoint(file)).toEqual({
      url: "http://127.0.0.1:49374",
      auth: { type: "basic", username: "opencode", password: "secret" },
    })
    fs.writeFileSync(file, "not-json")
    expect(await readRegisteredEndpoint(file)).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("builds Basic auth headers via the bundled client", () => {
    expect(serviceHeaders({
      url: "http://127.0.0.1:4096",
      auth: { type: "basic", username: "opencode", password: "secret" },
    })).toEqual({
      authorization: `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    })
  })

  it("surfaces GET /api/status HTTP failures instead of a generic unhealthy", async () => {
    const orig = globalThis.fetch
    globalThis.fetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof fetch
    try {
      await expect(fetchServiceStatus({ url: "http://127.0.0.1:9" }, undefined)).rejects.toThrow(/401/)
    } finally {
      globalThis.fetch = orig
    }
  })

  it("records the real discovery error when a non-loopback registered PID is not this process", async () => {
    setV2ServiceDependenciesForTest({
      service: { discover: async () => ({ url: "http://192.0.2.1:4096" }), headers: () => undefined },
      make: () => ({
        health: { get: async () => ({ healthy: true, version: "2.0.5", pid: process.pid + 1 }) },
        session: {},
      }) as any,
    })
    expect(await ownServiceClient()).toBeNull()
    expect(lastServiceFailure()).toMatch(/PID/i)
  })

  it("uses ctx.session.list when the plugin context exposes it", async () => {
    const { ctx } = fakeCtx()
    const listed: unknown[] = []
    ;(ctx.session as any).list = async (input: unknown) => {
      listed.push(input)
      return { data: [{ id: "ses_ctx", title: "from-ctx", directory: "/p", time: { updated: 9 }, parentID: null }] }
    }
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const res = await client._client.get({ url: "/experimental/session", query: { limit: 10, directory: "" } })
    expect(res.data.map((row: { id: string }) => row.id)).toEqual(["ses_ctx"])
    expect(listed[0]).toEqual({ limit: 10, order: "desc", parentID: null })
    expect(serviceListInputs).toEqual([])
  })

  it("times out health discovery and aborts the request", async () => {
    let aborted = false
    const never = new Promise<unknown>(() => {})
    await expect(
      discoverOwnService(
        {
          service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
          make: () => ({
            health: {
              get: async (options?: { signal?: AbortSignal }) => {
                options?.signal?.addEventListener("abort", () => { aborted = true }, { once: true })
                return never
              },
            },
          }) as any,
        },
        10,
      ),
    ).rejects.toThrow(/timed out/i)
    expect(aborted).toBe(true)
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

  it.each([
    Object.assign(new Error("Transport"), { reason: "Transport", cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) }),
    { error: { type: "UnauthorizedError", message: "unauthorized", status: 401 } },
  ])("rediscovers the service after a connection or auth failure", async (failure) => {
    let port = 4096
    let discoveries = 0
    setV2ServiceDependenciesForTest({
      service: { discover: async () => { discoveries++; return { url: `http://127.0.0.1:${port}` } }, headers: () => undefined },
      probe: async () => ({ version: "2.0.12", pid: process.pid }),
      make: ({ baseUrl }) => ({ session: { list: async () => {
        if (!baseUrl.endsWith(String(port))) throw failure
        return { data: [{ id: "ses_live" }] }
      } } }),
    })
    const client = buildV1ClientShim() as any
    const list = () => client._client.get({ url: "/experimental/session" })
    expect((await list()).data).toHaveLength(1)
    port = 4097
    await expect(list()).rejects.toEqual(failure)
    expect((await list()).data).toHaveLength(1)
    expect(discoveries).toBe(2)
  })

  it("does not invalidate on a missing session or deliberate cancellation", async () => {
    const client = (await ownServiceClient())!
    for (const error of [
      { _tag: "SessionNotFoundError", status: 404 },
      Object.assign(new Error("Transport"), { reason: "Transport", cause: new DOMException("cancelled", "AbortError") }),
    ]) {
      await expect(serviceRequest(client, async () => { throw error })).rejects.toEqual(error)
      expect(await ownServiceClient()).toBe(client)
    }
  })

  it("does not replay mutations or let stale failures invalidate a replacement client", async () => {
    setV2ServiceDependenciesForTest({
      service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
      probe: async () => ({ version: "2.0.12", pid: process.pid }),
      make: () => ({ session: {} }),
    })
    const first = (await ownServiceClient())!
    let mutations = 0
    const fail = () => serviceRequest(first, async () => {
      mutations++
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
    })
    await expect(fail()).rejects.toThrow("connection reset")
    expect(mutations).toBe(1)
    const next = (await ownServiceClient())!
    expect(next).not.toBe(first)
    await expect(fail()).rejects.toThrow()
    expect(await ownServiceClient()).toBe(next)
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

  it("preserves cleanup search/cursor semantics and maps V2 locations", async () => {
    serviceRows = [
      { id: "ses_old", title: "codex-memory-consolidate", location: { directory: "/memory/project" }, time: { updated: 1 }, parentID: null },
      { id: "ses_new", title: "ordinary", location: { directory: "/other" }, time: { updated: 3 }, parentID: null },
    ]
    const client = buildV1ClientShim() as any
    const res = await client._client.get({
      url: "/experimental/session",
      query: { roots: true, limit: 10, cursor: 2, search: "codex-memory-", directory: "" },
    })
    expect(res.data).toEqual([
      expect.objectContaining({ id: "ses_old", directory: "/memory/project" }),
    ])
    expect(serviceListInputs[0]).toEqual({ limit: 10, order: "desc", parentID: null, search: "codex-memory-" })
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

  it("never sends a variant-only Model.Ref when the host default model is used", async () => {
    const { ctx, calls } = fakeCtx()
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    await client.session.prompt({ path: { id: "ses_extract" }, body: {
      agent: "memorize-extract", variant: "low", format: { type: "json_schema" },
      parts: [{ type: "text", text: "TRANSCRIPT" }],
    } })
    expect((calls[0].args as any).model).toBeUndefined()
  })

  it("adapts public config documents for the V1 model resolver", async () => {
    setV2Context(fakeCtx().ctx as any)
    const client = buildV1ClientShim() as any
    await expect(client.config.get()).resolves.toEqual({ data: { model: "acme/m1" } })
  })

  it("merges config documents from low to high precedence", async () => {
    serviceConfigResponse = [
      { type: "document", info: { model: "low/model", temperature: 0.2 } },
      { type: "document", info: { model: { providerID: "high", model: "model" } } },
    ]
    setV2Context(fakeCtx().ctx as any)
    const client = buildV1ClientShim() as any
    await expect(client.config.get()).resolves.toEqual({ data: { model: "high/model", temperature: 0.2 } })
  })

  it("loads every message page and omits order on cursor requests", async () => {
    messagePageResponses = [
      { data: [{ id: "m1", time: { created: 1 }, text: "one", type: "user" }], cursor: { next: "m-cursor" } },
      { data: [{ id: "m2", time: { created: 2 }, text: "two", type: "user" }], cursor: { next: null } },
    ]
    const client = buildV1ClientShim() as any
    const res = await client.session.messages({ path: { id: "ses_long" } })
    expect(res.data.map((row: any) => row.parts[0].text)).toEqual(["one", "two"])
    expect(messageListInputs).toEqual([
      { sessionID: "ses_long", order: "asc" },
      { sessionID: "ses_long", cursor: "m-cursor" },
    ])
  })

  it("rejects an unavailable or malformed transcript instead of returning empty", async () => {
    messagePageResponses = [{ data: { not: "an array" } }]
    const client = buildV1ClientShim() as any
    const malformed = await client.session.messages({ path: { id: "ses_bad" } })
    expect(malformed.error?.message).toMatch(/invalid message list/i)
  })

  it("cancels structured extraction via public generate.text request options when available", async () => {
    const seen: unknown[][] = []
    let started!: () => void
    const startedP = new Promise<void>((resolve) => { started = resolve })
    const { ctx } = fakeCtx()
    setV2Context(ctx as any)
    setV2ServiceDependenciesForTest({
      service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
      make: () => ({
        health: { get: async () => ({ healthy: true, version: "2.0.5", pid: process.pid }) },
        session: { list: async () => ({ data: [] }), get: async () => ({ id: "x" }), remove: async () => {}, interrupt: async () => {} },
        generate: {
          text: async (...args: unknown[]) => {
            seen.push(args)
            const opts = args[1] as { signal?: AbortSignal } | undefined
            await new Promise((_, reject) => {
              opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
              started()
            })
          },
        },
      }) as any,
    })
    const client = buildV1ClientShim() as any
    const controller = new AbortController()
    const resultP = client.session.prompt({
      path: { id: "ses_extract" },
      signal: controller.signal,
      body: {
        agent: "memorize-extract",
        format: { type: "json_schema" },
        parts: [{ type: "text", text: "TRANSCRIPT" }],
      },
    })
    await startedP
    controller.abort()
    const result = await resultP
    expect(result.error?.message).toMatch(/abort|cancelled/i)
    expect(seen[0]?.length).toBe(2)
    expect((seen[0]?.[1] as { signal?: AbortSignal })?.signal).toBe(controller.signal)
  })

  it("cancels structured extraction by racing AbortSignal, not request options", async () => {
    const seen: unknown[][] = []
    let started!: () => void
    const startedP = new Promise<void>((resolve) => { started = resolve })
    const { ctx } = fakeCtx()
    ctx.generate.text = async (...args: unknown[]) => {
      seen.push(args)
      started()
      await new Promise(() => {})
    }
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const controller = new AbortController()
    const resultP = client.session.prompt({
      path: { id: "ses_extract" },
      signal: controller.signal,
      body: {
        agent: "memorize-extract",
        format: { type: "json_schema" },
        parts: [{ type: "text", text: "TRANSCRIPT" }],
      },
    })
    await startedP
    controller.abort()
    const result = await resultP
    expect(result.error?.message).toMatch(/cancelled/i)
    expect(seen[0]?.length).toBe(1)
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
    messagePageResponses = [{ data: [
      { id: "msg_1", type: "user" },
      { id: "msg_2", type: "assistant", time: { completed: 2 }, finish: "stop", content: [{ type: "text", text: "done" }] },
      { type: "idle", outcome: "succeeded" },
    ] }]
    const result = await client.session.prompt({
      path: { id: "ses_y" },
      body: { agent: "memorize", model: { providerID: "acme", modelID: "m1" }, parts: [{ type: "text", text: "DO" }] },
    })
    expect(calls.map((c) => c.name)).toEqual(["switchAgent", "switchModel", "prompt", "wait"])
    expect((calls.find((call) => call.name === "prompt")!.args as any).text).toBe("DO")
    expect(result).toEqual({ data: { info: {}, parts: [{ type: "text", text: "done" }] } })
  })

  it.each([
    ["missing prompt", [{ type: "assistant", time: { completed: 2 }, finish: "stop" }]],
    ["stale reply", [{ type: "assistant", time: { completed: 2 }, finish: "stop" }, { id: "msg_1", type: "user" }]],
    ["partial turn", [{ id: "msg_1", type: "user" }, { type: "assistant", time: { completed: 2 }, finish: "tool-calls" }]],
    ["interrupted turn", [{ id: "msg_1", type: "user" }, { type: "assistant", time: { completed: 2 }, finish: "stop" }, { type: "idle", outcome: "interrupted" }]],
    ["unrelated reply", [{ id: "msg_1", type: "user" }, { id: "msg_other", type: "user" }, { type: "assistant", time: { completed: 2 }, finish: "stop" }]],
  ])("rejects %s after a successful wait", async (_name, rows) => {
    setV2Context(fakeCtx().ctx)
    messagePageResponses = [{ data: rows }]
    const client = buildV1ClientShim() as any
    const result = await client.session.prompt({ path: { id: "ses_y" }, body: { agent: "memorize", parts: [] } })
    expect(result.error).toBeDefined()
    expect(result.data).toBeUndefined()
  })

  it("preserves terminal provider errors and status codes from paginated messages", async () => {
    setV2Context(fakeCtx().ctx)
    messagePageResponses = [
      { data: [{ id: "msg_1", type: "user" }], cursor: { next: "reply" } },
      { data: [
        { type: "assistant", error: { type: "provider.rate-limit", message: "capacity", status: 429 } },
        { type: "idle", outcome: "failed" },
      ] },
    ]
    const result = await (buildV1ClientShim() as any).session.prompt({ path: { id: "ses_y" }, body: { agent: "memorize", parts: [] } })
    expect(result.data.info.error).toEqual({ name: "provider.rate-limit", data: { message: "capacity", statusCode: 429 } })
  })

  it("releases sessionless extraction handles without calling host session APIs", async () => {
    const { ctx, calls } = fakeCtx()
    setV2Context(ctx as any)
    serviceRemove = async () => { throw new Error("must not remove a synthetic session") }
    const client = buildV1ClientShim() as any
    const create = () => client.session.create({ body: { title: "codex-memory-extract-test" } })
    expect((await create()).data.id).toBe(EXTRACT_STUB_SESSION_ID)
    const path = { id: EXTRACT_STUB_SESSION_ID }
    await expect(client.session.abort({ path })).resolves.toEqual({})
    await expect(client.session.delete({ path })).resolves.toEqual({})
    expect((await client.session.get({ path })).response.status).toBe(404)
    expect((await create()).data.id).toBe(EXTRACT_STUB_SESSION_ID)
    await expect(client.session.delete({ path })).resolves.toEqual({})
    expect(calls).toEqual([])
  })

  it("maps NotFound gets to 404", async () => {
    const { ctx } = fakeCtx()
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const gone = await client.session.get({ path: { id: "ses_gone" } })
    expect(gone.response?.status).toBe(404)
    const live = await client.session.get({ path: { id: "ses_live" } })
    expect(live.data?.id).toBe("ses_live")
  })

  it("does not treat remove 200 as delete while get still returns the session", async () => {
    const { ctx } = fakeCtx()
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const still = await client.session.delete({ path: { id: "ses_live" } })
    expect(still.error?.message).toMatch(/still exists/i)
    const live = await client.session.get({ path: { id: "ses_live" } })
    expect(live.data?.id).toBe("ses_live")
  })

  it("marks a helper released only after remove plus a confirmed 404", async () => {
    const { ctx } = fakeCtx()
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    await expect(client.session.delete({ path: { id: "ses_gone" } })).resolves.toEqual({})
    const after = await client.session.get({ path: { id: "ses_gone" } })
    expect(after.response?.status).toBe(404)
  })

  it("does not treat interrupt as delete success while the session still exists", async () => {
    const { ctx, calls } = fakeCtx()
    serviceRemove = async () => { throw new Error("service unavailable") }
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    const stillThere = await client.session.delete({ path: { id: "ses_fallback" } })
    expect(stillThere.error?.message).toMatch(/still exists|service unavailable/i)
    expect(calls.some((call) => call.name === "interrupt")).toBe(true)
    expect(calls.some((call) => call.name === "wait")).toBe(true)
    const live = await client.session.get({ path: { id: "ses_fallback" } })
    expect(live.data?.id).toBe("ses_fallback")

    ctx.session.interrupt = async () => { throw new Error("local interrupt failed") }
    const failed = await client.session.delete({ path: { id: "ses_still-running" } })
    expect(failed.error?.message).toMatch(/service unavailable|local interrupt failed/i)
    const stillLive = await client.session.get({ path: { id: "ses_still-running" } })
    expect(stillLive.data?.id).toBe("ses_still-running")
  })

  it("accepts interrupt+wait as delete only after a confirmed 404", async () => {
    const { ctx, calls } = fakeCtx()
    serviceRemove = async () => { throw new Error("service unavailable") }
    setV2Context(ctx as any)
    const client = buildV1ClientShim() as any
    await expect(client.session.delete({ path: { id: "ses_gone" } })).resolves.toEqual({})
    expect(calls.some((call) => call.name === "interrupt")).toBe(true)
    expect(calls.some((call) => call.name === "wait")).toBe(true)
    const after = await client.session.get({ path: { id: "ses_gone" } })
    expect(after.response?.status).toBe(404)
  })

  it("adapts context() into messages rows", async () => {
    const client = buildV1ClientShim() as any
    const res = await client.session.messages({ path: { id: "ses_live" } })
    expect(res.data).toEqual([{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }])
  })

  it("falls back to observed sessions when no registered service is available", async () => {
    const { ctx } = fakeCtx()
    setV2Context(ctx as any)
    setV2ServiceDependenciesForTest({
      service: { discover: async () => undefined, headers: () => undefined },
      make: () => ({ session: {} }),
    })
    rememberV2Session("ses_local", "/proj", "local chat")
    rememberV2Session("ses_other", "/other", "codex-memory-consolidate")
    const client = buildV1ClientShim() as any
    const res = await client._client.get({
      url: "/experimental/session",
      query: { roots: true, limit: 10, directory: "" },
    })
    expect(res.data.map((row: { id: string }) => row.id).sort()).toEqual(["ses_local", "ses_other"])
    expect(res.data.find((row: { id: string }) => row.id === "ses_local")).toEqual(
      expect.objectContaining({ id: "ses_local", directory: "/proj" }),
    )
    const searched = await client._client.get({
      url: "/experimental/session",
      query: { limit: 10, search: "codex-memory-", directory: "" },
    })
    expect(searched.data.map((row: { id: string }) => row.id)).toEqual(["ses_other"])
  })

  it("uses ctx get/messages/delete when no registered service is available", async () => {
    const { ctx, calls } = fakeCtx()
    setV2Context(ctx as any)
    setV2ServiceDependenciesForTest({
      service: { discover: async () => undefined, headers: () => undefined },
      make: () => ({ session: {} }),
    })
    const client = buildV1ClientShim() as any
    const live = await client.session.get({ path: { id: "ses_live" } })
    expect(live.data?.id).toBe("ses_live")
    const gone = await client.session.get({ path: { id: "ses_gone" } })
    expect(gone.response?.status).toBe(404)
    const transcript = await client.session.messages({ path: { id: "ses_live" } })
    expect(transcript.data).toEqual([{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }])
    await expect(client.session.delete({ path: { id: "ses_fallback" } })).resolves.toEqual({})
    expect(calls.some((call) => call.name === "interrupt")).toBe(true)
    expect(calls.some((call) => call.name === "wait")).toBe(true)
    const after = await client.session.get({ path: { id: "ses_fallback" } })
    expect(after.response?.status).toBe(404)
  })
})
