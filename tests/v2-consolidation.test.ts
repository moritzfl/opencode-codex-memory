import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { closeDb } from "../src/db.js"
import { ensureBaseline, captureWorkspaceDiff } from "../src/git-baseline.js"
import { resetPluginLifecycle } from "../src/lifecycle.js"
import { setPluginInput } from "../src/llm.js"
import { withMemoryVersion } from "../src/memory-version.js"
import { resetPluginOptions } from "../src/options.js"
import { memoryRoot } from "../src/paths.js"
import { runPhase2 } from "../src/phase2.js"
import { isProviderCapacityBlocked, resetRateLimitForTest } from "../src/ratelimit.js"
import { MemoryStore } from "../src/store.js"
import { ensureLayout } from "../src/workspace.js"
import { buildV1ClientShim, resetV2ShimStateForTest, setV2Context } from "../src/v2/shim.js"
import { setV2ServiceDependenciesForTest } from "../src/v2/service.js"

let root: string
beforeEach(() => {
  closeDb()
  resetPluginOptions()
  resetPluginLifecycle()
  resetRateLimitForTest()
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ocm-v2-consolidation-"))
  process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT = root
  setV2ServiceDependenciesForTest({ service: { discover: async () => undefined, headers: () => undefined }, make: () => ({ session: {} }) })
})
afterEach(() => {
  closeDb()
  resetRateLimitForTest()
  setPluginInput({ client: undefined } as any)
  setV2Context(null)
  resetV2ShimStateForTest()
  setV2ServiceDependenciesForTest(null)
  delete process.env.OPENCODE_CODEX_MEMORY_TEST_ROOT
  fs.rmSync(root, { recursive: true, force: true })
})

describe("V2 host consolidation outcome", () => {
  for (const version of ["v1", "v2"] as const) {
    it(`${version} preserves pending notes and retries after a failed host turn`, async () => withMemoryVersion(version, async () => {
      const calls: string[] = []
      setV2Context({ session: {
        create: async () => ({ id: "ses_helper" }),
        switchAgent: async () => {},
        prompt: async () => ({ id: "msg_prompt" }),
        wait: async () => { calls.push("wait") },
        interrupt: async () => { calls.push("interrupt") },
        context: async () => [
          { id: "msg_prompt", type: "user", text: "consolidate" },
          { id: "msg_reply", type: "assistant", time: { completed: 2 }, finish: "error", error: { type: "provider.rate-limit", message: "capacity", status: 429 } },
          { type: "idle", outcome: "failed" },
        ],
      } } as any)
      setPluginInput({ client: buildV1ClientShim() } as any)
      ensureLayout()
      const summary = "v1\n\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n"
      fs.writeFileSync(path.join(memoryRoot(), "memory_summary.md"), summary)
      expect(await ensureBaseline()).toBe(true)
      const note = "extensions/ad_hoc/notes/pending.md"
      fs.writeFileSync(path.join(memoryRoot(), note), "Remember the new deployment command.")
      const store = new MemoryStore()
      expect(await runPhase2(store)).toEqual({ status: "failed" })
      expect(store.phase2JobSnapshot()).toMatchObject({ status: "failed", last_success_watermark: null })
      expect(store.phase2JobSnapshot()?.last_error).toContain("HTTP 429")
      expect(isProviderCapacityBlocked("phase2")).toBe(true)
      expect((await captureWorkspaceDiff()).changes.some((change) => change.path === note)).toBe(true)
      expect(fs.readFileSync(path.join(memoryRoot(), "memory_summary.md"), "utf8")).toBe(summary)
      expect(calls).toContain("interrupt")
    }))
  }
})
