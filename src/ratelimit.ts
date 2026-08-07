export interface RateLimitInfo {
  ok: boolean
  reason?: string
}

/**
 * Process-local anti-stampede for phase 1 only.
 *
 * Codex has no wall-clock throttle: it reads live provider quota once per
 * startup (memories/write/src/guard.rs) and fails open when unknown. Opencode
 * does not expose provider rate limits to plugins, so this stub keeps
 * chat.message/idle from hammering discovery + claim when many sessions go
 * idle at once.
 *
 * Semantics deliberately match "do not start another token-using run too
 * often", not "do not look often":
 * - checkRateLimit only reads the clock (empty/no-claim passes do not stamp)
 * - markRateLimitUsed stamps after a stage-1 claim actually succeeds
 * - phase 2 has no process timer; the DB claim + 6h cooldown serialize it
 *   (same as codex phase2 job outcomes)
 */
let lastPhase1Work = 0

const MIN_PHASE1_INTERVAL_MS = 30_000

export async function checkRateLimit(kind: "phase1" | "phase2" = "phase1"): Promise<RateLimitInfo> {
  // Phase 2: no process-local gate (codex relies on DB claim/cooldown only).
  if (kind === "phase2") return { ok: true }

  const now = Date.now()
  if (now - lastPhase1Work < MIN_PHASE1_INTERVAL_MS) {
    return { ok: false, reason: "phase1 rate limit (30s since last claimed work)" }
  }
  return { ok: true }
}

/** Call after a phase-1 pass claimed at least one job (token-using work started). */
export function markRateLimitUsed(kind: "phase1" | "phase2" = "phase1"): void {
  if (kind === "phase1") lastPhase1Work = Date.now()
}

/** Test seam: reset the process-local stamp. */
export function resetRateLimitForTest(): void {
  lastPhase1Work = 0
}
