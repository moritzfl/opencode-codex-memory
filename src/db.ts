import { Database } from "bun:sqlite"
import { memoryDbPath } from "./paths.js"

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

let dbInstance: Database | null = null

export function openDb(): Database {
  if (dbInstance) return dbInstance
  const dbPath = memoryDbPath()
  const db = new Database(dbPath, { create: true, readwrite: true, strict: false })
  // Match codex's memories-DB open options (runtime.rs): WAL, NORMAL sync,
  // 5s busy timeout for cross-process access, incremental auto-vacuum.
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA synchronous=NORMAL")
  db.exec("PRAGMA busy_timeout=5000")
  db.exec("PRAGMA auto_vacuum=INCREMENTAL")
  runMigrations(db)
  dbInstance = db
  return db
}

function runMigrations(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL
  )`)
  const current = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number } | null
  const currentVersion = current?.version ?? 0
  if (currentVersion >= 1) return
  for (const stmt of SCHEMA_V1) db.exec(stmt)
  db.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)").run(1, Date.now())
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close()
    dbInstance = null
  }
}