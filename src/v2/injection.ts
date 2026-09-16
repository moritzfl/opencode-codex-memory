/**
 * In-process ledger of memory text injected into model requests by the V2
 * `context` hook. Token counts are the same chars/4 estimate used for the
 * injection cap, so they are comparable to `memory_inspect`'s
 * `summary_tokens_est`, not provider-billed tokens.
 */
export interface InjectionTotals {
  tokens: number
  requests: number
}

const perSession = new Map<string, InjectionTotals>()
let global: InjectionTotals = { tokens: 0, requests: 0 }

export function recordInjection(sessionID: string, tokens: number): void {
  global = { tokens: global.tokens + tokens, requests: global.requests + 1 }
  const current = perSession.get(sessionID) ?? { tokens: 0, requests: 0 }
  perSession.set(sessionID, { tokens: current.tokens + tokens, requests: current.requests + 1 })
}

export function injectionTotals(): InjectionTotals {
  return { ...global }
}

export function sessionInjection(sessionID: string | null | undefined): InjectionTotals {
  if (!sessionID) return { tokens: 0, requests: 0 }
  return { ...(perSession.get(sessionID) ?? { tokens: 0, requests: 0 }) }
}

export function resetInjectionStats(): void {
  perSession.clear()
  global = { tokens: 0, requests: 0 }
}
