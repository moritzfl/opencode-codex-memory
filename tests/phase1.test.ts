import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { closeDb, openDb } from "../src/db.js"
import { setPluginInput } from "../src/llm.js"
import { DEFAULT_PHASE1_OPTIONS, runPhase1 } from "../src/phase1.js"
import { MemoryStore } from "../src/store.js"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-phase1-${process.pid}-${Date.now()}`)
const SESSION_ID = "ses_phase1_empty"

beforeEach(() => {
  closeDb()
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})

afterEach(() => {
  closeDb()
  setPluginInput({ client: undefined } as any)
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

function installClient(messageRows: unknown[]): number {
  const updatedAt = Date.now() - 7 * 60 * 60 * 1000
  setPluginInput({
    client: {
      project: { list: async () => ({ data: [{ worktree: "/project" }] }) },
      session: {
        list: async () => ({
          data: [{ id: SESSION_ID, directory: "/project", time: { updated: updatedAt } }],
        }),
        messages: async () => ({ data: messageRows }),
      },
    },
  } as any)
  return updatedAt
}

function seedExisting(store: MemoryStore, sourceUpdatedAt: number): void {
  store.upsertStage1Output({
    session_id: SESSION_ID,
    source_updated_at: sourceUpdatedAt - 1,
    raw_memory: "existing raw memory",
    rollout_summary: "existing summary",
    rollout_slug: "existing",
    generated_at: sourceUpdatedAt - 1,
  })
}

async function run(store: MemoryStore): Promise<void> {
  await runPhase1(store, DEFAULT_PHASE1_OPTIONS, async () => ({ ok: true }))
}

describe("phase 1 empty transcript handling", () => {
  it("accepts a first-time genuinely empty session as no-output", async () => {
    installClient([])
    const store = new MemoryStore()
    await run(store)

    expect(store.stage1Outputs()).toEqual([])
    const job = openDb()
      .prepare("SELECT status, last_error FROM memory_jobs WHERE kind='memory_stage1' AND job_key=?")
      .get(SESSION_ID) as { status: string; last_error: string | null }
    expect(job).toEqual({ status: "done", last_error: null })
  })

  it("retries an empty API success instead of erasing an existing extraction", async () => {
    const updatedAt = installClient([])
    const store = new MemoryStore()
    seedExisting(store, updatedAt)
    await run(store)

    expect(store.stage1Outputs()[0].raw_memory).toBe("existing raw memory")
    const job = openDb()
      .prepare("SELECT status, last_error FROM memory_jobs WHERE kind='memory_stage1' AND job_key=?")
      .get(SESSION_ID) as { status: string; last_error: string }
    expect(job.status).toBe("pending")
    expect(job.last_error).toContain("empty transcript for previously extracted session")
  })

  it("also preserves existing output when every returned part is filtered", async () => {
    const updatedAt = installClient([
      { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "not extractable" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "ignored", ignored: true }] },
    ])
    const store = new MemoryStore()
    seedExisting(store, updatedAt)
    await run(store)

    expect(store.stage1Outputs()[0].rollout_summary).toBe("existing summary")
    const job = openDb()
      .prepare("SELECT status FROM memory_jobs WHERE kind='memory_stage1' AND job_key=?")
      .get(SESSION_ID) as { status: string }
    expect(job.status).toBe("pending")
  })
})
