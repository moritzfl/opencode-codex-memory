import { openSessionMetaDb } from "./db.js"
import { pluginOptions, type MemoryVersion } from "./options.js"
import { withMemoryVersion } from "./memory-version.js"

/** Freeze injection, retrieval, notes and citation accounting to one namespace.
 * Codex keeps this in thread extension state. Persist our stamp because plugin
 * reloads and host reconnects do not end an OpenCode conversation.
 */
export function sessionMemoryVersion(sessionId?: string): MemoryVersion {
  if (!sessionId) return pluginOptions.version
  const db = openSessionMetaDb()
  db.prepare("INSERT OR IGNORE INTO memory_session_versions (session_id, version) VALUES (?, ?)")
    .run(sessionId, pluginOptions.version)
  return (db.prepare("SELECT version FROM memory_session_versions WHERE session_id = ?")
    .get(sessionId) as { version: MemoryVersion }).version
}

export function withSessionMemoryVersion<T>(sessionId: string | undefined, run: () => T): T {
  return withMemoryVersion(sessionMemoryVersion(sessionId), run)
}

/** Status reporting must not freeze a session before its first real use. */
export function peekSessionMemoryVersion(sessionId?: string | null): MemoryVersion {
  if (!sessionId) return pluginOptions.version
  const row = openSessionMetaDb().prepare("SELECT version FROM memory_session_versions WHERE session_id = ?")
    .get(sessionId) as { version: MemoryVersion } | null
  return row?.version ?? pluginOptions.version
}
