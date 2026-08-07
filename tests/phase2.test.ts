import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { closeDb, openDb } from "../src/db.js"
import { captureWorkspaceDiff } from "../src/git-baseline.js"
import { setPluginInput } from "../src/llm.js"
import { DEFAULT_PHASE2_OPTIONS, runPhase2 } from "../src/phase2.js"
import { MemoryStore } from "../src/store.js"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-phase2-${process.pid}-${Date.now()}`)

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
})
