/**
 * Process-local diagnostics for memory_inspect: a small ring buffer of
 * pipeline events plus the last discovery outcome. Not metrics infrastructure
 * (codex OTEL) — just enough to answer "why isn't memory building?" without
 * digging through TUI-invisible console logs.
 */

export type DiagnosticLevel = "info" | "warn" | "error"

export interface DiagnosticEvent {
  at: number
  level: DiagnosticLevel
  kind: string
  message: string
}

export interface DiscoveryStatus {
  at: number
  ok: boolean
  count: number
  error?: string
}

const MAX_EVENTS = 40
const events: DiagnosticEvent[] = []
let discovery: DiscoveryStatus | null = null

export function recordDiagnostic(level: DiagnosticLevel, kind: string, message: string): void {
  events.push({ at: Date.now(), level, kind, message })
  while (events.length > MAX_EVENTS) events.shift()
}

export function recordDiscoveryStatus(status: Omit<DiscoveryStatus, "at">): void {
  discovery = { ...status, at: Date.now() }
  if (!status.ok) {
    recordDiagnostic("warn", "discovery", status.error ?? "session discovery failed")
  } else {
    recordDiagnostic("info", "discovery", `listed ${status.count} session(s)`)
  }
}

export function getRecentDiagnostics(limit = 12): readonly DiagnosticEvent[] {
  return events.slice(-limit)
}

export function getDiscoveryStatus(): DiscoveryStatus | null {
  return discovery
}

/** Test seam. */
export function resetDiagnosticsForTest(): void {
  events.length = 0
  discovery = null
}

export function formatDiagnosticLine(e: DiagnosticEvent): string {
  return `${new Date(e.at).toISOString()} [${e.level}] ${e.kind}: ${e.message}`
}
