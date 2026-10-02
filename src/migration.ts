import fs from "node:fs"
import { memoryDbPath, memoryRoot } from "./paths.js"
import { MemoryStore, existingMemoryStores } from "./store.js"
import { withMemoryVersion } from "./memory-version.js"
import { validateV2Summary } from "./workspace.js"
import { safeResolveUnderRoot, readRegularFileNoFollow } from "./path-guard.js"
import { MEMORY_V2_SUMMARY_MAX_BYTES, truncateToBytes } from "./token.js"

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
  let v2SummaryBytes: number | null = null
  let v2InjectedSummaryBytes: number | null = null
  let v2NotReadyReason: string | null = null
  try {
    const file = safeResolveUnderRoot(memoryRoot("v2"), "memory_summary.md")
    const summary = readRegularFileNoFollow(file).content.toString("utf8")
    const validation = validateV2Summary(summary)
    valid = validation.ok
    v2SummaryBytes = validation.bytes
    v2InjectedSummaryBytes = Buffer.byteLength(truncateToBytes(summary.trim(), MEMORY_V2_SUMMARY_MAX_BYTES), "utf8")
    v2NotReadyReason = validation.reason
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    const message = error instanceof Error ? error.message : String(error)
    v2NotReadyReason = `cannot read V2 memory summary${typeof code === "string" ? ` (${code})` : ""}: ${message}`
  }
  if (valid && v2ConsolidatedThreads < minConsolidatedThreads) {
    v2NotReadyReason = `insufficient consolidated threads: ${v2ConsolidatedThreads} < ${minConsolidatedThreads}`
  }
  return {
    v2ConsolidatedThreads,
    v2Ready: valid && v2ConsolidatedThreads >= minConsolidatedThreads,
    v2NotReadyReason,
    v2SummaryBytes,
    v2InjectedSummaryBytes,
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
