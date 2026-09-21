import { MemoryStore } from "../store.js"
import { pluginOptions, getConfigWarnings } from "../options.js"
import { getAgentHealth } from "../agent-health.js"
import { isPhase2InFlight } from "../phase2.js"
import { isPluginShuttingDown } from "../lifecycle.js"
import { activeProviderCapacityBackoffs } from "../ratelimit.js"
import { resolveCodexInterop } from "../codex-interop.js"
import type { MemoryStatus } from "./status-rpc.js"
import { injectionTotals, sessionInjection } from "./injection.js"
import { memoryRoot } from "../paths.js"
import { readMigrationStatus, memoryPipelineSnapshots } from "../migration.js"
import { peekSessionMemoryVersion } from "../session-version.js"
import { withMemoryVersion, writeMemoryVersions } from "../memory-version.js"
import { getV2DiscoveryStatus } from "./shim.js"

/** Read the same snapshots as memory_inspect; never claim or advance a job. */
export function readMemoryStatus(sessionID?: string | null, minConsolidatedThreads?: number): MemoryStatus {
  const sessionVersion = peekSessionMemoryVersion(sessionID)
  const store = withMemoryVersion(sessionVersion, () => new MemoryStore())
  const pipelines = memoryPipelineSnapshots().map((pipeline) => ({
    version: pipeline.version,
    stage1Count: pipeline.stage1Count,
    extracting: pipeline.stage1Jobs.running ?? 0,
    phase2Status: pipeline.phase2?.status ?? null,
    lastError: pipeline.phase2?.last_error ?? null,
  }))
  const active = pipelines.filter((pipeline) => writeMemoryVersions().includes(pipeline.version))
  const options = pluginOptions
  const now = Date.now()
  const staleBeforeSec = Math.floor(now / 1000) - options.max_rollout_age_days * 86_400
  const phase1 = store.stage1JobSnapshot(staleBeforeSec)
  const phase2 = store.phase2JobSnapshot()
  const session = sessionInjection(sessionID)
  const total = injectionTotals()
  const retryTimes = [
    ...activeProviderCapacityBackoffs().map((backoff) => backoff.retry_at),
    ...phase1.recent_errors.map((error) => error.retry_at),
    phase2?.retry_at,
  ].filter((time): time is number => time != null && time * 1000 > now)
  const retryAt = retryTimes.length ? Math.min(...retryTimes) * 1000 : null
  const warnings = [...getConfigWarnings()]
  const discoveryWarning = getV2DiscoveryStatus()?.warning
  if (options.generate_memories && discoveryWarning) warnings.push(discoveryWarning)
  const health = getAgentHealth()
  if (options.generate_memories && health.observed) {
    // V2 extraction is sessionless; only the consolidator agent is used.
    warnings.push(...health.agents.memorize.issues.map((issue) => `memorize: ${issue}`))
  }
  if (phase2?.last_error) warnings.push("Consolidation failed; see memory_inspect for details.")
  for (const pipeline of active) {
    if (pipeline.version !== sessionVersion && pipeline.lastError) warnings.push(`${pipeline.version}: consolidation failed; see memory_inspect.`)
  }
  if (phase1.by_failure_class.due > 0) warnings.push("Some extraction jobs are due to retry.")
  if (phase1.by_failure_class.other_exhausted > phase1.stale_exhausted) {
    warnings.push("Some extraction jobs exhausted their retries.")
  }
  if (phase1.by_failure_class.provider_capacity > 0) warnings.push("Some extraction jobs hit provider capacity limits.")
  const importsV1 = options.codex_interop.import && writeMemoryVersions().includes("v1")
  const codexImport = importsV1 && withMemoryVersion("v1", () => resolveCodexInterop(options.codex_interop)) !== null
  if (importsV1 && !codexImport) warnings.push("Codex import is misconfigured.")

  // A `running` row this process does not own is either another opencode
  // instance's live job or an orphaned lease (e.g. a server restart killed the
  // owner mid-run). Neither is "consolidating" here; surface it instead.
  const foreignLease =
    !isPhase2InFlight() &&
    phase2?.status === "running" &&
    phase2.lease_until != null &&
    phase2.lease_until * 1000 > now
  if (foreignLease) {
    warnings.push(
      `Consolidation lease held by another process until ${new Date(phase2!.lease_until! * 1000).toLocaleTimeString()}.`,
    )
  }

  let activity: MemoryStatus["activity"] = "idle"
  if (isPluginShuttingDown()) activity = "stopping"
  else if (isPhase2InFlight()) activity = "consolidating"
  else if (active.some((pipeline) => pipeline.extracting > 0)) activity = "extracting"
  else if (!options.generate_memories) activity = options.use_memories ? "read_only" : "disabled"
  else if (retryAt !== null) activity = "retrying"
  else if (warnings.length > 0) activity = "error"

  return {
    activity,
    version: options.version,
    sessionVersion,
    pipelines,
    dualWrite: options.dual_write,
    ...readMigrationStatus(minConsolidatedThreads),
    useMemories: options.use_memories,
    generateMemories: options.generate_memories,
    extractModel: options.extract_model ?? null,
    consolidationModel: options.consolidation_model ?? null,
    codexImport,
    // finished_at on a failed attempt is NOT a successful consolidation.
    lastSuccessAt: phase2?.success_finished_at != null ? phase2.success_finished_at * 1000 : null,
    retryAt,
    warnings,
    sessionMode: sessionID ? store.getMemoryMode(sessionID) : null,
    memoryRoot: memoryRoot(sessionVersion),
    injected: {
      sessionTokens: session.tokens,
      sessionRequests: session.requests,
      totalTokens: total.tokens,
      totalRequests: total.requests,
    },
  }
}
