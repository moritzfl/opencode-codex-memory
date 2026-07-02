export interface RateLimitInfo {
  ok: boolean
  reason?: string
}

export async function checkRateLimit(): Promise<RateLimitInfo> {
  return { ok: true }
}