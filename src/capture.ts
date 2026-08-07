import { SCAN_LIMIT } from "./store.js"
import type { MemoryStore } from "./store.js"
import { getPluginInput } from "./llm.js"
import { recordDiscoveryStatus } from "./diagnostics.js"
import { hostPartType, hostSessionMessages, pluginHttpGet } from "./host-client.js"

export interface SessionRow {
  id: string
  updated_at: number
  directory: string | null
}

const API_TIMEOUT_MS = 60_000

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface ApiSession {
  id: string
  directory?: string
  parentID?: string
  title?: string
  time?: { updated?: number }
}

/**
 * Global session discovery through the official API:
 * `GET /experimental/session?roots=true` (Session.listGlobal) — one call across
 * all projects, sorted by most-recently-updated. Available since opencode
 * 1.17.x. Fail-safe: any error skips the pass ([]); never finalizes a job.
 * Transcript loading must NOT be fail-safe — see loadTranscript.
 */
export async function listRecentSessions(limit: number = SCAN_LIMIT): Promise<SessionRow[]> {
  const get = pluginHttpGet(getPluginInput()?.client)
  if (!get) {
    recordDiscoveryStatus({ ok: false, count: 0, error: "plugin HTTP client unavailable" })
    return []
  }
  try {
    const res = await withTimeout(
      get({
        url: "/experimental/session",
        query: { roots: true, limit },
      }),
      API_TIMEOUT_MS,
      "experimental.session.list",
    )
    if (!res || res.error || !Array.isArray(res.data)) {
      throw new Error(`experimental.session.list failed: ${JSON.stringify(res?.error ?? {})}`)
    }
    const all: SessionRow[] = []
    for (const s of res.data as ApiSession[]) {
      // Top-level sessions only: task-tool children are summarized into their
      // parent, and the plugin's own sub-sessions must never be memorized
      // (roots=true drops children server-side; keep both belts).
      if (!s?.id || s.parentID) continue
      if (s.title && s.title.startsWith("codex-memory-")) continue
      all.push({ id: s.id, updated_at: s.time?.updated ?? 0, directory: s.directory ?? null })
    }
    // Server already orders by time_updated DESC; re-sort so a lagging host
    // cannot invert eligibility order.
    all.sort((a, b) => b.updated_at - a.updated_at)
    const out = all.slice(0, limit)
    recordDiscoveryStatus({ ok: true, count: out.length })
    return out
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn("[opencode-codex-memory] session discovery failed; skipping pass:", err)
    recordDiscoveryStatus({ ok: false, count: 0, error: message })
    return []
  }
}

export interface TranscriptMessage {
  type: string
  role?: string
  text?: string
}

/** Official transcript surface: GET /session/{id}/message via the plugin's authenticated client. */
async function fetchMessagesViaApi(sessionId: string): Promise<{ info?: { role?: string }; parts?: unknown[] }[]> {
  const res = await withTimeout(
    hostSessionMessages(getPluginInput()?.client, sessionId),
    API_TIMEOUT_MS,
    "session.messages",
  )
  if (!res || res.error || !Array.isArray(res.data)) {
    throw new Error(`session.messages failed: ${JSON.stringify(res?.error ?? {})}`)
  }
  return res.data as { info?: { role?: string }; parts?: unknown[] }[]
}

/**
 * Transcript loading uses the official API — the same surface opencode's own
 * UI renders history from; the session-scoped route resolves the right
 * instance even for sessions from other projects.
 *
 * Errors PROPAGATE. An empty result must mean "session has no extractable
 * content" — a swallowed error here used to surface as a successful
 * no-output extraction, which deletes any previous extraction for the
 * session (codex: load_rollout_items errors fail the job, which retries
 * under its lease/backoff). A claimed session normally has messages, so a
 * legitimately empty result is logged for observability.
 */
export async function loadTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  const rows = await fetchMessagesViaApi(sessionId)
  if (rows.length === 0) {
    console.warn(`[opencode-codex-memory] session.messages returned no messages for claimed session ${sessionId}`)
    return []
  }
  // One entry per part — the granularity extraction expects.
  const out: TranscriptMessage[] = []
  for (const row of rows) {
    const role = row?.info?.role
    for (const part of row?.parts ?? []) {
      out.push({
        type: hostPartType(part),
        role,
        text: extractText(part),
      })
    }
  }
  return out
}

function extractText(msg: any): string | undefined {
  if (!msg) return undefined
  // codex excludes reasoning items from extraction transcripts
  // (rollout policy: ResponseItem::Reasoning => false); opencode reasoning
  // parts carry `text`, so they must be dropped before the text check.
  if (msg.type === "reasoning") return undefined
  // opencode itself drops `ignored` text parts when building model messages
  // (session/message-v2.ts), e.g. ACP content addressed only to the user.
  // The assistant never saw them, so they are not conversation.
  if (msg.ignored === true) return undefined
  if (typeof msg.text === "string") return msg.text
  if (msg.type === "tool") {
    // Full tool payloads: codex serializes complete FunctionCall/Output items
    // and relies solely on the global transcript truncation. Tool outputs are
    // the extractor's strongest evidence — do not slice them per call.
    const tool = msg.tool ?? "unknown"
    const input = msg.state?.input ? JSON.stringify(msg.state.input) : ""
    // `output` exists only on status:"completed"; a failed call carries
    // `error` instead (schema v1/session.ts ToolStateError). codex persists
    // failed calls too (rollout policy: FunctionCallOutput => true), and "X
    // failed with Y" is often the most memorable part of a session.
    const result =
      typeof msg.state?.output === "string"
        ? msg.state.output
        : typeof msg.state?.error === "string"
          ? `[error] ${msg.state.error}`
          : ""
    return `[tool: ${tool}] ${input}${result ? "\n" + result : ""}`
  }
  if (msg.type === "step-start" || msg.type === "step-finish") return undefined
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("\n")
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => typeof c === "string" || typeof c?.text === "string")
      .map((c: any) => (typeof c === "string" ? c : c.text))
      .join("\n")
  }
  return undefined
}

export interface EligibilityOptions {
  maxAgeDays: number
  minIdleHours: number
  excludeSession?: string
}

export async function selectEligibleSessions(
  store: MemoryStore,
  opts: EligibilityOptions,
): Promise<SessionRow[]> {
  const now = Date.now()
  const minUpdated = now - opts.maxAgeDays * 24 * 60 * 60 * 1000
  const maxUpdated = now - opts.minIdleHours * 60 * 60 * 1000
  const sessions = await listRecentSessions()
  return sessions.filter((s) => {
    if (opts.excludeSession && s.id === opts.excludeSession) return false
    if (s.updated_at < minUpdated) return false
    if (s.updated_at > maxUpdated) return false
    const mode = store.getMemoryMode(s.id)
    if (mode === "disabled") return false
    if (store.isPolluted(s.id)) return false
    return true
  })
}
