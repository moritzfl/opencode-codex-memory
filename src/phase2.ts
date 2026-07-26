import { MemoryStore } from "./store.js"
import {
  ensureLayout,
  rebuildRawMemories,
  writeRolloutSummaries,
  pruneExtensionResources,
  writeWorkspaceDiff,
  validateConsolidationArtifacts,
} from "./workspace.js"
import { ensureBaseline, captureWorkspaceDiff, resetBaseline, DIFF_ARTIFACT } from "./git-baseline.js"
import { consolidateViaSubagent } from "./llm.js"
import { invalidateCache } from "./source.js"
import { memoryRoot } from "./paths.js"
import { checkRateLimit } from "./ratelimit.js"
import { resolveCodexInterop, syncCodexImport, exportToCodexMemory, type CodexInteropOptions } from "./codex-interop.js"

export interface Phase2Options {
  maxRaw: number
  maxUnusedDays: number
  extensionRetentionDays: number
  consolidationModel?: string
  codexInterop?: CodexInteropOptions
}

export const DEFAULT_PHASE2_OPTIONS: Phase2Options = {
  maxRaw: 256,
  maxUnusedDays: 30,
  extensionRetentionDays: 7,
}

// Export runs only after a successful phase 2 (fresh, validated artifacts) and
// must never fail the run — Codex's workspace is best-effort foreign territory.
function maybeExportToCodex(interop: ReturnType<typeof resolveCodexInterop>): void {
  if (!interop?.exportEnabled) return
  try {
    exportToCodexMemory(interop.codexMemoryRoot)
  } catch (err) {
    console.warn("[opencode-codex-memory] codex export failed:", err)
  }
}

let phase2InFlight = false

/** True while THIS process runs a consolidation (memory_reset refuses then). */
export function isPhase2InFlight(): boolean {
  return phase2InFlight
}

export async function runPhase2(
  store: MemoryStore,
  opts: Phase2Options = DEFAULT_PHASE2_OPTIONS,
  rateLimitCheck: typeof checkRateLimit = checkRateLimit,
): Promise<{ status: string }> {
  if (phase2InFlight) return { status: "already_running" }
  phase2InFlight = true
  try {
    const rl = await rateLimitCheck("phase2")
    if (!rl.ok) return { status: "skipped_rate_limit" }

    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") return { status: claim.type }

    try {
      // Resolved once per claimed job (not per attempt): resolution warns on
      // misconfiguration, and warning on every skipped attempt would be noise.
      // Keep this inside the claimed-job try so resolution failures release
      // the lease instead of leaving the row running until it expires.
      const interop = opts.codexInterop ? resolveCodexInterop(opts.codexInterop) : null
      ensureLayout()

      // Preserves an existing baseline (only initializes a missing one): the
      // diff below must span last-successful-run -> now so user edits and
      // ad-hoc notes added since then reach consolidation. Stale stage-1
      // output pruning happens in phase 1, before the rate gate (codex
      // start.rs ordering).
      if (!await ensureBaseline()) {
        store.markPhase2Failed(claim.ownershipToken, "git baseline failed")
        return { status: "baseline_failed" }
      }

      const outputs = store.getPhase2InputSelection(opts.maxRaw, opts.maxUnusedDays)
      rebuildRawMemories(outputs)
      writeRolloutSummaries(outputs)
      pruneExtensionResources(opts.extensionRetentionDays)

      // Codex-interop import: inside the claimed job (workspace mutations are
      // lease-protected — pre-claim writes could race a running consolidator),
      // after the baseline (copies must show up as diff, not be swallowed by a
      // first-run baseline init; codex memory_import.rs orders prepare-then-
      // copy the same way), before the diff capture so imported changes are
      // consolidated in this very run. No explicit enqueue needed: the claim
      // is time-gated, and the copies stay in the workspace diff until a
      // consolidation succeeds. Never fails the run.
      if (interop?.importEnabled) {
        try {
          syncCodexImport(interop.codexMemoryRoot)
        } catch (err) {
          console.warn("[opencode-codex-memory] codex import sync failed:", err)
        }
      }

      const diff = await captureWorkspaceDiff()
      // codex: early succeed only when there are no changes AND artifacts are
      // already valid. Invalid/empty summary (e.g. ensureLayout's empty file)
      // falls through so the consolidator can INIT/repair.
      if (diff.changes.length === 0) {
        const valid = validateConsolidationArtifacts()
        if (valid.ok) {
          store.markPhase2Succeeded(claim.ownershipToken, outputs)
          maybeExportToCodex(interop)
          return { status: "no_workspace_changes" }
        }
        console.warn("[opencode-codex-memory] no workspace changes but artifacts invalid; running consolidator:", valid.reason)
      }

      writeWorkspaceDiff(diff)

      let heartbeatLost = false
      const heartbeat = setInterval(() => {
        try {
          if (!store.heartbeatPhase2Job(claim.ownershipToken)) {
            heartbeatLost = true
          }
        } catch (err) {
          // Transient DB error (e.g. SQLITE_BUSY): don't treat as ownership
          // loss — the token+status-guarded final confirmation below stays
          // authoritative. Uncaught, this would kill the interval silently.
          console.warn("[opencode-codex-memory] phase2 heartbeat error:", err)
        }
      }, 90_000)

      try {
        await consolidateViaSubagent(memoryRoot(), DIFF_ARTIFACT, opts.consolidationModel)
      } finally {
        clearInterval(heartbeat)
      }

      // Final synchronous ownership confirmation before the destructive
      // baseline reset (codex phase2.rs does the same): the periodic flag can
      // be up to 90s stale, and a stale worker resetting the baseline would
      // swallow the diff a re-claiming worker is about to consume. The
      // heartbeat is token+status guarded, so it fails once ownership is lost;
      // markPhase2Failed is equally guarded and becomes a no-op then.
      if (heartbeatLost || !store.heartbeatPhase2Job(claim.ownershipToken)) {
        store.markPhase2Failed(claim.ownershipToken, "ownership lost")
        return { status: "heartbeat_lost" }
      }

      // codex failed_invalid_artifacts: do not reset baseline on bad output so
      // the next run still sees a diff / can re-INIT.
      const artifacts = validateConsolidationArtifacts()
      if (!artifacts.ok) {
        store.markPhase2Failed(claim.ownershipToken, `failed_invalid_artifacts: ${artifacts.reason}`)
        return { status: "failed_invalid_artifacts" }
      }

      if (!await resetBaseline()) {
        store.markPhase2Failed(claim.ownershipToken, "baseline reset failed")
        return { status: "baseline_reset_failed" }
      }

      store.markPhase2Succeeded(claim.ownershipToken, outputs)
      invalidateCache()
      maybeExportToCodex(interop)
      return { status: "succeeded" }
    } catch (err) {
      store.markPhase2Failed(claim.ownershipToken, err)
      return { status: "failed" }
    }
  } finally {
    phase2InFlight = false
  }
}
