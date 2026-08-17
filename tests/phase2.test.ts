import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { closeDb, openDb } from "../src/db.js"
import { captureWorkspaceDiff } from "../src/git-baseline.js"
import { beginPluginShutdown, resetPluginLifecycle } from "../src/lifecycle.js"
import { setPluginInput } from "../src/llm.js"
import {
  DEFAULT_PHASE2_OPTIONS,
  dropGonePhase2Inputs,
  runPhase2,
  selectLivePhase2Inputs,
} from "../src/phase2.js"
import { noteProviderCapacityExhausted, resetRateLimitForTest } from "../src/ratelimit.js"
import { MemoryStore } from "../src/store.js"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-phase2-${process.pid}-${Date.now()}`)

beforeEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetRateLimitForTest()
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})

afterEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetRateLimitForTest()
  setPluginInput({ client: undefined } as any)
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe("phase 2 orchestration", () => {
  function installStalledConsolidator(aborted: string[], deleted: string[]): void {
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-phase2-heartbeat" } }),
          prompt: async () => new Promise(() => {}),
          abort: async (req: { path: { id: string } }) => {
            aborted.push(req.path.id)
            return { data: {} }
          },
          delete: async (req: { path: { id: string } }) => {
            deleted.push(req.path.id)
            return { data: {} }
          },
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)
  }

  it("preserves the workspace diff when the assistant response contains an error", async () => {
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-phase2" } }),
          prompt: async () => ({
            data: { info: { error: { name: "ProviderAuthError", data: { message: "expired key" } } }, parts: [] },
          }),
          delete: async () => ({ data: {} }),
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)

    const result = await runPhase2(new MemoryStore())
    expect(result.status).toBe("failed")

    const job = openDb()
      .prepare("SELECT status, lease_until, last_error FROM memory_jobs WHERE kind='memory_consolidate_global'")
      .get() as { status: string; lease_until: number | null; last_error: string }
    expect(job.status).toBe("failed")
    expect(job.lease_until).toBeNull()
    expect(job.last_error).toContain("ProviderAuthError")

    const pending = await captureWorkspaceDiff()
    expect(pending.changes.some((change) => change.path === "raw_memories.md")).toBe(true)
  })

  it("skips claiming when provider capacity is exhausted", async () => {
    noteProviderCapacityExhausted("phase2")
    const result = await runPhase2(new MemoryStore())
    expect(result.status).toBe("skipped_rate_limit")
    expect(
      openDb().prepare("SELECT 1 FROM memory_jobs WHERE kind='memory_consolidate_global'").get(),
    ).toBeNull()
  })

  it("holds the lease when the consolidation sub-session cannot be closed", async () => {
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-phase2-stuck" } }),
          prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "done" }] } }),
          delete: async () => ({ error: { message: "delete failed" } }),
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)

    const result = await runPhase2(new MemoryStore())
    expect(result.status).toBe("shutdown_failed")

    // codex phase2.rs: neither succeed nor fail — the lease must survive so no
    // other worker can race a consolidator that may still be running.
    const job = openDb()
      .prepare("SELECT status, lease_until FROM memory_jobs WHERE kind='memory_consolidate_global'")
      .get() as { status: string; lease_until: number | null }
    expect(job.status).toBe("running")
    expect(job.lease_until).toBeGreaterThan(Math.floor(Date.now() / 1000))

    // The workspace diff stays pending so the next run still has input.
    const pending = await captureWorkspaceDiff()
    expect(pending.changes.some((change) => change.path === "raw_memories.md")).toBe(true)
  })

  it("aborts the consolidator immediately when another worker takes ownership", async () => {
    const aborted: string[] = []
    const deleted: string[] = []
    installStalledConsolidator(aborted, deleted)
    const store = new MemoryStore()
    const ownedHeartbeat = store.heartbeatPhase2Job.bind(store)
    let heartbeats = 0
    store.heartbeatPhase2Job = (token: string) => {
      heartbeats++
      if (heartbeats === 1) return ownedHeartbeat(token)
      openDb()
        .prepare("UPDATE memory_jobs SET ownership_token='replacement-worker' WHERE kind='memory_consolidate_global'")
        .run()
      return false
    }

    const result = await runPhase2(store, { ...DEFAULT_PHASE2_OPTIONS, heartbeatIntervalMs: 5 })
    expect(result.status).toBe("heartbeat_lost")
    expect(aborted).toEqual(["sub-phase2-heartbeat"])
    expect(deleted).toEqual(["sub-phase2-heartbeat"])
    const job = openDb()
      .prepare("SELECT status, ownership_token FROM memory_jobs WHERE kind='memory_consolidate_global'")
      .get() as { status: string; ownership_token: string }
    expect(job).toEqual({ status: "running", ownership_token: "replacement-worker" })
    expect((await captureWorkspaceDiff()).changes.length).toBeGreaterThan(0)
  })

  it("aborts the consolidator on a heartbeat database error", async () => {
    const aborted: string[] = []
    const deleted: string[] = []
    installStalledConsolidator(aborted, deleted)
    const store = new MemoryStore()
    const ownedHeartbeat = store.heartbeatPhase2Job.bind(store)
    let heartbeats = 0
    store.heartbeatPhase2Job = (token: string) => {
      heartbeats++
      if (heartbeats === 1) return ownedHeartbeat(token)
      throw new Error("heartbeat database unavailable")
    }

    const result = await runPhase2(store, { ...DEFAULT_PHASE2_OPTIONS, heartbeatIntervalMs: 5 })
    expect(result.status).toBe("heartbeat_lost")
    expect(aborted).toEqual(["sub-phase2-heartbeat"])
    expect(deleted).toEqual(["sub-phase2-heartbeat"])
    const job = openDb()
      .prepare("SELECT status, lease_until, last_error FROM memory_jobs WHERE kind='memory_consolidate_global'")
      .get() as { status: string; lease_until: number | null; last_error: string }
    expect(job.status).toBe("failed")
    expect(job.lease_until).toBeNull()
    expect(job.last_error).toContain("heartbeat database unavailable")
  })

  it("releases the claim on dispose mid-consolidator without failure backoff", async () => {
    const aborted: string[] = []
    const deleted: string[] = []
    setPluginInput({
      client: {
        session: {
          create: async () => ({ data: { id: "sub-phase2-dispose" } }),
          // Hang after dispose so the AbortSignal path cancels the prompt
          // (mirrors plugin reload while the consolidator is mid-write).
          prompt: async () => {
            beginPluginShutdown()
            return new Promise(() => {})
          },
          abort: async (req: { path: { id: string } }) => {
            aborted.push(req.path.id)
            return { data: {} }
          },
          delete: async (req: { path: { id: string } }) => {
            deleted.push(req.path.id)
            return { data: {} }
          },
        },
        config: { get: async () => ({ data: {} }) },
      },
    } as any)

    const store = new MemoryStore()
    const result = await runPhase2(store)
    expect(result.status).toBe("shutting_down")
    expect(aborted).toEqual(["sub-phase2-dispose"])
    expect(deleted).toEqual(["sub-phase2-dispose"])

    const job = openDb()
      .prepare(
        "SELECT status, lease_until, retry_at, last_error FROM memory_jobs WHERE kind='memory_consolidate_global'",
      )
      .get() as {
        status: string
        lease_until: number | null
        retry_at: number | null
        last_error: string | null
      }
    expect(job.status).toBe("pending")
    expect(job.lease_until).toBeNull()
    expect(job.retry_at).toBeNull()
    expect(job.last_error).toContain("shutting down")

    // Next process can reclaim immediately (unlike markPhase2Failed's 1h backoff).
    resetPluginLifecycle()
    const reclaim = store.claimGlobalPhase2Job()
    expect(reclaim.type).toBe("claimed")
  })

  it("drops phase2 inputs whose sessions are gone and keeps unknown/live", async () => {
    setPluginInput({
      client: {
        session: {
          get: async (req: { path: { id: string } }) => {
            if (req.path.id === "ses_gone") return { response: { status: 404 } }
            if (req.path.id === "ses_err") return { error: { status: 500 } }
            return { data: { id: req.path.id }, response: { status: 200 } }
          },
        },
      },
    } as any)
    const store = new MemoryStore()
    const ts = Date.now()
    for (const id of ["ses_live", "ses_gone", "ses_err"] as const) {
      store.upsertStage1Output({
        session_id: id,
        source_updated_at: ts,
        raw_memory: id,
        rollout_summary: id,
        rollout_slug: id,
        cwd: "/p",
        generated_at: ts,
      })
    }
    const kept = await dropGonePhase2Inputs(store, store.getPhase2InputSelection(50, 30))
    expect(kept.map((o) => o.session_id).sort()).toEqual(["ses_err", "ses_live"])
    expect(store.stage1Outputs().map((o) => o.session_id).sort()).toEqual(["ses_err", "ses_live"])
  })

  it("backfills a gone top-ranked input with the next live session", async () => {
    setPluginInput({
      client: {
        session: {
          get: async (req: { path: { id: string } }) =>
            req.path.id === "ses_gone"
              ? { response: { status: 404 } }
              : { data: { id: req.path.id }, response: { status: 200 } },
        },
      },
    } as any)
    const store = new MemoryStore()
    const ts = Date.now()
    store.upsertStage1Output({
      session_id: "ses_live",
      source_updated_at: ts,
      raw_memory: "live",
      rollout_summary: "live",
      rollout_slug: "live",
      cwd: "/p",
      generated_at: ts,
    })
    store.upsertStage1Output({
      session_id: "ses_gone",
      source_updated_at: ts + 1,
      raw_memory: "gone",
      rollout_summary: "gone",
      rollout_slug: "gone",
      cwd: "/p",
      generated_at: ts + 1,
    })

    const selected = await selectLivePhase2Inputs(store, 1, 30)
    expect(selected.map((o) => o.session_id)).toEqual(["ses_live"])
    expect(store.stage1Outputs().map((o) => o.session_id)).toEqual(["ses_live"])
  })

  it("preserves ranking while backfilling across liveness chunks", async () => {
    const gone = new Set(["ses_rank_11", "ses_rank_9", "ses_rank_4"])
    setPluginInput({
      client: {
        session: {
          get: async (req: { path: { id: string } }) => gone.has(req.path.id)
            ? { response: { status: 404 } }
            : { data: { id: req.path.id }, response: { status: 200 } },
        },
      },
    } as any)
    const store = new MemoryStore()
    const ts = Date.now()
    for (let i = 0; i < 12; i++) {
      const id = `ses_rank_${i}`
      store.upsertStage1Output({
        session_id: id,
        source_updated_at: ts + i,
        raw_memory: id,
        rollout_summary: id,
        rollout_slug: id,
        cwd: "/p",
        generated_at: ts + i,
      })
    }

    const selected = await selectLivePhase2Inputs(store, 9, 30)
    expect(selected.map((o) => o.session_id)).toEqual([
      "ses_rank_10",
      "ses_rank_8",
      "ses_rank_7",
      "ses_rank_6",
      "ses_rank_5",
      "ses_rank_3",
      "ses_rank_2",
      "ses_rank_1",
      "ses_rank_0",
    ])
  })

  it("terminates when every ranked phase2 input is gone", async () => {
    setPluginInput({
      client: { session: { get: async () => ({ response: { status: 404 } }) } },
    } as any)
    const store = new MemoryStore()
    const ts = Date.now()
    for (let i = 0; i < 10; i++) {
      const id = `ses_all_gone_${i}`
      store.upsertStage1Output({
        session_id: id,
        source_updated_at: ts + i,
        raw_memory: id,
        rollout_summary: id,
        rollout_slug: id,
        cwd: "/p",
        generated_at: ts + i,
      })
    }
    expect(await selectLivePhase2Inputs(store, 4, 30)).toEqual([])
    expect(store.stage1Outputs()).toEqual([])
  })
})
