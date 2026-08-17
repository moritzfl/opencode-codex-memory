import { MemoryStore } from "./store.js"
import { checkRateLimit, isProviderCapacityError, noteProviderCapacityExhausted } from "./ratelimit.js"
import {
  ensureLayout,
  rebuildRawMemories,
  writeRolloutSummaries,
  pruneExtensionResources,
  writeWorkspaceDiff,
  validateConsolidationArtifacts,
} from "./workspace.js"
import { ensureBaseline, captureWorkspaceDiff, resetBaseline, DIFF_ARTIFACT } from "./git-baseline.js"
import {
  consolidateViaSubagent,
  getPluginInput,
  SubagentCancelledError,
  SubagentShutdownError,
} from "./llm.js"
import { hostSessionLiveness } from "./host-client.js"
import { invalidateCache } from "./source.js"
import { memoryRoot } from "./paths.js"
import {
  abortPhase2Consolidation,
  beginPhase2AbortScope,
  endPhase2AbortScope,
  isPluginShuttingDown,
} from "./lifecycle.js"
import { resolveCodexInterop, syncCodexImport, exportToCodexMemory, type CodexInteropOptions } from "./codex-interop.js"
import { syncClaudeImport, type ClaudeImportOptions } from "./claude-import.js"

export interface Phase2Options {
  maxRaw: number
  maxUnusedDays: number
  extensionRetentionDays: number
  consolidationModel?: string
  codexInterop?: CodexInteropOptions
  claudeImport?: ClaudeImportOptions
  /** Override the 90s heartbeat interval (tests / advanced). */
  heartbeatIntervalMs?: number
}

export const DEFAULT_PHASE2_OPTIONS: Phase2Options = {
  maxRaw: 256,
  maxUnusedDays: 30,
  extensionRetentionDays: 7,
}

// Export runs only after a successful phase 2 (fresh, validated artifacts) and
// must never fail the run — Codex's workspace is best-effort foreign territory.
const PHASE2_LIVE_CHECK_CONCURRENCY = 8

/**
 * Codex get_phase2_input_selection re-validates each row against the live
 * threads table. We only drop a row on a confirmed 404 (same as session.deleted);
 * timeouts / missing get / other errors keep the row.
 */
export async function dropGonePhase2Inputs(
  store: MemoryStore,
  selected: ReturnType<MemoryStore["getPhase2InputSelection"]>,
): Promise<ReturnType<MemoryStore["getPhase2InputSelection"]>> {
  const client = getPluginInput()?.client
  if (!client || selected.length === 0) return selected
  const kept: typeof selected = []
  for (let i = 0; i < selected.length; i += PHASE2_LIVE_CHECK_CONCURRENCY) {
    const chunk = selected.slice(i, i + PHASE2_LIVE_CHECK_CONCURRENCY)
    const results = await Promise.all(
      chunk.map(async (out) => ({ out, live: await hostSessionLiveness(client, out.session_id) })),
    )
    for (const { out, live } of results) {
      if (live === "gone") store.deleteSessionMemory(out.session_id)
      else kept.push(out)
    }
  }
  return kept
}

/**
 * Codex pages ranked candidates until it has `maxRaw` rows whose threads are
 * still live. Our thread metadata lives in the host, so confirmed-gone rows
 * are deleted and the ranking is queried again to backfill their slots.
 */
export async function selectLivePhase2Inputs(
  store: MemoryStore,
  maxRaw: number,
  maxUnusedDays: number,
): Promise<ReturnType<MemoryStore["getPhase2InputSelection"]>> {
  if (maxRaw <= 0) return []
  const selected: ReturnType<MemoryStore["getPhase2InputSelection"]> = []
  const seen = new Set<string>()
  while (selected.length < maxRaw) {
    // Once most slots are filled, inspect one liveness chunk beyond the
    // already-selected rows so a single gone row does not force serial probes.
    const scanLimit = Math.max(maxRaw, selected.length + PHASE2_LIVE_CHECK_CONCURRENCY)
    const candidates = store
      .getPhase2InputSelection(scanLimit, maxUnusedDays)
      .filter((output) => !seen.has(output.session_id))
    if (candidates.length === 0) break
    for (const output of candidates) seen.add(output.session_id)
    const live = await dropGonePhase2Inputs(store, candidates)
    for (const output of live) {
      selected.push(output)
      if (selected.length >= maxRaw) break
    }
  }
  return selected
}

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

/** Release the claim when dispose raced the prep path; return true if released. */
function releaseIfShuttingDown(store: MemoryStore, ownershipToken: string): boolean {
  if (!isPluginShuttingDown()) return false
  store.releasePhase2OnShutdown(ownershipToken)
  return true
}

export async function runPhase2(
  store: MemoryStore,
  opts: Phase2Options = DEFAULT_PHASE2_OPTIONS,
): Promise<{ status: string }> {
  if (isPluginShuttingDown()) return { status: "shutting_down" }
  if (phase2InFlight) return { status: "already_running" }
  phase2InFlight = true
  try {
    // No 30s process gate: codex serializes phase 2 only via the DB claim.
    // An observed quota stamp still skips both phases (Codex start.rs).
    const consolidationModel = opts.consolidationModel
    const rl = await checkRateLimit("phase2", consolidationModel)
    if (!rl.ok) return { status: "skipped_rate_limit" }

    const claim = store.claimGlobalPhase2Job()
    if (claim.type !== "claimed") return { status: claim.type }

    // Abort scope covers prep + consolidator so dispose during baseline/diff
    // sets the flag that releaseIfShuttingDown / consolidator cancel observe.
    const consolidationSignal = beginPhase2AbortScope()
    try {
      if (releaseIfShuttingDown(store, claim.ownershipToken)) {
        return { status: "shutting_down" }
      }

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
      if (releaseIfShuttingDown(store, claim.ownershipToken)) {
        return { status: "shutting_down" }
      }

      const outputs = await selectLivePhase2Inputs(store, opts.maxRaw, opts.maxUnusedDays)
      rebuildRawMemories(outputs)
      writeRolloutSummaries(outputs)
      pruneExtensionResources(opts.extensionRetentionDays)

      // External-agent imports (Codex consolidated memory + Claude project
      // memories): inside the claimed job (workspace mutations are
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
      if (opts.claudeImport?.enabled) {
        try {
          const result = syncClaudeImport(opts.claudeImport)
          for (const f of result.failures) {
            console.warn(`[opencode-codex-memory] claude import: ${f.message}`)
          }
        } catch (err) {
          console.warn("[opencode-codex-memory] claude import sync failed:", err)
        }
      }

      const diff = await captureWorkspaceDiff()
      if (releaseIfShuttingDown(store, claim.ownershipToken)) {
        return { status: "shutting_down" }
      }

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
      let heartbeatFailure: unknown = "ownership lost"
      const heartbeatOnce = (): boolean => {
        if (heartbeatLost) return false
        try {
          if (!store.heartbeatPhase2Job(claim.ownershipToken)) {
            heartbeatLost = true
            abortPhase2Consolidation()
            return false
          }
        } catch (err) {
          console.warn("[opencode-codex-memory] phase2 heartbeat error:", err)
          // Codex stops the consolidation agent on heartbeat Ok(false) OR Err.
          // Fail closed: without a refreshed lease, another process may reclaim
          // the job while this helper still has live write access.
          heartbeatLost = true
          heartbeatFailure = err
          abortPhase2Consolidation()
          return false
        }
        return true
      }

      // Workspace preparation can itself be slow. Confirm ownership before
      // granting a new helper write access, then keep the lease alive while it
      // runs. This also mirrors tokio::time::interval's immediate first tick.
      if (!heartbeatOnce()) {
        store.markPhase2Failed(claim.ownershipToken, heartbeatFailure)
        return { status: "heartbeat_lost" }
      }
      if (releaseIfShuttingDown(store, claim.ownershipToken)) {
        return { status: "shutting_down" }
      }
      const heartbeat = setInterval(heartbeatOnce, opts.heartbeatIntervalMs ?? 90_000)

      try {
        await consolidateViaSubagent(
          memoryRoot(),
          DIFF_ARTIFACT,
          consolidationModel,
          consolidationSignal,
        )
      } catch (err) {
        // codex phase2.rs: when the consolidation agent's shutdown fails, keep
        // the existing lease until it expires so another worker cannot race a
        // consolidator whose shutdown has not completed. Neither succeed nor
        // fail the job — marking it failed would release the lease immediately.
        if (err instanceof SubagentShutdownError) {
          console.warn(`[opencode-codex-memory] ${err.message}; holding the phase2 lease until it expires`)
          return { status: "shutdown_failed" }
        }
        if (heartbeatLost) {
          store.markPhase2Failed(claim.ownershipToken, heartbeatFailure)
          return { status: "heartbeat_lost" }
        }
        // dispose() / beginPluginShutdown aborted the consolidator: release
        // without the 1h failure backoff so the next boot can reclaim.
        if (err instanceof SubagentCancelledError || isPluginShuttingDown()) {
          store.releasePhase2OnShutdown(claim.ownershipToken)
          return { status: "shutting_down" }
        }
        throw err
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
        store.markPhase2Failed(claim.ownershipToken, heartbeatFailure)
        return { status: "heartbeat_lost" }
      }
      if (releaseIfShuttingDown(store, claim.ownershipToken)) {
        return { status: "shutting_down" }
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
      if (isPluginShuttingDown()) {
        store.releasePhase2OnShutdown(claim.ownershipToken)
        return { status: "shutting_down" }
      }
      if (isProviderCapacityError(err)) noteProviderCapacityExhausted("phase2", consolidationModel)
      store.markPhase2Failed(claim.ownershipToken, err)
      return { status: "failed" }
    } finally {
      endPhase2AbortScope()
    }
  } finally {
    phase2InFlight = false
  }
}
