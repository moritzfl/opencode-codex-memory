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

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-pipeline-${process.pid}-${Date.now()}`)
const SESSION_ID = "ses_pipeline"

beforeEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetDiscoveryCacheForTest()
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})

afterEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetDiscoveryCacheForTest()
  setPluginInput({ client: undefined } as any)
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe("fake-subagent write pipeline", () => {
  it("extracts, consolidates, validates, and injects memory without a live model", async () => {
    const updatedAt = Date.now() - 7 * 60 * 60 * 1000
    const created: string[] = []
    const prompted: string[] = []
    const deleted: string[] = []
    const memoryDir = path.join(TEST_ROOT, "memories")

    setPluginInput({
      client: {
        _client: {
          get: async ({ url }: { url: string }) => {
            if (url !== "/experimental/session") throw new Error(`unexpected URL ${url}`)
            return { data: [{ id: SESSION_ID, directory: "/project", time: { updated: updatedAt } }] }
          },
        },
        session: {
          messages: async () => ({
            data: [
              { info: { role: "user" }, parts: [{ type: "text", text: "Use the durable CSV parser convention." }] },
              { info: { role: "assistant" }, parts: [{ type: "text", text: "Implemented the parser with strict typed rows." }] },
            ],
          }),
          create: async (request: { body: { title?: string } }) => {
            const id = request.body.title?.includes("extract") ? "sub-extract" : "sub-consolidate"
            created.push(id)
            return { data: { id } }
          },
          prompt: async (request: { path: { id: string }; body: { agent: string } }) => {
            prompted.push(request.body.agent)
            if (request.body.agent === "memorize-extract") {
              return {
                data: {
                  info: {
                    structured: {
                      raw_memory: "CSV parser uses strict typed rows.",
                      rollout_summary: "Implemented the typed CSV parser convention.",
                      rollout_slug: "typed-csv-parser",
                    },
                  },
                },
              }
            }

            fs.writeFileSync(path.join(memoryDir, "MEMORY.md"), "# MEMORY.md\n\n- CSV parser uses strict typed rows.\n")
            fs.writeFileSync(path.join(memoryDir, "memory_summary.md"), "v1\n\n- CSV parser uses strict typed rows.\n")
            return { data: { info: {}, parts: [{ type: "text", text: "consolidated" }] } }
          },
          delete: async (request: { path: { id: string } }) => {
            deleted.push(request.path.id)
            return { data: {} }
          },
          get: async (req: { path: { id: string } }) => {
            if (req.path.id.startsWith("sub-")) return { response: { status: 404 } }
            return { data: { id: req.path.id }, response: { status: 200 } }
          },
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)

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
    expect(prompted).toEqual(["memorize-extract"])
    expect(created).toEqual(["sub-extract"])
    expect(deleted).toEqual(["sub-extract"])

    const phase2 = await runPhase2(store, {
      ...DEFAULT_PHASE2_OPTIONS,
      consolidationModel: "test/consolidator",
    })

    expect(phase2.status).toBe("succeeded")
    expect(prompted).toEqual(["memorize-extract", "memorize"])
    expect(created).toEqual(["sub-extract", "sub-consolidate"])
    expect(deleted).toEqual(["sub-extract", "sub-consolidate"])
    expect(fs.readFileSync(path.join(memoryDir, "MEMORY.md"), "utf8")).toContain("strict typed rows")
    expect(fs.readFileSync(path.join(memoryDir, "memory_summary.md"), "utf8")).toMatch(/^v1\n/)

    const prompt = buildMemorySystemPrompt(true)
    expect(prompt).toContain("CSV parser uses strict typed rows")
  })
})
