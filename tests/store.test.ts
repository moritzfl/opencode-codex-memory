import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import path from "path"
import os from "os"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-memex-store-${process.pid}-${Date.now()}`)

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_MEMEX_TEST_ROOT = TEST_ROOT
  const { resetDbForTest } = require("../src/db.js")
  resetDbForTest()
})
afterEach(() => {
  const { resetDbForTest } = require("../src/db.js")
  resetDbForTest()
  delete process.env.OPENCODE_MEMEX_TEST_ROOT
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  } catch {
  }
})

function sessions(...ids: string[]) {
  return ids.map((id) => ({ id, updated_at: 1000 }))
}

describe("MemoryStore stage1", () => {
  it("claims jobs and dedupes by session", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const claimed = store.claimStage1Jobs(sessions("s1", "s2", "s1"))
    expect(claimed).toEqual(["s1", "s2"])
  })

  it("respects the concurrency cap", () => {
    const { MemoryStore, STAGE1_CONCURRENCY } = require("../src/store.js")
    const store = new MemoryStore()
    const many = Array.from({ length: STAGE1_CONCURRENCY + 5 }, (_, i) => ({ id: `s${i}`, updated_at: 1000 }))
    const claimed = store.claimStage1Jobs(many)
    expect(claimed.length).toBe(STAGE1_CONCURRENCY)
  })

  it("reclaims a running job once its lease expires", () => {
    const { MemoryStore } = require("../src/store.js")
    const { openDb } = require("../src/db.js")
    const store = new MemoryStore()
    expect(store.claimStage1Jobs(sessions("s1"))).toEqual(["s1"])
    expect(store.claimStage1Jobs(sessions("s1"))).toEqual([])
    openDb().prepare("UPDATE memory_jobs SET lease_until = 1 WHERE job_key = 's1'").run()
    expect(store.claimStage1Jobs(sessions("s1"))).toEqual(["s1"])
  })

  it("reclaims a done job only when the session has newer activity", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    store.claimStage1Jobs(sessions("s1"))
    store.markStage1Succeeded("s1", { session_id: "s1", source_updated_at: 1000, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: 1000 })
    expect(store.claimStage1Jobs([{ id: "s1", updated_at: 1000 }])).toEqual([])
    expect(store.claimStage1Jobs([{ id: "s1", updated_at: 2000 }])).toEqual(["s1"])
  })

  it("marks succeeded and stores output", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    store.claimStage1Jobs(sessions("s1"))
    store.markStage1Succeeded("s1", {
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

  it("does not overwrite a newer output with an older one", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    store.claimStage1Jobs(sessions("s1"))
    store.markStage1Succeeded("s1", { session_id: "s1", source_updated_at: 2000, raw_memory: "v2", rollout_summary: "s2", rollout_slug: "slug", generated_at: 2000 })
    store.markStage1Succeeded("s1", { session_id: "s1", source_updated_at: 1000, raw_memory: "v1", rollout_summary: "s1", rollout_slug: "slug", generated_at: 1000 })
    const outs = store.stage1Outputs() as Array<{ session_id: string; raw_memory: string }>
    expect(outs[0].raw_memory).toBe("v2")
  })

  it("records usage and increments counters", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    store.claimStage1Jobs(sessions("s1", "s2"))
    store.markStage1Succeeded("s1", { session_id: "s1", source_updated_at: 1, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: 1 })
    store.markStage1Succeeded("s2", { session_id: "s2", source_updated_at: 1, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: 1 })
    store.recordUsage(["s1", "s1", "s2"])
    const outs = store.stage1Outputs() as Array<{ session_id: string; usage_count: number }>
    expect(outs.find((o) => o.session_id === "s1")!.usage_count).toBe(2)
    expect(outs.find((o) => o.session_id === "s2")!.usage_count).toBe(1)
  })

  it("marks failed and decrements retry_remaining", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    store.claimStage1Jobs(sessions("s1"))
    store.markStage1Failed("s1", "boom")
    const { openDb } = require("../src/db.js")
    const db = openDb()
    const job = db.prepare("SELECT status, retry_remaining FROM memory_jobs WHERE kind='memory_stage1' AND job_key='s1'").get()
    expect(job.status).toBe("pending")
    expect(job.retry_remaining).toBeLessThan(3)
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

  it("heartbeat refreshes lease and rejects non-owners", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") throw new Error("expected claimed")
    expect(store.heartbeatPhase2Job(claim.ownershipToken)).toBe(true)
    expect(store.heartbeatPhase2Job("wrong-token")).toBe(false)
  })
})

describe("MemoryStore phase2 input selection", () => {
  const DAY = 24 * 60 * 60 * 1000

  function seed(store: any, id: string, sourceUpdatedAt: number) {
    store.claimStage1Jobs([{ id, updated_at: sourceUpdatedAt }])
    store.markStage1Succeeded(id, { session_id: id, source_updated_at: sourceUpdatedAt, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: sourceUpdatedAt })
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

  it("clearMemoryData wipes tables", () => {
    const { MemoryStore } = require("../src/store.js")
    const store = new MemoryStore()
    store.claimStage1Jobs(sessions("s1"))
    store.markStage1Succeeded("s1", { session_id: "s1", source_updated_at: 1, raw_memory: "r", rollout_summary: "s", rollout_slug: null, generated_at: 1 })
    store.clearMemoryData()
    expect(store.stage1Outputs().length).toBe(0)
  })
})