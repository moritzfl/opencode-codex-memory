import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { applyPluginOptions, handleSessionDeleted } from "../src/index.js"
import { pluginOptions, type MemoryVersion } from "../src/options.js"
import { MemoryStore, clearAllVersionMemoryData } from "../src/store.js"
import { closeDb, openDb } from "../src/db.js"
import { currentMemoryVersion, withMemoryVersion, writeMemoryVersions } from "../src/memory-version.js"
import { sessionMemoryVersion, withSessionMemoryVersion } from "../src/session-version.js"
import { memoryRoot } from "../src/paths.js"
import { runMemoryPipeline } from "../src/pipeline.js"
import { readMigrationStatus } from "../src/migration.js"
import { buildMemorySystemPrompt, invalidateCache } from "../src/source.js"
import { setPluginInput } from "../src/llm.js"
import { resetDiscoveryCacheForTest } from "../src/capture.js"
import { resetRateLimitForTest } from "../src/ratelimit.js"
import { beginPhase2AbortScope, abortPhase2Consolidation, beginPluginShutdown, resetPluginLifecycle } from "../src/lifecycle.js"
import { memory_read, memory_add_note } from "../tools/memory.js"
import { memory_reset, memory_inspect } from "../tools/control.js"
import { overlayV2CitationInstructions } from "../src/v2/citation-overlay.js"

let root: string
const SUMMARY = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
const ctx = (id: string) => ({ sessionID: id, messageID: "msg_test", agent: "build", ask: async () => {} }) as any
const text = (result: Awaited<ReturnType<typeof memory_read.execute>>) => typeof result === "string" ? result : result.output
const store = (version: MemoryVersion) => withMemoryVersion(version, () => new MemoryStore())

beforeEach(() => {
  closeDb()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-dual-"))
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = root
  applyPluginOptions({ version: "v1", dual_write: true })
  resetPluginLifecycle()
  resetDiscoveryCacheForTest()
  resetRateLimitForTest()
  invalidateCache()
})

afterEach(() => {
  closeDb()
  resetPluginLifecycle()
  resetRateLimitForTest()
  resetDiscoveryCacheForTest()
  setPluginInput({ client: undefined } as any)
  applyPluginOptions({})
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(root, { recursive: true, force: true })
})

function seed(target: MemoryStore, id: string) {
  const output = {
    session_id: id, source_updated_at: Date.now(), raw_memory: target.version === "v1" ? "Keep warehouse identifiers as strings" : "",
    rollout_summary: "The user requires leading zeroes in warehouse identifiers.", rollout_slug: id, generated_at: Date.now(),
  }
  target.upsertStage1Output(output)
  return output
}

function summary(version: MemoryVersion, suffix = version) {
  fs.mkdirSync(memoryRoot(version), { recursive: true })
  fs.writeFileSync(path.join(memoryRoot(version), "memory_summary.md"), SUMMARY + suffix)
}

describe("Codex memory migration", () => {
  it("a broken V2 database does not reject the V1 writer or strand its guard", async () => {
    fs.mkdirSync(path.join(root, "memory_v2.db"))
    const result = await runMemoryPipeline("ses_current")
    expect(result[1]).toBe("failed")
    expect(result[0]).not.toBe("already_running")
    expect(store("v1").phase2JobSnapshot()).not.toBeNull()
    expect((await runMemoryPipeline("ses_current"))[0]).not.toBe("already_running")
  })

  it("runs both complete pipelines concurrently with independent contracts and artifacts", async () => {
    let extractions = 0
    let consolidations = 0
    let releaseExtract!: () => void
    let releaseConsolidate!: () => void
    const extracting = new Promise<void>((r) => { releaseExtract = r })
    const consolidating = new Promise<void>((r) => { releaseConsolidate = r })
    let helper = 0
    const seen = new Set<string>()
    setPluginInput({ client: {
      _client: { get: async () => ({ data: [{ id: "ses_work", directory: "/project", time: { updated: Date.now() - 7 * 3600_000 } }] }) },
      config: { get: async () => ({ data: {} }) },
      session: {
        create: async ({ body }: any) => {
          if (body.title === "codex-memory-consolidate") {
            expect(body.permission).toEqual([
              { permission: "external_directory", pattern: "*", action: "deny" },
              { permission: "external_directory", pattern: path.join(memoryRoot(), "*"), action: "allow" },
            ])
          }
          return { data: { id: `ses_helper_${++helper}` } }
        },
        get: async ({ path: p }: any) => p.id === "ses_work" ? { data: { id: p.id } } : { response: { status: 404 } },
        messages: async () => ({ data: [{ info: { role: "user" }, parts: [{ type: "text", text: "Always preserve warehouse identifier 000742 as a string." }] }] }),
        delete: async () => ({ data: {} }),
        prompt: async ({ body }: any) => {
          const version = currentMemoryVersion()
          if (body.agent === "memorize-extract") {
            if (++extractions === 2) releaseExtract()
            await extracting
            expect(currentMemoryVersion()).toBe(version)
            expect(body.format.schema.required.includes("raw_memory")).toBe(version === "v1")
            seen.add(`extract-${version}`)
            return { data: { info: { structured: {
              ...(version === "v1" ? { raw_memory: "Keep warehouse identifiers as strings, never infer numbers." } : {}),
              rollout_summary: "Warehouse identifiers must preserve leading zeroes such as 000742.", rollout_slug: "warehouse",
            } }, parts: [] } }
          }
          if (++consolidations === 2) releaseConsolidate()
          await consolidating
          expect(currentMemoryVersion()).toBe(version)
          seen.add(`consolidate-${version}`)
          summary(version)
          return { data: { info: {}, parts: [{ type: "text", text: "done" }] } }
        },
      },
    } } as any)
    const result = await runMemoryPipeline("ses_current")
    expect(result).toEqual(["succeeded", "succeeded"])
    expect([...seen].sort()).toEqual(["consolidate-v1", "consolidate-v2", "extract-v1", "extract-v2"])
    expect(pluginOptions.version).toBe("v1")
    expect(store("v1").stage1Outputs()[0].raw_memory).not.toBe("")
    expect(store("v2").stage1Outputs()[0].raw_memory).toBe("")
    expect(store("v1").maxConsolidatedThreadCount()).toBe(1)
    expect(readMigrationStatus(1).v2Ready).toBe(true)
    expect(readMigrationStatus().v2Ready).toBe(false)
    expect(fs.existsSync(path.join(memoryRoot("v1"), "MEMORY.md"))).toBe(true)
    expect(fs.existsSync(path.join(memoryRoot("v2"), "MEMORY.md"))).toBe(false)
    expect(fs.existsSync(path.join(memoryRoot("v2"), "raw_memories.md"))).toBe(false)
  }, 15_000)

  it("pins read tools, explicit notes and citation counters through cutover and reload", async () => {
    for (const version of ["v1", "v2"] as const) {
      seed(store(version), "ses_source")
      summary(version)
      fs.writeFileSync(path.join(memoryRoot(version), "route.md"), version)
    }
    expect(sessionMemoryVersion("ses_old")).toBe("v1")
    applyPluginOptions({ version: "v2", dual_write: true })
    closeDb()
    expect(text(await memory_read.execute({ path: "route.md" }, ctx("ses_old")))).toBe("v1")
    expect(text(await memory_read.execute({ path: "route.md" }, ctx("ses_new")))).toBe("v2")
    await memory_add_note.execute({ note: "Keep leading zeroes" }, ctx("ses_old"))
    expect(fs.readdirSync(path.join(memoryRoot("v1"), "extensions/ad_hoc/notes")).length).toBe(1)
    expect(fs.existsSync(path.join(memoryRoot("v2"), "extensions/ad_hoc/notes"))).toBe(false)
    withSessionMemoryVersion("ses_old", () => new MemoryStore().recordUsageOnce("ses_old", "msg_cite", ["ses_source"]))
    expect(store("v1").stage1Outputs()[0].usage_count).toBe(1)
    expect(store("v2").stage1Outputs()[0].usage_count).toBe(0)
    applyPluginOptions({ version: "v1" })
    expect(sessionMemoryVersion("ses_new")).toBe("v2")
    expect(sessionMemoryVersion("ses_rollback")).toBe("v1")
  })

  it("shares exclusion metadata before ranking limits, even in the shadow store", () => {
    const v1 = store("v1"), v2 = store("v2")
    seed(v2, "ses_blocked")
    seed(v2, "ses_allowed")
    v2.recordUsage(["ses_blocked"])
    v1.setMemoryMode("ses_blocked", "disabled")
    expect(v2.getPhase2InputSelection(1, 30).map((r) => r.session_id)).toEqual(["ses_allowed"])
    v1.markPolluted("ses_allowed")
    expect(v2.getPhase2InputSelection(1, 30)).toEqual([])
  })

  it("readiness requires successful owned consolidation, survives pruning, and resets", async () => {
    const v2 = store("v2")
    const selected = Array.from({ length: 20 }, (_, i) => seed(v2, `ses_${i}`))
    summary("v2")
    expect(readMigrationStatus().v2Ready).toBe(false)
    const claim = v2.claimGlobalPhase2Job()
    if (claim.type !== "claimed") throw new Error(claim.type)
    v2.markPhase2Succeeded("stale-token", selected)
    expect(readMigrationStatus().v2Ready).toBe(false)
    v2.markPhase2Succeeded(claim.ownershipToken, selected)
    expect(readMigrationStatus().v2Ready).toBe(true)
    for (const row of selected) v2.deleteSessionMemory(row.session_id)
    expect(v2.maxConsolidatedThreadCount()).toBe(20)
    fs.writeFileSync(path.join(memoryRoot("v2"), "memory_summary.md"), "invalid")
    expect(readMigrationStatus().v2Ready).toBe(false)
    v2.setMemoryMode("ses_disabled", "disabled")
    clearAllVersionMemoryData()
    expect(v2.maxConsolidatedThreadCount()).toBe(0)
    expect(v2.getMemoryMode("ses_disabled")).toBe("disabled")
    expect(() => readMigrationStatus(0)).toThrow("between 1 and 4096")
    expect(() => readMigrationStatus(4097)).toThrow("between 1 and 4096")
  })

  it("deletes and resets both namespaces even when only V1 is configured", async () => {
    for (const version of ["v1", "v2"] as const) {
      const target = store(version)
      const output = seed(target, "ses_deleted")
      const claim = target.claimGlobalPhase2Job()
      if (claim.type !== "claimed") throw new Error(claim.type)
      target.markPhase2Succeeded(claim.ownershipToken, [output])
      summary(version)
    }
    applyPluginOptions({ version: "v1", dual_write: false })
    let scheduled = 0
    handleSessionDeleted("ses_deleted", undefined, () => { scheduled++ })
    expect(scheduled).toBe(1)
    expect(store("v1").stage1Outputs()).toEqual([])
    expect(store("v2").stage1Outputs()).toEqual([])
    expect(text(await memory_reset.execute({ confirm: true }, ctx("ses_reset")))).toContain("complete")
    for (const version of ["v1", "v2"] as const) {
      expect(fs.readdirSync(memoryRoot(version))).toEqual([])
      expect(store(version).maxConsolidatedThreadCount()).toBe(0)
    }
  })

  it("isolates abort scopes and equal-mtime read caches across versions", () => {
    const first = withMemoryVersion("v1", beginPhase2AbortScope)
    const second = withMemoryVersion("v2", beginPhase2AbortScope)
    expect(first.aborted).toBe(false)
    withMemoryVersion("v1", abortPhase2Consolidation)
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    beginPluginShutdown()
    expect(second.aborted).toBe(true)
    const stamp = new Date(1000)
    for (const version of ["v1", "v2"] as const) {
      summary(version)
      fs.utimesSync(path.join(memoryRoot(version), "memory_summary.md"), stamp, stamp)
    }
    const v1 = withMemoryVersion("v1", () => buildMemorySystemPrompt(true))!
    const v2 = withMemoryVersion("v2", () => buildMemorySystemPrompt(true))!
    expect(v1).toContain("MEMORY.md")
    expect(v2).not.toContain("MEMORY.md")
    expect(v2).toContain("memories_v2")
    const overlaid = overlayV2CitationInstructions(v2, "v2")
    expect(overlaid).not.toContain("<memory-citation>")
    expect(overlaid).toContain("blank line")
    expect(overlaid).not.toContain("MEMORY.md")
  })

  it("inspect reports both pipelines without claiming jobs or freezing sessions", async () => {
    seed(store("v2"), "ses_source")
    const before = openDb("v2").prepare("SELECT * FROM memory_jobs").all()
    const result = await memory_inspect.execute({}, ctx("ses_inspect"))
    expect(text(result)).toContain("dual_write: true")
    expect(text(result)).toContain("pipeline_v2: outputs=1")
    expect(text(result)).toContain("v2_ready: false")
    expect(openDb("v2").prepare("SELECT * FROM memory_jobs").all()).toEqual(before)
    expect(openDb("v1").prepare("SELECT * FROM memory_session_versions").all()).toEqual([])
    applyPluginOptions({ version: "v2", dual_write: true })
    expect(writeMemoryVersions()).toEqual(["v1", "v2"])
    applyPluginOptions({ version: "v2" })
    expect(writeMemoryVersions()).toEqual(["v2"])
  })
})
