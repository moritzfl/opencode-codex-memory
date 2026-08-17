import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { closeDb, openDb } from "../src/db.js"
import { setPluginInput } from "../src/llm.js"
import { beginPluginShutdown, resetPluginLifecycle } from "../src/lifecycle.js"
import { DEFAULT_PHASE1_OPTIONS, runPhase1 } from "../src/phase1.js"
import { resetRateLimitForTest } from "../src/ratelimit.js"
import { MemoryStore } from "../src/store.js"
import { resetDiscoveryCacheForTest } from "../src/capture.js"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-phase1-${process.pid}-${Date.now()}`)
const SESSION_ID = "ses_phase1_empty"

beforeEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetDiscoveryCacheForTest()
  resetRateLimitForTest()
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})

afterEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetDiscoveryCacheForTest()
  resetRateLimitForTest()
  setPluginInput({ client: undefined } as any)
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

function installClient(messageRows: unknown[]): number {
  const updatedAt = Date.now() - 7 * 60 * 60 * 1000
  setPluginInput({
    client: {
      _client: {
        get: async ({ url }: { url: string }) => {
          if (url !== "/experimental/session") throw new Error(`unexpected url ${url}`)
          return {
            data: [{ id: SESSION_ID, directory: "/project", time: { updated: updatedAt } }],
          }
        },
      },
      session: {
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

describe("phase 1 dispose mid-pass", () => {
  it("releases claimed jobs without leaving them running until lease expiry", async () => {
    let messagesCalls = 0
    const updatedAt = Date.now() - 7 * 60 * 60 * 1000
    setPluginInput({
      client: {
        _client: {
          get: async () => ({
            data: [{ id: SESSION_ID, directory: "/project", time: { updated: updatedAt } }],
          }),
        },
        session: {
          messages: async () => {
            messagesCalls++
            // Dispose races the claimed job before transcript work finishes.
            beginPluginShutdown()
            return { data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }] }
          },
        },
      },
    } as any)

    const store = new MemoryStore()
    await runPhase1(store, DEFAULT_PHASE1_OPTIONS, async () => ({ ok: true }))

    expect(messagesCalls).toBe(1)
    const job = openDb()
      .prepare(
        "SELECT status, lease_until, retry_at, last_error FROM memory_jobs WHERE kind='memory_stage1' AND job_key=?",
      )
      .get(SESSION_ID) as {
        status: string
        lease_until: number | null
        retry_at: number | null
        last_error: string | null
      }
    expect(job.status).toBe("pending")
    expect(job.lease_until).toBeNull()
    expect(job.retry_at).toBeNull()
    expect(job.last_error).toContain("shutting down")
  })
})

describe("phase 1 provider capacity", () => {
  const OTHER_ID = "ses_phase1_other"

  function installExtractClient(opts: {
    prompt: (sessionId: string) => unknown
    sessions?: string[]
  }): { prompted: string[]; updatedAt: number } {
    const updatedAt = Date.now() - 7 * 60 * 60 * 1000
    const prompted: string[] = []
    let created = 0
    const ids = opts.sessions ?? [SESSION_ID]
    setPluginInput({
      client: {
        _client: {
          get: async ({ url }: { url: string }) => {
            if (url !== "/experimental/session") throw new Error(`unexpected url ${url}`)
            return {
              data: ids.map((id) => ({ id, directory: "/project", time: { updated: updatedAt } })),
            }
          },
        },
        session: {
          messages: async () => ({
            data: [{ info: { role: "user" }, parts: [{ type: "text", text: "remember this convention" }] }],
          }),
          create: async () => ({ data: { id: `sub-extract-${created++}` } }),
          prompt: async (request: { path: { id: string } }) => {
            prompted.push(request.path.id)
            return opts.prompt(request.path.id)
          },
          delete: async () => ({ data: {} }),
          get: async () => ({ response: { status: 404 } }),
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)
    return { prompted, updatedAt }
  }

  function jobRow(id: string) {
    return openDb()
      .prepare(
        "SELECT status, retry_remaining, last_error FROM memory_jobs WHERE kind='memory_stage1' AND job_key=?",
      )
      .get(id) as { status: string; retry_remaining: number; last_error: string | null }
  }

  it("does not permanently fail a host-shaped 429 and skips later claims until capacity returns", async () => {
    const { prompted } = installExtractClient({
      prompt: () => ({
        data: {
          info: { error: { name: "APIError", data: { message: "Free usage exceeded", statusCode: 429 } } },
        },
      }),
    })
    const store = new MemoryStore()
    await runPhase1(store, { ...DEFAULT_PHASE1_OPTIONS, maxClaimed: 1 })
    const afterFail = jobRow(SESSION_ID)
    expect(afterFail.status).toBe("pending")
    expect(afterFail.retry_remaining).toBe(3)
    expect(afterFail.last_error).toContain("Free usage exceeded")
    expect(afterFail.last_error).toContain("HTTP 429")
    expect(prompted.length).toBe(1)

    await runPhase1(store, { ...DEFAULT_PHASE1_OPTIONS, maxClaimed: 1 })
    expect(prompted.length).toBe(1)
  })

  it("retries the same session after quota recovers without new activity", async () => {
    const { updatedAt } = installExtractClient({
      prompt: () => ({
        data: {
          info: {
            structured: {
              raw_memory: "recovered raw",
              rollout_summary: "recovered summary",
              rollout_slug: "recovered",
            },
          },
        },
      }),
    })
    const store = new MemoryStore()
    const token = store.claimStage1Jobs([{ id: SESSION_ID, updated_at: updatedAt }])[0].ownershipToken
    store.markStage1Failed(SESSION_ID, token, "The usage limit has been reached")
    openDb().prepare("UPDATE memory_jobs SET retry_at=1 WHERE job_key=?").run(SESSION_ID)
    resetRateLimitForTest()

    await runPhase1(store, { ...DEFAULT_PHASE1_OPTIONS, maxClaimed: 1 })
    expect(store.stage1Outputs()[0]?.raw_memory).toBe("recovered raw")
    expect(jobRow(SESSION_ID).status).toBe("done")
  })

  it("reopens an already-exhausted quota job without new session activity", async () => {
    const { updatedAt } = installExtractClient({
      prompt: () => ({
        data: {
          info: {
            structured: {
              raw_memory: "late raw",
              rollout_summary: "late summary",
              rollout_slug: "late",
            },
          },
        },
      }),
    })
    const store = new MemoryStore()
    store.claimStage1Jobs([{ id: SESSION_ID, updated_at: updatedAt }])
    openDb()
      .prepare(
        `UPDATE memory_jobs SET status='failed', retry_remaining=0, retry_at=1,
           last_error='sub-agent prompt failed (APIError): The usage limit has been reached',
           lease_until=NULL WHERE job_key=?`,
      )
      .run(SESSION_ID)

    await runPhase1(store, { ...DEFAULT_PHASE1_OPTIONS, maxClaimed: 1 })
    expect(store.stage1Outputs()[0]?.raw_memory).toBe("late raw")
    expect(jobRow(SESSION_ID).status).toBe("done")
  })

  it("still exhausts non-retryable extraction failures", async () => {
    installExtractClient({
      prompt: () => ({
        data: { info: { error: { name: "UnknownError", data: { message: "malformed transcript" } } } },
      }),
    })
    const store = new MemoryStore()
    for (let i = 0; i < 3; i++) {
      resetRateLimitForTest()
      openDb().prepare("UPDATE memory_jobs SET retry_at=1 WHERE job_key=?").run(SESSION_ID)
      await runPhase1(store, { ...DEFAULT_PHASE1_OPTIONS, maxClaimed: 1 })
    }
    const job = jobRow(SESSION_ID)
    expect(job.status).toBe("failed")
    expect(job.retry_remaining).toBe(0)
    expect(job.last_error).toContain("malformed transcript")
  })

  it("does not burn retries on sibling jobs after quota is observed", async () => {
    const { prompted } = installExtractClient({
      sessions: [SESSION_ID, OTHER_ID],
      prompt: () => ({
        data: {
          info: { error: { name: "APIError", data: { message: "The usage limit has been reached" } } },
        },
      }),
    })
    const store = new MemoryStore()
    await runPhase1(store, { ...DEFAULT_PHASE1_OPTIONS, maxClaimed: 2 })
    expect(prompted.length).toBeGreaterThanOrEqual(1)
    expect(prompted.length).toBeLessThanOrEqual(2)
    expect(jobRow(SESSION_ID).status).toBe("pending")
    expect(jobRow(OTHER_ID).status).toBe("pending")
    expect(jobRow(SESSION_ID).retry_remaining).toBe(3)
    expect(jobRow(OTHER_ID).retry_remaining).toBe(3)
  })

  it("does not burn retries on queued claims beyond extraction concurrency", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `ses_capacity_${i}`)
    const { prompted } = installExtractClient({
      sessions: ids,
      prompt: () => ({
        data: {
          info: { error: { name: "APIError", data: { message: "Free usage exceeded", statusCode: 429 } } },
        },
      }),
    })
    const store = new MemoryStore()
    await runPhase1(store, { ...DEFAULT_PHASE1_OPTIONS, maxClaimed: ids.length })
    expect(prompted.length).toBeLessThanOrEqual(8)
    for (const id of ids) {
      expect(jobRow(id).status).toBe("pending")
      expect(jobRow(id).retry_remaining).toBe(3)
    }
  })
})
