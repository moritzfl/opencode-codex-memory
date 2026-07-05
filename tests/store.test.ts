import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-store-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
  const { closeDb } = require("../src/db.js")
  closeDb()
})
afterEach(() => {
  const { closeDb } = require("../src/db.js")
  closeDb()
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
})

function sessions(...ids: string[]) {
  return ids.map((id) => ({ id, updated_at: 1000 }))
}

function claimedIds(claims: Array<{ sessionId: string }>): string[] {
  return claims.map((c) => c.sessionId)
}

/** Claims a single session and returns its ownership token (throws if not claimed). */
function claimOne(store: any, id: string, updatedAt = 1000): string {
  const claims = store.claimStage1Jobs([{ id, updated_at: updatedAt }])
  if (claims.length !== 1) throw new Error(`expected to claim ${id}`)
  return claims[0].ownershipToken
}

describe("MemoryStore stage1", () => {
  it("claims jobs and dedupes by session", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const claimed = store.claimStage1Jobs(sessions("s1", "s2", "s1"))
    expect(claimedIds(claimed)).toEqual(["s1", "s2"])
    // Per-claim ownership tokens (codex uses a fresh UUID per claim).
    expect(claimed[0].ownershipToken).not.toBe(claimed[1].ownershipToken)
  })

  it("respects the concurrency cap", () => {
    const { MemoryStore, STAGE1_CONCURRENCY } = require("../src/store.js")
    const store = new MemoryStore()
    const many = Array.from({ length: STAGE1_CONCURRENCY + 5 }, (_, i) => ({ id: `s${i}`, updated_at: 1000 }))
    const claimed = store.claimStage1Jobs(many)
    expect(claimed.length).toBe(STAGE1_CONCURRENCY)
  })

  it("uses maxClaimed as the running-jobs cap like codex max_running_jobs", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, updated_at: 1000 }))
    const claimed = store.claimStage1Jobs(many, undefined, 2)
    expect(claimed.length).toBe(2)
    // Jobs still running: a second pass cannot exceed the cap either.
    expect(store.claimStage1Jobs(many, undefined, 2).length).toBe(0)
  })

  it("enforces the running-jobs cap across separate DB connections", () => {
    // Regression for the multi-instance extraction storm: every opencode
    // instance (TUI, web panel, per-project) loads the plugin and runs its
    // own phase-1 pass, so the cap must hold via memory.db, not process state.
    const { MemoryStore } = require("../src/store.js")
    const { memoryDbPath } = require("../src/paths.js")
    const { Database } = require("bun:sqlite")
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, updated_at: 1000 }))
    const storeA = new MemoryStore()
    expect(storeA.claimStage1Jobs(many, undefined, 2).length).toBe(2)
    const dbB = new Database(memoryDbPath(), { readwrite: true })
    dbB.exec("PRAGMA busy_timeout=5000")
    try {
      const storeB = new MemoryStore(dbB)
      expect(storeB.claimStage1Jobs(many, undefined, 2).length).toBe(0)
    } finally {
      dbB.close()
    }
  })

  it("clamps maxClaimed to the concurrency ceiling", () => {
    const { MemoryStore, STAGE1_CONCURRENCY } = require("../src/store.js")
    const store = new MemoryStore()
    const many = Array.from({ length: STAGE1_CONCURRENCY + 5 }, (_, i) => ({ id: `s${i}`, updated_at: 1000 }))
    const claimed = store.claimStage1Jobs(many, undefined, 999)
    expect(claimed.length).toBe(STAGE1_CONCURRENCY)
  })

  it("reclaims a running job once its lease expires", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    expect(claimedIds(store.claimStage1Jobs(sessions("s1")))).toEqual(["s1"])
    expect(store.claimStage1Jobs(sessions("s1"))).toEqual([])
    openDb().prepare("UPDATE memory_jobs SET lease_until = 1 WHERE job_key = 's1'").run()
    expect(claimedIds(store.claimStage1Jobs(sessions("s1")))).toEqual(["s1"])
  })

  it("reclaims a done job only when the session has newer activity", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const token = claimOne(store, "s1")
    store.markStage1Succeeded("s1", token, { session_id: "s1", source_updated_at: 1000, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: 1000 })
    expect(store.claimStage1Jobs([{ id: "s1", updated_at: 1000 }])).toEqual([])
    expect(claimedIds(store.claimStage1Jobs([{ id: "s1", updated_at: 2000 }]))).toEqual(["s1"])
  })

  it("marks succeeded and stores output", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const token = claimOne(store, "s1")
    store.markStage1Succeeded("s1", token, {
      session_id: "s1",
      source_updated_at: 1000,
      raw_memory: "raw",
      rollout_summary: "sum",
      rollout_slug: "slug",
      generated_at: 1000,
    })
    const outs = store.stage1Outputs() as Array<{ session_id: string; usage_count: number }>
    expect(outs.length).toBe(1)
    expect(outs[0].session_id).toBe("s1")
    expect(outs[0].usage_count).toBe(0)
  })

  it("a stale ownership token cannot finalize a re-claimed job or clobber its output", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    const staleToken = claimOne(store, "s1")
    // Lease expires; another worker re-claims the job.
    openDb().prepare("UPDATE memory_jobs SET lease_until = 1 WHERE job_key = 's1'").run()
    const newToken = claimOne(store, "s1")
    expect(newToken).not.toBe(staleToken)
    // Zombie worker finishes late: all finalizers must be no-ops.
    store.markStage1Succeeded("s1", staleToken, { session_id: "s1", source_updated_at: 999, raw_memory: "zombie", rollout_summary: "z", rollout_slug: null, generated_at: 999 })
    expect(store.stage1Outputs().length).toBe(0)
    store.markStage1Failed("s1", staleToken, "zombie boom")
    store.markStage1SucceededNoOutput("s1", staleToken, 999)
    const job = openDb().prepare("SELECT status FROM memory_jobs WHERE job_key='s1'").get() as { status: string }
    expect(job.status).toBe("running")
    // The rightful owner can still finalize.
    store.markStage1Succeeded("s1", newToken, { session_id: "s1", source_updated_at: 1000, raw_memory: "real", rollout_summary: "r", rollout_slug: null, generated_at: 1000 })
    const outs = store.stage1Outputs() as Array<{ raw_memory: string }>
    expect(outs[0].raw_memory).toBe("real")
  })

  it("upsert keeps a strictly newer output but refreshes an equal watermark", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const base = { session_id: "s1", rollout_slug: null, rollout_summary: "s" }
    expect(store.upsertStage1Output({ ...base, source_updated_at: 2000, raw_memory: "v2", generated_at: 2000 })).toBe(true)
    // Older watermark loses.
    expect(store.upsertStage1Output({ ...base, source_updated_at: 1000, raw_memory: "v1", generated_at: 1000 })).toBe(false)
    // Equal watermark replaces (codex uses >=): re-extraction refreshes content.
    expect(store.upsertStage1Output({ ...base, source_updated_at: 2000, raw_memory: "v2b", generated_at: 2001 })).toBe(true)
    const outs = store.stage1Outputs() as Array<{ raw_memory: string }>
    expect(outs[0].raw_memory).toBe("v2b")
  })

  it("records usage and increments counters", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const claims = store.claimStage1Jobs(sessions("s1", "s2"))
    for (const c of claims) {
      store.markStage1Succeeded(c.sessionId, c.ownershipToken, { session_id: c.sessionId, source_updated_at: 1, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: 1 })
    }
    store.recordUsage(["s1", "s1", "s2"])
    const outs = store.stage1Outputs() as Array<{ session_id: string; usage_count: number }>
    expect(outs.find((o) => o.session_id === "s1")!.usage_count).toBe(2)
    expect(outs.find((o) => o.session_id === "s2")!.usage_count).toBe(1)
  })

  it("marks failed, decrements retry_remaining, and clears the lease", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const token = claimOne(store, "s1")
    store.markStage1Failed("s1", token, "boom")
    const { openDb } = require("../src/db.js")
    const db = openDb()
    const job = db.prepare("SELECT status, retry_remaining, lease_until FROM memory_jobs WHERE kind='memory_stage1' AND job_key='s1'").get()
    expect(job.status).toBe("pending")
    expect(job.retry_remaining).toBeLessThan(3)
    expect(job.lease_until).toBeNull()
  })

  it("blocks retry during backoff but lets newer session activity reset exhausted retries", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    // A fresh failure sits in retry backoff: the same watermark cannot reclaim.
    let token = claimOne(store, "s1")
    store.markStage1Failed("s1", token, "boom 0")
    expect(store.claimStage1Jobs([{ id: "s1", updated_at: 1000 }])).toEqual([])
    // Exhaust the remaining retries (simulate elapsed backoff between attempts).
    for (let i = 1; i < 3; i++) {
      openDb().prepare("UPDATE memory_jobs SET retry_at = 1 WHERE job_key='s1'").run()
      token = claimOne(store, "s1")
      store.markStage1Failed("s1", token, `boom ${i}`)
    }
    // Retries exhausted: even with backoff elapsed, the same watermark cannot claim.
    openDb().prepare("UPDATE memory_jobs SET retry_at = 1 WHERE job_key='s1'").run()
    expect(store.claimStage1Jobs([{ id: "s1", updated_at: 1000 }])).toEqual([])
    // Newer session activity overrides backoff and resets retries.
    expect(claimedIds(store.claimStage1Jobs([{ id: "s1", updated_at: 2000 }]))).toEqual(["s1"])
    const job = openDb().prepare("SELECT retry_remaining FROM memory_jobs WHERE job_key='s1'").get()
    expect(job.retry_remaining).toBe(3)
  })

  it("markStage1SucceededNoOutput finishes the job and drops the output row", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    let token = claimOne(store, "s1")
    store.markStage1Succeeded("s1", token, { session_id: "s1", source_updated_at: 500, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: 500 })
    token = claimOne(store, "s1")
    store.markStage1SucceededNoOutput("s1", token, 1000)
    expect(store.stage1Outputs().length).toBe(0)
    expect(store.claimStage1Jobs([{ id: "s1", updated_at: 1000 }])).toEqual([])
  })
})

describe("MemoryStore phase2", () => {
  it("claims the singleton global job once", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const a = store.claimGlobalPhase2Job()
    const b = store.claimGlobalPhase2Job()
    expect(a.type).toBe("claimed")
    expect(b.type).toBe("skipped_running")
  })

  it("respects cooldown after success", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") throw new Error("expected claimed")
    store.markPhase2Succeeded(claim.ownershipToken)
    const again = store.claimGlobalPhase2Job()
    expect(again.type).toBe("skipped_cooldown")
  })

  it("failure enters retry backoff but never exhausts (codex phase-2 semantics)", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    // Fail more times than retry_remaining would allow: with backoff elapsed,
    // the job must always be claimable again — codex never exhausts phase 2.
    for (let i = 0; i < 5; i++) {
      const claim = store.claimGlobalPhase2Job()
      expect(claim.type).toBe("claimed")
      if (claim.type !== "claimed") throw new Error("expected claimed")
      store.markPhase2Failed(claim.ownershipToken, `boom ${i}`)
      // Fresh failure: retry backoff blocks an immediate reclaim.
      expect(store.claimGlobalPhase2Job().type).toBe("skipped_retry_unavailable")
      openDb().prepare("UPDATE memory_jobs SET retry_at = 1 WHERE kind='memory_consolidate_global'").run()
    }
  })

  it("a failed run does not trigger the success cooldown", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") throw new Error("expected claimed")
    store.markPhase2Failed(claim.ownershipToken, "boom")
    openDb().prepare("UPDATE memory_jobs SET retry_at = NULL WHERE kind='memory_consolidate_global'").run()
    // Backoff cleared: claimable immediately, no 6h cooldown for failures.
    expect(store.claimGlobalPhase2Job().type).toBe("claimed")
  })

  it("heartbeat refreshes lease and rejects non-owners", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") throw new Error("expected claimed")
    expect(store.heartbeatPhase2Job(claim.ownershipToken)).toBe(true)
    expect(store.heartbeatPhase2Job("wrong-token")).toBe(false)
  })

  it("stale phase-2 owner cannot mark success after losing the lease", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    const stale = store.claimGlobalPhase2Job()
    if (stale.type !== "claimed") throw new Error("expected claimed")
    openDb().prepare("UPDATE memory_jobs SET lease_until = 1 WHERE kind='memory_consolidate_global'").run()
    const fresh = store.claimGlobalPhase2Job()
    expect(fresh.type).toBe("claimed")
    store.markPhase2Succeeded(stale.ownershipToken)
    const job = openDb().prepare("SELECT status FROM memory_jobs WHERE kind='memory_consolidate_global'").get() as { status: string }
    expect(job.status).toBe("running")
  })
})

describe("MemoryStore phase2 input selection", () => {
  const DAY = 24 * 60 * 60 * 1000

  function seed(store: any, id: string, sourceUpdatedAt: number) {
    const claims = store.claimStage1Jobs([{ id, updated_at: sourceUpdatedAt }])
    store.markStage1Succeeded(id, claims[0].ownershipToken, { session_id: id, source_updated_at: sourceUpdatedAt, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: sourceUpdatedAt })
  }

  it("keeps old memories that are still in use and drops old unused ones", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    const now = Date.now()
    seed(store, "fresh", now - 1 * DAY)
    seed(store, "old-used", now - 60 * DAY)
    seed(store, "old-unused", now - 60 * DAY)
    openDb().prepare("UPDATE memory_stage1_outputs SET last_usage = ? WHERE session_id = 'old-used'").run(now - 1 * DAY)
    const selected = store.getPhase2InputSelection(50, 30).map((o: any) => o.session_id)
    expect(selected).toContain("fresh")
    expect(selected).toContain("old-used")
    expect(selected).not.toContain("old-unused")
  })

  it("excludes disabled and polluted sessions so their files get forgotten", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const now = Date.now()
    seed(store, "ok", now - 1 * DAY)
    seed(store, "bad", now - 1 * DAY)
    seed(store, "off", now - 1 * DAY)
    store.markPolluted("bad")
    store.setMemoryMode("off", "disabled")
    const selected = store.getPhase2InputSelection(50, 30).map((o: any) => o.session_id)
    expect(selected).toEqual(["ok"])
  })

  it("markPhase2Succeeded records the consumed snapshots and pruning spares them", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    const now = Date.now()
    const old = now - 60 * DAY
    seed(store, "kept", old)
    seed(store, "dropped", old)
    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") throw new Error("expected claimed")
    store.markPhase2Succeeded(claim.ownershipToken, [{ session_id: "kept", source_updated_at: old }])
    // Completion watermark = max consumed source_updated_at (codex semantics).
    const job = openDb().prepare("SELECT last_success_watermark FROM memory_jobs WHERE kind='memory_consolidate_global'").get() as { last_success_watermark: number }
    expect(job.last_success_watermark).toBe(old)
    expect(store.pruneStage1Outputs(30)).toBe(1)
    expect(store.stage1Outputs().map((o: any) => o.session_id)).toEqual(["kept"])
  })

  it("pruneStage1Outputs deletes only old unused rows", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    const now = Date.now()
    seed(store, "fresh", now - 1 * DAY)
    seed(store, "old-used", now - 60 * DAY)
    seed(store, "old-unused", now - 60 * DAY)
    openDb().prepare("UPDATE memory_stage1_outputs SET last_usage = ? WHERE session_id = 'old-used'").run(now - 1 * DAY)
    const deleted = store.pruneStage1Outputs(30)
    expect(deleted).toBe(1)
    const remaining = store.stage1Outputs().map((o: any) => o.session_id)
    expect(remaining.sort()).toEqual(["fresh", "old-used"])
  })
})

describe("MemoryStore session meta", () => {
  it("sets and reads memory mode", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    expect(store.getMemoryMode("s1")).toBeNull()
    store.setMemoryMode("s1", "disabled")
    expect(store.getMemoryMode("s1")).toBe("disabled")
    store.markPolluted("s1")
    expect(store.isPolluted("s1")).toBe(true)
    expect(store.getMemoryMode("s1")).toBe("polluted")
  })

  it("stampMemoryModeIfAbsent never overrides an existing mode", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    store.stampMemoryModeIfAbsent("s1", "disabled")
    expect(store.getMemoryMode("s1")).toBe("disabled")
    store.stampMemoryModeIfAbsent("s1", "enabled")
    expect(store.getMemoryMode("s1")).toBe("disabled")
    store.markPolluted("s2")
    store.stampMemoryModeIfAbsent("s2", "disabled")
    expect(store.getMemoryMode("s2")).toBe("polluted")
  })

  it("clearMemoryData wipes outputs and jobs but preserves session modes", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const claims = store.claimStage1Jobs(sessions("s1"))
    store.markStage1Succeeded("s1", claims[0].ownershipToken, { session_id: "s1", source_updated_at: 1, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: 1 })
    store.setMemoryMode("s2", "disabled")
    store.clearMemoryData()
    expect(store.stage1Outputs().length).toBe(0)
    // codex clear_memory_data preserves memory modes: disabled stays disabled.
    expect(store.getMemoryMode("s2")).toBe("disabled")
  })
})
