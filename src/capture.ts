import { SCAN_LIMIT } from "./store.js"
import type { MemoryStore } from "./store.js"
import { getPluginInput } from "./llm.js"

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
 * Global session discovery through the official API: opencode's session.list
 * is project-scoped, so enumerate projects (project.list) and list each one
 * with scope=project (routes the request to that project's instance AND
 * widens the filter from the session directory to the whole project).
 * Instance contexts created this way are cached by the host for the process
 * lifetime, and the whole pass is rate-limited (30s min interval).
 *
 * Fail-safe at two levels: a failed project.list skips the pass ([]), a
 * failed per-project session.list skips that project — neither claims or
 * finalizes any job. Transcript loading must NOT be fail-safe — see
 * loadTranscript.
 */
export async function listRecentSessions(limit: number = SCAN_LIMIT): Promise<SessionRow[]> {
  const client = getPluginInput()?.client as any
  if (!client?.project?.list || !client?.session?.list) return []
  let projects: { worktree?: string }[]
  try {
    const res = await withTimeout<{ error?: unknown; data?: unknown }>(client.project.list(), API_TIMEOUT_MS, "project.list")
    if (!res || res.error || !Array.isArray(res.data)) throw new Error(`project.list failed: ${JSON.stringify(res?.error ?? {})}`)
    projects = res.data as { worktree?: string }[]
  } catch (err) {
    console.warn("[opencode-codex-memory] project discovery failed; skipping pass:", err)
    return []
  }

  const all: SessionRow[] = []
  for (const project of projects) {
    if (!project?.worktree) continue
    try {
      const res = await withTimeout<{ error?: unknown; data?: unknown }>(
        client.session.list({
          // scope/roots/limit are in the server's ListQuery (accepted since
          // opencode 1.14.30, well under our 1.18 floor); the pinned SDK types
          // still omit them (SessionListData.query is just { directory } as of
          // 1.18.1), hence the cast at the call site.
          query: { directory: project.worktree, scope: "project", roots: true, limit },
        }),
        API_TIMEOUT_MS,
        "session.list",
      )
      if (!res || res.error || !Array.isArray(res.data)) throw new Error(JSON.stringify(res?.error ?? {}))
      for (const s of res.data as ApiSession[]) {
        // Top-level sessions only: task-tool children are summarized into
        // their parent, and the plugin's own sub-sessions must never be
        // memorized (roots=true drops children server-side; keep both belts).
        if (!s?.id || s.parentID) continue
        if (s.title && s.title.startsWith("codex-memory-")) continue
        all.push({ id: s.id, updated_at: s.time?.updated ?? 0, directory: s.directory ?? null })
      }
    } catch (err) {
      console.warn(`[opencode-codex-memory] session.list failed for ${project.worktree}; skipping project:`, err)
    }
  }
  all.sort((a, b) => b.updated_at - a.updated_at)
  return all.slice(0, limit)
}

export interface TranscriptMessage {
  type: string
  role?: string
  text?: string
}

/** Official transcript surface: GET /session/{id}/message via the plugin's authenticated client. */
async function fetchMessagesViaApi(sessionId: string): Promise<{ info?: { role?: string }; parts?: unknown[] }[]> {
  const client = getPluginInput()?.client as any
  if (typeof client?.session?.messages !== "function") {
    throw new Error("plugin client unavailable; cannot load transcript")
  }
  const res = await withTimeout<{ error?: unknown; data?: unknown }>(
    client.session.messages({ path: { id: sessionId } }),
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
        type: (part as any)?.type ?? "unknown",
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
  if (typeof msg.text === "string") return msg.text
  if (msg.type === "tool") {
    // Full tool payloads: codex serializes complete FunctionCall/Output items
    // and relies solely on the global transcript truncation. Tool outputs are
    // the extractor's strongest evidence — do not slice them per call.
    const tool = msg.tool ?? "unknown"
    const input = msg.state?.input ? JSON.stringify(msg.state.input) : ""
    const output = typeof msg.state?.output === "string" ? msg.state.output : ""
    return `[tool: ${tool}] ${input}${output ? "\n" + output : ""}`
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
