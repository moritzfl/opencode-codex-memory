import { MemoryStore, PHASE2_COOLDOWN_MS } from "./store.js"
import { ensureLayout, rebuildRawMemories, writeRolloutSummaries, pruneExtensionResources, writeWorkspaceDiff } from "./workspace.js"
import { ensureBaseline, captureWorkspaceDiff, resetBaseline } from "./git-baseline.js"
import { consolidateViaSubagent } from "./llm.js"
import { invalidateCache } from "./source.js"
import { memoryRoot } from "./paths.js"
import path from "path"
import { checkRateLimit } from "./ratelimit.js"

export interface Phase2Options {
  maxRaw: number
  maxUnusedDays: number
  extensionRetentionDays: number
}

export const DEFAULT_PHASE2_OPTIONS: Phase2Options = {
  maxRaw: 20,
  maxUnusedDays: 30,
  extensionRetentionDays: 7,
}

let phase2InFlight = false

export async function runPhase2(store: MemoryStore, opts: Phase2Options = DEFAULT_PHASE2_OPTIONS): Promise<{ status: string }> {
  if (phase2InFlight) return { status: "already_running" }
  phase2InFlight = true
  try {
    const rl = await checkRateLimit("phase2")
    if (!rl.ok) return { status: "skipped_rate_limit" }

    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") return { status: claim.type }

    try {
      ensureLayout()
      store.pruneStage1Outputs(opts.maxUnusedDays)
      const outputs = store.getPhase2InputSelection(opts.maxRaw, opts.maxUnusedDays)
      rebuildRawMemories(outputs)
      writeRolloutSummaries(outputs)
      pruneExtensionResources(opts.extensionRetentionDays)

      if (!await ensureBaseline()) {
        store.markPhase2Failed(claim.ownershipToken, "git baseline failed")
        return { status: "baseline_failed" }
      }

      const diff = await captureWorkspaceDiff()
      if (!diff.trim()) {
        store.markPhase2Succeeded(claim.ownershipToken)
        return { status: "no_workspace_changes" }
      }
      if (diff.length > 4 * 1024 * 1024) {
        store.markPhase2Failed(claim.ownershipToken, "workspace diff too large")
        return { status: "diff_too_large" }
      }

      const diffPath = writeWorkspaceDiff(diff)
      const relDiffPath = path.relative(memoryRoot(), diffPath)

      let heartbeatLost = false
      const heartbeat = setInterval(() => {
        if (!store.heartbeatPhase2Job(claim.ownershipToken)) {
          heartbeatLost = true
        }
      }, 90_000)

      try {
        await consolidateViaSubagent(relDiffPath, memoryRoot())
      } finally {
        clearInterval(heartbeat)
      }

      if (heartbeatLost) {
        store.markPhase2Failed(claim.ownershipToken, "heartbeat lost")
        return { status: "heartbeat_lost" }
      }

      if (!await resetBaseline()) {
        store.markPhase2Failed(claim.ownershipToken, "baseline reset failed")
        return { status: "baseline_reset_failed" }
      }

      store.markPhase2Succeeded(claim.ownershipToken)
      invalidateCache()
      return { status: "succeeded" }
    } catch (err) {
      store.markPhase2Failed(claim.ownershipToken, (err as Error).message)
      return { status: "failed" }
    }
  } finally {
    phase2InFlight = false
  }
}

export const PHASE2_COOLDOWN = PHASE2_COOLDOWN_MS