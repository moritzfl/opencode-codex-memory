import { describe, expect, it, spyOn } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { captureMemoryInjections, completedV2Reply, createSandbox, promptSession, repoRoot, type Sandbox, type ServeHandle } from "../scripts/lib/harness.js"

const user = { type: "user", id: "msg_new" }
const assistant = { type: "assistant", id: "msg_answer", time: { completed: 123 }, finish: "stop", content: [{ type: "text", text: "new answer" }] }

describe("live harness", () => {
  it("rejects stale replies, partial turns, tool continuations, and provider errors", () => {
    expect(completedV2Reply({ data: [assistant, user] }, user.id)).toBe("new answer")
    expect(() => completedV2Reply({ data: [user, assistant] }, user.id)).toThrow("no assistant reply")
    expect(() => completedV2Reply({ data: [assistant] }, user.id)).toThrow("missing from transcript")
    for (const change of [{ time: {} }, { finish: "tool-calls" }, { finish: undefined }]) {
      expect(() => completedV2Reply({ data: [{ ...assistant, ...change }, user] }, user.id)).toThrow("incomplete")
    }
    expect(() => completedV2Reply({ data: [{ ...assistant, error: { message: "quota exceeded" } }, user] }, user.id)).toThrow("quota exceeded")
  })

  it("uses an explicit package directory on both hosts without building and retains failed sandboxes", () => {
    // CI runs tests before build. Simulate a clean checkout even when local
    // dist/ exists, and fail immediately if sandbox setup launches a build.
    const existsSync = fs.existsSync
    const entry = path.join(repoRoot(), "dist/src/index.js")
    const exists = spyOn(fs, "existsSync").mockImplementation((file) => file === entry ? false : existsSync(file))
    const spawn = spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("sandbox setup must not spawn a build") })
    let sandbox: Sandbox | undefined
    try {
      sandbox = createSandbox()
      const config = JSON.parse(fs.readFileSync(path.join(sandbox.configHome, "opencode/opencode.json"), "utf8"))
      const pluginDir = fileURLToPath(config.plugin[0][0])
      expect(config.plugins[0].package).toBe(pluginDir)
      expect(config.plugins[0].options).toEqual(config.plugin[0][1])
      expect(config.plugins[0].options.test).toBe(true)
      expect(config.plugins[0].options.min_rollout_idle_hours).toBe(0.01)
      expect(fs.existsSync(path.join(pluginDir, "package.json"))).toBe(true)
      expect(fs.existsSync(path.join(sandbox.project, ".opencode/plugins"))).toBe(false)
      expect(config.permission).toBeUndefined()
      sandbox.keep = true
      sandbox.cleanup()
      expect(fs.existsSync(sandbox.root)).toBe(true)
      sandbox.keep = false
      sandbox.cleanup()
      expect(fs.existsSync(sandbox.root)).toBe(false)
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      spawn.mockRestore()
      exists.mockRestore()
      if (sandbox) {
        sandbox.keep = false
        sandbox.cleanup()
      }
    }
  })

  it("waits for V2 turn completion and aborts a stuck wait within the prompt deadline", async () => {
    const sandbox = createSandbox({ bare: true })
    let waiting = false
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith("/prompt")) return Response.json({ id: user.id })
        if (url.pathname.endsWith("/wait")) {
          waiting = true
          await new Promise((resolve) => setTimeout(resolve, 250))
          return new Response(null, { status: 204 })
        }
        throw new Error("messages must not be read before wait resolves")
      },
    })
    const serve: ServeHandle = { baseUrl: server.url.href, port: server.port!, v2: true, logPath: "", stop: async () => {} }
    try {
      await expect(promptSession(serve, sandbox, "ses_test", "new prompt", { timeoutMs: 100 })).rejects.toThrow("timed out")
      expect(waiting).toBe(true)
    } finally {
      server.stop(true)
      sandbox.keep = false
      sandbox.cleanup()
    }
  })

  it("captures only injected summaries after both native host hooks and preserves cleanup", async () => {
    const sandbox = createSandbox()
    const entry = path.join(sandbox.root, "fake-plugin.js")
    const summary = "v1\n\nHEAD\nö\nTAIL"
    const prompt = `private instructions\n========= MEMORY_SUMMARY BEGINS =========\n${summary}\n========= MEMORY_SUMMARY ENDS =========`
    fs.writeFileSync(entry, `export default {
      id: "fake-memory",
      async server() { return { "experimental.chat.system.transform": async (_, out) => out.system.push(${JSON.stringify(prompt)}) } },
      async setup(ctx) {
        if (!ctx?.session?.hook) return
        await ctx.session.hook("context", (event) => event.system.push({ type: "text", text: ${JSON.stringify(prompt)} }))
        return () => { ctx.cleaned = true }
      },
    }`)
    try {
      const read = captureMemoryInjections(sandbox, entry)
      expect(read()).toEqual([])
      const plugin = (await import(path.join(sandbox.project, ".opencode/memory-plugin/index.js"))).default
      const hooks = await plugin.server({})
      const out = { system: ["private base prompt"] }
      await hooks["experimental.chat.system.transform"]({ sessionID: "ses_v1" }, out)
      expect(out.system.at(-1)).toBe(prompt)
      await plugin.setup({}) // V1 can invoke setup without a V2 context.
      const handlers: ((event: any) => void)[] = []
      const ctx = { location: { directory: sandbox.project }, cleaned: false,
        session: { hook: async (_: string, handler: (event: any) => void) => { handlers.push(handler) } } }
      const cleanup = await plugin.setup(ctx)
      const event = { sessionID: "ses_v2", system: [{ type: "text", text: "private base prompt" }] }
      for (const handler of handlers) handler(event)
      expect(event.system.at(-1)?.text).toBe(prompt)
      await cleanup()
      expect(ctx.cleaned).toBe(true)
      expect(read()).toEqual([{ sessionID: "ses_v1", summary }, { sessionID: "ses_v2", summary }])
      expect(fs.readFileSync(path.join(sandbox.root, "memory-injections.jsonl"), "utf8")).not.toContain("private")
    } finally {
      sandbox.keep = false
      sandbox.cleanup()
    }
  })
})
