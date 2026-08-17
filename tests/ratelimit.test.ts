import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { closeDb } from "../src/db.js"
import { setPluginInput } from "../src/llm.js"
import { resetPluginLifecycle } from "../src/lifecycle.js"
import { DEFAULT_PHASE1_OPTIONS, runPhase1 } from "../src/phase1.js"
import {
  activeProviderCapacityBackoffs,
  checkRateLimit,
  isProviderCapacityError,
  markRateLimitUsed,
  noteProviderCapacityExhausted,
  resetRateLimitForTest,
} from "../src/ratelimit.js"
import { MemoryStore } from "../src/store.js"

const TEST_ROOT = path.join(os.tmpdir(), `opencode-codex-memory-ratelimit-${process.pid}-${Date.now()}`)

beforeEach(() => {
  closeDb()
  resetRateLimitForTest()
  resetPluginLifecycle()
  fs.mkdirSync(TEST_ROOT, { recursive: true })
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = TEST_ROOT
})

afterEach(() => {
  closeDb()
  resetRateLimitForTest()
  resetPluginLifecycle()
  setPluginInput({ client: undefined } as any)
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe("rate-limit stub semantics", () => {
  it("checkRateLimit does not stamp — empty rechecks stay allowed", async () => {
    expect((await checkRateLimit("phase1")).ok).toBe(true)
    expect((await checkRateLimit("phase1")).ok).toBe(true)
    expect((await checkRateLimit("phase1")).ok).toBe(true)
  })

  it("stamps only via markRateLimitUsed after claimed work", async () => {
    expect((await checkRateLimit("phase1")).ok).toBe(true)
    markRateLimitUsed("phase1")
    const blocked = await checkRateLimit("phase1")
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain("30s")
  })

  it("phase2 has no process-local gate", async () => {
    markRateLimitUsed("phase1")
    expect((await checkRateLimit("phase2")).ok).toBe(true)
    markRateLimitUsed("phase2") // no-op for phase2
    expect((await checkRateLimit("phase2")).ok).toBe(true)
  })

  it("classifies quota and rate-limit errors, not permanent extraction failures", () => {
    expect(isProviderCapacityError("sub-agent prompt failed (APIError): The usage limit has been reached")).toBe(true)
    expect(isProviderCapacityError({ name: "APIError", data: { message: "Free usage exceeded", statusCode: 429 } })).toBe(true)
    expect(isProviderCapacityError("provider capacity exhausted")).toBe(true)
    expect(isProviderCapacityError("rate_limit_exceeded")).toBe(true)
    expect(isProviderCapacityError("HTTP 429 too many requests")).toBe(true)
    expect(isProviderCapacityError("insufficient_quota")).toBe(true)
    expect(isProviderCapacityError("boom")).toBe(false)
    expect(isProviderCapacityError("empty transcript for previously extracted session")).toBe(false)
    expect(isProviderCapacityError("failed_invalid_artifacts: missing MEMORY.md")).toBe(false)
  })

  it("scopes observed quota by resolved model", async () => {
    noteProviderCapacityExhausted("phase1", "limited/model")
    const extraction = await checkRateLimit("phase1", "limited/model")
    const consolidation = await checkRateLimit("phase2", "limited/model")
    expect(extraction.ok).toBe(false)
    expect(extraction.reason).toContain("model:limited/model")
    expect(consolidation.ok).toBe(false)
    expect((await checkRateLimit("phase1", "healthy/model")).ok).toBe(true)
    expect((await checkRateLimit("phase2", "healthy/model")).ok).toBe(true)
    expect(activeProviderCapacityBackoffs()).toEqual([
      expect.objectContaining({ scope: "model:limited/model" }),
    ])
  })

  it("keeps unresolved default models phase-specific", async () => {
    noteProviderCapacityExhausted("phase1")
    expect((await checkRateLimit("phase1")).ok).toBe(false)
    expect((await checkRateLimit("phase2")).ok).toBe(true)
  })

  it("empty phase1 eligibility does not stamp the process timer", async () => {
    // No sessions returned by discovery → no claims → no stamp.
    setPluginInput({
      client: {
        _client: {
          get: async () => ({ data: [] }),
        },
        session: { messages: async () => ({ data: [] }) },
      },
    } as any)

    await runPhase1(new MemoryStore(), DEFAULT_PHASE1_OPTIONS)
    expect((await checkRateLimit("phase1")).ok).toBe(true)

    // Explicit mark would block; prove empty pass did not mark.
    markRateLimitUsed("phase1")
    expect((await checkRateLimit("phase1")).ok).toBe(false)
  })
})
