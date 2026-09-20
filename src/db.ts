import { Database } from "bun:sqlite"
import fs from "fs"
import path from "path"
import { memoryDbPath, sessionMetaDbPath } from "./paths.js"
import type { MemoryVersion } from "./options.js"

const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS memory_stage1_outputs (
    session_id TEXT PRIMARY KEY,
    source_updated_at INTEGER NOT NULL,
    raw_memory TEXT NOT NULL,
    rollout_summary TEXT NOT NULL,
    rollout_slug TEXT,
    cwd TEXT,
    generated_at INTEGER NOT NULL,
    usage_count INTEGER DEFAULT 0,
    last_usage INTEGER,
    selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
    selected_for_phase2_source_updated_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_stage1_source_updated_at
    ON memory_stage1_outputs(source_updated_at DESC, session_id DESC)`,
  `CREATE TABLE IF NOT EXISTS memory_jobs (
    kind TEXT NOT NULL,
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    worker_id TEXT,
    ownership_token TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    lease_until INTEGER,
    retry_at INTEGER,
    retry_remaining INTEGER NOT NULL,
    last_error TEXT,
    input_watermark INTEGER,
    last_success_watermark INTEGER,
    PRIMARY KEY (kind, job_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_memory_jobs_kind_status_retry_lease
    ON memory_jobs(kind, status, retry_at, lease_until)`,
  `CREATE TABLE IF NOT EXISTS memory_session_meta (
    session_id TEXT PRIMARY KEY,
    memory_mode TEXT NOT NULL DEFAULT 'enabled',
    polluted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
]

const connections = new Map<string, Database>()

function openSqlite(dbPath: string): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true, readwrite: true, strict: false })
  try {
    // Match codex's memories-DB open options (runtime.rs): WAL, NORMAL sync,
    // 5s busy timeout for cross-process access, incremental auto-vacuum.
    db.run("PRAGMA journal_mode=WAL")
    db.run("PRAGMA synchronous=NORMAL")
    db.run("PRAGMA busy_timeout=5000")
    db.run("PRAGMA auto_vacuum=INCREMENTAL")
    runMigrations(db)
    return db
  } catch (err) {
    db.close()
    throw err
  }
}

function connection(dbPath: string): Database {
  let db = connections.get(dbPath)
  if (!db) {
    db = openSqlite(dbPath)
    connections.set(dbPath, db)
  }
  return db
}

/** Both versioned handles stay open while their pipelines run concurrently. */
export function openDb(version?: MemoryVersion): Database {
  return connection(memoryDbPath(version))
}

/** One-shot connection for reset across versioned files. Caller must close. */
export function openTransientDb(dbPath: string): Database {
  return openSqlite(dbPath)
}

/** Always memory.db — shared session_meta catalog across versions. */
export function openSessionMetaDb(): Database {
  return connection(sessionMetaDbPath())
}

function runMigrations(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL
  )`)
  db.transaction(() => {
    // Read the version only after taking the write lock so concurrent plugin
    // instances cannot both apply the same ALTER TABLE.
    const current = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number } | null
    const currentVersion = current?.version ?? 0
    if (currentVersion < 1) {
      for (const stmt of SCHEMA_V1) db.run(stmt)
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(1, Date.now())
    }
    if (currentVersion < 2) {
      db.run(`CREATE TABLE IF NOT EXISTS memory_citation_usage (
        session_id TEXT NOT NULL,
        assistant_message_id TEXT NOT NULL,
        cited_session_id TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, assistant_message_id, cited_session_id)
      )`)
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(2, Date.now())
    }
    if (currentVersion < 3) {
      db.run(`CREATE TABLE consolidation_progress (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        max_thread_count INTEGER NOT NULL DEFAULT 0
      )`)
      db.run("INSERT INTO consolidation_progress (singleton, max_thread_count) VALUES (1, 0)")
      db.run(`CREATE TABLE memory_session_versions (
        session_id TEXT PRIMARY KEY,
        version TEXT NOT NULL CHECK (version IN ('v1', 'v2'))
      )`)
      db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(3, Date.now())
    }
  }).immediate()
}

export function closeDb(): void {
  for (const db of connections.values()) db.close()
  connections.clear()
}
