import { MemoryStore } from "./store.js"
import { runPhase1 } from "./phase1.js"
import { runPhase2 } from "./phase2.js"
import { pluginOptions } from "./options.js"
import { memoryDbPath } from "./paths.js"
import { withMemoryVersion, writeMemoryVersions } from "./memory-version.js"
import { isPluginShuttingDown } from "./lifecycle.js"
import { recordDiagnostic } from "./diagnostics.js"

const extracting = new Set<string>()

async function consolidate(store: MemoryStore, bypassCooldown: boolean): Promise<string> {
  try {
    const result = await runPhase2(store, {
      maxRaw: pluginOptions.max_raw_memories_for_consolidation,
      maxUnusedDays: pluginOptions.max_unused_days,
      extensionRetentionDays: 7,
      consolidationModel: pluginOptions.consolidation_model,
      codexInterop: pluginOptions.codex_interop,
      claudeImport: pluginOptions.claude_import,
      bypassCooldown,
    })
    if (!["already_running", "skipped_cooldown", "skipped_running"].includes(result.status)) {
      recordDiagnostic(
        ["succeeded", "no_workspace_changes"].includes(result.status) ? "info" : "warn",
        "phase2", `${store.version}: ${result.status}`,
      )
    }
    return result.status
  } catch (err) {
    recordDiagnostic("error", "phase2", `${store.version}: ${String(err)}`)
    return "failed"
  }
}

/** Codex start.rs: independently run phase 1 then phase 2 for each write version. */
export async function runMemoryPipeline(currentSessionId?: string, bypassCooldown = false): Promise<string[]> {
  if (!pluginOptions.generate_memories) return ["generation_disabled"]
  if (isPluginShuttingDown()) return ["shutting_down"]
  return Promise.all(writeMemoryVersions().map((version) => withMemoryVersion(version, async () => {
    const key = memoryDbPath()
    if (extracting.has(key)) return "already_running"
    const store = new MemoryStore()
    extracting.add(key)
    try {
      await runPhase1(store, {
        maxAgeDays: pluginOptions.max_rollout_age_days,
        minIdleHours: pluginOptions.min_rollout_idle_hours,
        maxClaimed: pluginOptions.max_rollouts_per_startup,
        maxUnusedDays: pluginOptions.max_unused_days,
        excludeSession: currentSessionId,
        extractModel: pluginOptions.extract_model,
      })
    } catch (err) {
      recordDiagnostic("error", "phase1", `${version}: ${String(err)}`)
    } finally {
      extracting.delete(key)
    }
    return consolidate(store, bypassCooldown)
  }).catch((err) => {
    recordDiagnostic("error", "pipeline", `${version}: ${String(err)}`)
    return "failed"
  })))
}

export async function runMemoryConsolidation(): Promise<string[]> {
  if (!pluginOptions.generate_memories) return ["generation_disabled"]
  if (isPluginShuttingDown()) return ["shutting_down"]
  return Promise.all(writeMemoryVersions().map((version) =>
    withMemoryVersion(version, async () => consolidate(new MemoryStore(), false)).catch((err) => {
      recordDiagnostic("error", "pipeline", `${version}: ${String(err)}`)
      return "failed"
    }),
  ))
}
