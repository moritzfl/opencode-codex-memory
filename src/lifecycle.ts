/**
 * Plugin process lifecycle: shutdown flag + abort signals shared by the entry
 * dispose hook and the write pipeline.
 *
 * Opencode can reload plugins while a consolidator helper still holds write
 * access to the memory root. dispose() sets the flag (so new pumps stop),
 * aborts pluginShutdownSignal (extract + any other waiters) and the in-flight
 * phase-2 AbortSignal (consolidateViaSubagent), and best-effort session.aborts
 * active sub-sessions (llm.ts abortActiveSubSessions).
 *
 * Phase-2 keeps its own scope so heartbeat loss can cancel the consolidator
 * without marking the whole plugin as shutting down.
 */

let shuttingDown = false
let phase2Abort: AbortController | null = null
/** Fresh each boot; aborted on dispose. Extract (and others) subscribe here. */
let shutdownAbort = new AbortController()

export function isPluginShuttingDown(): boolean {
  return shuttingDown
}

/** Aborted when dispose begins; replaced on resetPluginLifecycle / re-boot. */
export function pluginShutdownSignal(): AbortSignal {
  return shutdownAbort.signal
}

/** Begin shutdown: no new phase work, abort extract + consolidator waiters. */
export function beginPluginShutdown(): void {
  shuttingDown = true
  if (!shutdownAbort.signal.aborted) shutdownAbort.abort()
  phase2Abort?.abort()
}

/**
 * Test / re-boot seam: a fresh server() call clears the previous dispose.
 * Abort any live consolidator controller before dropping the reference so a
 * glitched boot order cannot orphan a still-running phase-2 prompt.
 */
export function resetPluginLifecycle(): void {
  phase2Abort?.abort()
  phase2Abort = null
  shutdownAbort = new AbortController()
  shuttingDown = false
}

/**
 * AbortSignal for the current phase-2 consolidation run. Created when the job
 * is claimed; aborted on heartbeat loss, dispose, or run end.
 */
export function beginPhase2AbortScope(): AbortSignal {
  phase2Abort?.abort()
  phase2Abort = new AbortController()
  return phase2Abort.signal
}

export function endPhase2AbortScope(): void {
  phase2Abort = null
}

/** Abort the current consolidator from outside phase2 (dispose). */
export function abortPhase2Consolidation(): void {
  phase2Abort?.abort()
}
