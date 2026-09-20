import fs from "node:fs"
import { memoryDbPath, memoryRoot } from "./paths.js"
import { MemoryStore, existingMemoryStores } from "./store.js"
import { withMemoryVersion } from "./memory-version.js"
import { isValidV2Summary } from "./workspace.js"
import { safeResolveUnderRoot, readRegularFileNoFollow } from "./path-guard.js"

export const DEFAULT_MIN_CONSOLIDATED_THREADS = 20

/** Codex memory/status: high-water progress AND a currently valid V2 summary. */
export function readMigrationStatus(minConsolidatedThreads = DEFAULT_MIN_CONSOLIDATED_THREADS) {
  if (!Number.isInteger(minConsolidatedThreads) || minConsolidatedThreads < 1 || minConsolidatedThreads > 4096) {
    throw new Error("minConsolidatedThreads must be between 1 and 4096")
  }
  const v2ConsolidatedThreads = fs.existsSync(memoryDbPath("v2"))
    ? withMemoryVersion("v2", () => new MemoryStore().maxConsolidatedThreadCount())
    : 0
  let valid = false
  try {
    const file = safeResolveUnderRoot(memoryRoot("v2"), "memory_summary.md")
    valid = isValidV2Summary(readRegularFileNoFollow(file).content.toString("utf8"))
  } catch { /* Missing or unsafe summary is not ready. */ }
  return {
    v2ConsolidatedThreads,
    v2Ready: valid && v2ConsolidatedThreads >= minConsolidatedThreads,
    minConsolidatedThreads,
  }
}

export function memoryPipelineSnapshots() {
  return existingMemoryStores().map((store) => ({
    version: store.version,
    root: memoryRoot(store.version),
    stage1Count: store.stage1OutputCount(),
    stage1Jobs: store.stage1JobSnapshot().by_status,
    phase2: store.phase2JobSnapshot(),
    maxConsolidatedThreads: store.maxConsolidatedThreadCount(),
  }))
}
