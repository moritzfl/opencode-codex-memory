export interface RateLimitInfo {
  ok: boolean
  reason?: string
}

let lastPhase1 = 0
let lastPhase2 = 0

const MIN_PHASE1_INTERVAL_MS = 30_000
const MIN_PHASE2_INTERVAL_MS = 5 * 60 * 1000

export async function checkRateLimit(kind: "phase1" | "phase2" = "phase1"): Promise<RateLimitInfo> {
  const now = Date.now()
  if (kind === "phase1") {
    if (now - lastPhase1 < MIN_PHASE1_INTERVAL_MS) {
      return { ok: false, reason: "phase1 rate limit (30s)" }
    }
    lastPhase1 = now
  } else {
    if (now - lastPhase2 < MIN_PHASE2_INTERVAL_MS) {
      return { ok: false, reason: "phase2 rate limit (5min)" }
    }
    lastPhase2 = now
  }
  return { ok: true }
}