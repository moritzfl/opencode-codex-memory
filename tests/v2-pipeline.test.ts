import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { closeDb } from "../src/db.js"
import { resetDiscoveryCacheForTest } from "../src/capture.js"
import { buildMemorySystemPrompt } from "../src/source.js"
import { DEFAULT_PHASE1_OPTIONS, runPhase1 } from "../src/phase1.js"
import { DEFAULT_PHASE2_OPTIONS, runPhase2 } from "../src/phase2.js"
import { resetPluginLifecycle } from "../src/lifecycle.js"
import { setPluginInput } from "../src/llm.js"
import { MemoryStore } from "../src/store.js"
import { setV2Context, buildV1ClientShim, resetV2ShimStateForTest } from "../src/v2/shim.js"
import { setV2ServiceDependenciesForTest } from "../src/v2/service.js"
import { captureWorkspaceDiff } from "../src/git-baseline.js"

const TEST_ROOT = path.join(os.tmpdir(), `ocm-v2pipeline-${process.pid}-${Date.now()}`)
const SESSION_ID = "ses_v2pipeline"

beforeEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetDiscoveryCacheForTest()
  resetV2ShimStateForTest()
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})

afterEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetDiscoveryCacheForTest()
  resetV2ShimStateForTest()
  setV2ServiceDependenciesForTest(null)
  setV2Context(null)
  setPluginInput({ client: undefined } as any)
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe("v2 fake-context write pipeline", () => {
  it.each([true, false])("extracts, validates the completed helper, and injects (public messages: %s)", async (publicMessages) => {
    const updatedAt = Date.now() - 7 * 60 * 60 * 1000
    const created: string[] = []
    const switched: { agent?: string; model?: unknown }[] = []
    const generated: unknown[] = []
    const interrupted: string[] = []
    const removed: string[] = []
    const memoryDir = path.join(TEST_ROOT, "memories")

    const ctx: any = {
      location: { directory: "/project" },
      options: {},
      session: {
        create: async (input: { title?: string }) => {
          const id = input.title?.includes("extract") ? "sub-extract" : "sub-consolidate"
          created.push(id)
          return { data: { id } }
        },
        switchAgent: async (input: { agent: string }) => {
          switched.push({ agent: input.agent })
        },
        switchModel: async (input: { model: unknown }) => {
          switched.push({ model: input.model })
        },
        prompt: async (input: { sessionID: string; text: string }) => {
          if (input.sessionID === "sub-consolidate") {
            fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# MEMORY.md\n\n- CSV parser uses strict typed rows.\n")
            fs.writeFileSync(path.join(memoryDir, "memory_summary.md"), "v1\n\n- CSV parser uses strict typed rows.\n")
          }
          return { id: "msg_1" }
        },
        wait: async () => {},
        interrupt: async (input: { sessionID: string }) => {
          interrupted.push(input.sessionID)
          return { interrupted: true }
        },
        get: async (input: { sessionID: string }) => {
          if (input.sessionID.startsWith("sub-")) throw { _tag: "SessionNotFoundError" }
          return { id: input.sessionID, parentID: null }
        },
        context: async (input: { sessionID: string }) => {
          if (input.sessionID === "sub-consolidate") return [
            { id: "msg_1", type: "user", text: "consolidate", time: { created: 1 } },
            { id: "msg_done", type: "assistant", time: { created: 2, completed: 3 }, finish: "stop", content: [{ type: "text", text: "done" }] },
            { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 4 } },
          ]
          if (input.sessionID !== SESSION_ID) return []
          return [
            { id: "u1", time: { created: 1 }, text: "Use the durable CSV parser convention.", type: "user" },
            {
              id: "a1",
              time: { created: 2 },
              type: "assistant",
              agent: "build",
              model: { id: "m", providerID: "p" },
              content: [{ type: "text", text: "Implemented the parser with strict typed rows." }],
            },
          ]
        },
      },
      generate: {
        text: async (input: { prompt: string; model?: unknown }) => {
          generated.push(input)
          return {
            text: '{"raw_memory":"CSV parser uses strict typed rows.","rollout_summary":"Implemented the typed CSV parser convention.","rollout_slug":"typed-csv-parser"}',
          }
        },
      },
      catalog: { model: { list: async () => ({ data: [] }) } },
      mcp: { list: async () => ({ data: [] }) },
    }
    setV2Context(ctx)
    setPluginInput({ client: buildV1ClientShim() } as any)
    setV2ServiceDependenciesForTest({
      service: { discover: async () => ({ url: "http://127.0.0.1:4096" }), headers: () => undefined },
      make: () => ({
        health: { get: async () => ({ healthy: true, version: "2.0.3", pid: process.pid }) },
        session: {
          list: async () => ({
            data: [{ id: SESSION_ID, title: "pipe", directory: "/project", parentID: null, time: { created: 1, updated: updatedAt } }],
            cursor: { next: null },
          }),
          create: async () => ({ id: "unused" }),
          get: async (input?: unknown) => {
            const sessionID = (input as { sessionID?: string } | undefined)?.sessionID ?? ""
            if (removed.includes(sessionID)) throw { _tag: "SessionNotFoundError" }
            return { id: sessionID, parentID: null }
          },
          remove: async (input?: unknown) => {
            removed.push((input as { sessionID?: string } | undefined)?.sessionID ?? "")
          },
          interrupt: async () => {},
        },
        ...(publicMessages ? { message: {
          list: async (input?: unknown) => ({ data: await ctx.session.context(input) }),
        } } : {}),
      }),
    })

    const store = new MemoryStore()
    await runPhase1(store, {
      ...DEFAULT_PHASE1_OPTIONS,
      maxClaimed: 1,
      extractModel: "test/extractor",
    }, async () => ({ ok: true }))

    expect(store.stage1Outputs()).toMatchObject([
      {
        session_id: SESSION_ID,
        raw_memory: "CSV parser uses strict typed rows.",
        rollout_slug: "typed-csv-parser",
        cwd: "/project",
      },
    ])
    // Extraction ran tool-less through generate.text (no helper session).
    expect(created).toEqual([])
    expect(generated).toHaveLength(1)
    expect((generated[0] as any).model).toEqual({ providerID: "test", id: "extractor", variant: "low" })
    expect((generated[0] as any).prompt).toContain("Use the durable CSV parser convention.")

    const phase2 = await runPhase2(store, {
      ...DEFAULT_PHASE2_OPTIONS,
      consolidationModel: "test/consolidator",
    })

    expect(phase2.status).toBe("succeeded")
    expect(created).toEqual(["sub-consolidate"])
    expect(switched).toContainEqual({ agent: "memorize" })
    expect(switched).toContainEqual({ model: { providerID: "test", id: "consolidator", variant: "medium" } })
    // The public service owns helper shutdown and deletion.
    expect(removed).toContain("sub-consolidate")
    expect(interrupted).toEqual([])
    expect((await captureWorkspaceDiff()).changes).toEqual([])

    const prompt = buildMemorySystemPrompt(true)
    expect(prompt).toContain("CSV parser uses strict typed rows.")
  })
})
