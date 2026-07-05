import { Database } from "bun:sqlite"
import { opencodeDbPath } from "./paths.js"
import { MemoryStore, SCAN_LIMIT } from "./store.js"

export interface SessionRow {
  id: string
  updated_at: number
  directory: string | null
}

let opencodeDb: Database | null = null

function openOpencodeDb(): Database | null {
  if (opencodeDb) return opencodeDb
  const p = opencodeDbPath()
  try {
    opencodeDb = new Database(p, { readonly: true })
  } catch {
    opencodeDb = null
  }
  return opencodeDb
}

export function listRecentSessions(limit: number = SCAN_LIMIT): SessionRow[] {
  const db = openOpencodeDb()
  if (!db) return []
  try {
    // Top-level sessions only: task-tool children are summarized into their
    // parent, and the plugin's own sub-sessions must never be memorized.
    return db
      .prepare(
        `SELECT id, time_updated AS updated_at, directory FROM session
         WHERE parent_id IS NULL AND title NOT LIKE 'codex-memory-%'
         ORDER BY time_updated DESC LIMIT ?`,
      )
      .all(limit) as SessionRow[]
  } catch {
    return []
  }
}

export interface TranscriptMessage {
  type: string
  role?: string
  text?: string
}

export function loadTranscript(sessionId: string): TranscriptMessage[] {
  const db = openOpencodeDb()
  if (!db) return []
  try {
    const rows = db
      .prepare(
        `SELECT p.data, m.data AS msg_data
         FROM part p
         JOIN message m ON p.message_id = m.id
         WHERE p.session_id = ?
         ORDER BY p.time_created ASC`,
      )
      .all(sessionId) as { data: string; msg_data: string }[]
    return rows.map((r) => {
      let parsed: any = {}
      try {
        parsed = JSON.parse(r.data)
      } catch {
      }
      let role: string | undefined
      try {
        const msg = JSON.parse(r.msg_data)
        role = msg.role
      } catch {
      }
      return {
        type: parsed.type ?? "unknown",
        role,
        text: extractText(parsed),
      }
    })
  } catch {
    return []
  }
}

function extractText(msg: any): string | undefined {
  if (!msg) return undefined
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

export function selectEligibleSessions(
  store: MemoryStore,
  opts: EligibilityOptions,
): SessionRow[] {
  const now = Date.now()
  const minUpdated = now - opts.maxAgeDays * 24 * 60 * 60 * 1000
  const maxUpdated = now - opts.minIdleHours * 60 * 60 * 1000
  const sessions = listRecentSessions()
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