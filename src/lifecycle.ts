/**
 * Plugin process lifecycle: shutdown flag + phase-2 abort signal shared by
 * the entry dispose hook and the write pipeline.
 *
 * Opencode can reload plugins while a consolidator helper still holds write
 * access to the memory root. dispose() sets the flag (so new pumps stop),
 * aborts the in-flight consolidation prompt, and best-effort aborts active
 * sub-sessions (llm.ts).
 */

let shuttingDown = false
let phase2Abort: AbortController | null = null

export function isPluginShuttingDown(): boolean {
  return shuttingDown
}

/** Begin shutdown: no new phase work, abort any in-flight consolidator. */
export function beginPluginShutdown(): void {
  shuttingDown = true
  phase2Abort?.abort()
}

/** Test / re-boot seam: a fresh server() call clears the previous dispose. */
export function resetPluginLifecycle(): void {
  shuttingDown = false
  phase2Abort = null
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

export function phase2AbortSignal(): AbortSignal | undefined {
  return phase2Abort?.signal
}

/** Abort the current consolidator from outside phase2 (dispose). */
export function abortPhase2Consolidation(): void {
  phase2Abort?.abort()
}
