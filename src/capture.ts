import { Database } from "bun:sqlite"
import { opencodeDbPath } from "./paths.js"
import { MemoryStore, SCAN_LIMIT } from "./store.js"

export interface SessionRow {
  id: string
  updated_at: number
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
    return db
      .prepare("SELECT id, updated_at FROM session ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as SessionRow[]
  } catch {
    return []
  }
}

export interface TranscriptMessage {
  type: string
  role?: string
  text?: string
  seq: number
}

export function loadTranscript(sessionId: string): TranscriptMessage[] {
  const db = openOpencodeDb()
  if (!db) return []
  try {
    const rows = db
      .prepare("SELECT seq, data FROM session_message WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as { seq: number; data: string }[]
    return rows.map((r) => {
      let parsed: any = {}
      try {
        parsed = JSON.parse(r.data)
      } catch {
      }
      return {
        seq: r.seq,
        type: parsed.type ?? "unknown",
        role: parsed.role,
        text: typeof parsed.text === "string" ? parsed.text : extractText(parsed),
      }
    })
  } catch {
    return []
  }
}

function extractText(msg: any): string | undefined {
  if (!msg) return undefined
  if (typeof msg.text === "string") return msg.text
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