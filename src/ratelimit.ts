export interface RateLimitInfo {
  ok: boolean
  reason?: string
}

export type MemoryPhase = "phase1" | "phase2"

export interface ProviderCapacityBackoff {
  scope: string
  retry_at: number
}

export class ProviderCapacityError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message)
    this.name = "ProviderCapacityError"
  }
}

/**
 * Process-local anti-stampede for phase 1, plus an observed-quota circuit
 * breaker that stands in for Codex guard.rs.
 *
 * Codex has no wall-clock throttle: it reads live provider quota once per
 * startup (memories/write/src/guard.rs) and fails open when unknown. Opencode
 * does not expose provider rate limits to plugins, so this stub:
 * - keeps chat.message/idle from hammering discovery + claim (30s, phase 1)
 * - after a quota/rate-limit API error, skips further claims until the same
 *   1h window Codex uses for job retry_at — so a quota outage cannot burn
 *   every eligible session's retry budget
 *
 * Semantics deliberately match "do not start another token-using run too
 * often", not "do not look often":
 * - checkRateLimit only reads clocks (empty/no-claim passes do not stamp)
 * - markRateLimitUsed stamps after a stage-1 claim actually succeeds
 * - noteProviderCapacityExhausted stamps after an observed quota error
 * - phase 2 has no 30s timer; the DB claim + 6h cooldown serialize it.
 *   The observed-quota stamp still skips phase 2 (Codex start.rs skips both).
 */
let lastPhase1Work = 0
const providerCapacityUntil = new Map<string, number>()

const MIN_PHASE1_INTERVAL_MS = 30_000
export const PROVIDER_CAPACITY_BACKOFF_MS = 3_600_000

const PROVIDER_CAPACITY_RE =
  /usage limit|free usage exceeded|provider capacity exhausted|rate[\s_-]?limit|quota(?:\s+(?:exceeded|exhausted|reached))?|too many requests|\b429\b|resource_exhausted|insufficient_quota|billing.?hard.?limit/i

function errorRecord(error: unknown): Record<string, unknown> | null {
  return error && typeof error === "object" ? error as Record<string, unknown> : null
}

function providerCapacityStatusCode(error: unknown): number | null {
  const record = errorRecord(error)
  const data = errorRecord(record?.data)
  const value = record?.statusCode ?? data?.statusCode
  if (typeof value === "number") return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return null
}

export function providerCapacityMessage(error: unknown): string {
  try {
    if (typeof error === "string") return error
    if (error instanceof Error) return String(error.message ?? "unknown error")
    const record = errorRecord(error)
    const data = errorRecord(record?.data)
    const message = record?.message ?? data?.message
    if (typeof message === "string") return message
    return String(error ?? "unknown error")
  } catch {
    return "unknown error"
  }
}

export function isProviderCapacityError(error: unknown): boolean {
  if (error instanceof ProviderCapacityError) return true
  if (providerCapacityStatusCode(error) === 429) return true
  return PROVIDER_CAPACITY_RE.test(providerCapacityMessage(error))
}

function providerCapacityScope(phase: MemoryPhase, model?: string): string {
  return model ? `model:${model}` : `phase:${phase}:default`
}

export function activeProviderCapacityBackoffs(now = Date.now()): ProviderCapacityBackoff[] {
  const active: ProviderCapacityBackoff[] = []
  for (const [scope, until] of providerCapacityUntil) {
    if (until <= now) {
      providerCapacityUntil.delete(scope)
      continue
    }
    active.push({ scope, retry_at: Math.floor(until / 1000) })
  }
  return active.sort((a, b) => a.scope.localeCompare(b.scope))
}

export function isProviderCapacityBlocked(phase: MemoryPhase, model?: string, now = Date.now()): boolean {
  const until = providerCapacityUntil.get(providerCapacityScope(phase, model))
  return until !== undefined && until > now
}

/** Call after a quota/rate-limit failure so later passes skip claiming. */
export function noteProviderCapacityExhausted(phase: MemoryPhase, model?: string, now = Date.now()): void {
  providerCapacityUntil.set(providerCapacityScope(phase, model), now + PROVIDER_CAPACITY_BACKOFF_MS)
}

export async function checkRateLimit(kind: MemoryPhase = "phase1", model?: string): Promise<RateLimitInfo> {
  if (isProviderCapacityBlocked(kind, model)) {
    return {
      ok: false,
      reason: `provider capacity exhausted for ${providerCapacityScope(kind, model)} (observed quota/rate-limit)`,
    }
  }
  // Phase 2: no 30s gate (codex relies on DB claim/cooldown only).
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

/** Test seam: reset the process-local stamps. */
export function resetRateLimitForTest(): void {
  lastPhase1Work = 0
  providerCapacityUntil.clear()
}
