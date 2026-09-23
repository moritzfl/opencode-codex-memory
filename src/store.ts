import fs from "fs"
import os from "os"
import type { Database } from "bun:sqlite"
import { openDb, openSessionMetaDb, openTransientDb } from "./db.js"
import { allJobDbPaths, sessionMetaDbPath, memoryDbPath } from "./paths.js"
import { currentMemoryVersion, MEMORY_VERSIONS, withMemoryVersion } from "./memory-version.js"
import { isProviderCapacityError } from "./ratelimit.js"

export const DEFAULT_RETRY_REMAINING = 3
export const STAGE1_LEASE_SECONDS = 3600
export const PHASE2_LEASE_SECONDS = 3600
export const STAGE1_RETRY_DELAY_SECONDS = 3600
export const PHASE2_RETRY_DELAY_SECONDS = 3600
export const PHASE2_COOLDOWN_MS = 6 * 60 * 60 * 1000
export const STAGE1_CONCURRENCY = 8
export const SCAN_LIMIT = 5000
export const PRUNE_BATCH_SIZE = 200

export type JobKind = "memory_stage1" | "memory_consolidate_global"
export type JobStatus = "pending" | "running" | "done" | "failed"

export interface Stage1Output {
  session_id: string
  source_updated_at: number
  raw_memory: string
  rollout_summary: string
  rollout_slug: string | null
  cwd?: string | null
  generated_at: number
  usage_count: number
  last_usage: number | null
}

export interface Stage1Claim {
  sessionId: string
  ownershipToken: string
}

export interface ClaimableSession {
  id: string
  updated_at: number
}

export type Phase2ClaimResult =
  | { type: "claimed"; workerId: string; ownershipToken: string }
  | { type: "skipped_cooldown" }
  | { type: "skipped_running" }
  | { type: "skipped_retry_unavailable" }

function clearJobTables(db: Database): void {
  db.transaction(() => {
    db.run("DELETE FROM memory_stage1_outputs")
    db.run("DELETE FROM memory_jobs")
    db.run("DELETE FROM memory_citation_usage")
    db.run("UPDATE consolidation_progress SET max_thread_count = 0")
    db
      .prepare(
        `INSERT INTO memory_jobs
          (kind, job_key, status, finished_at, last_error, retry_remaining, last_success_watermark)
         VALUES ('memory_consolidate_global', 'global', 'done', ?, NULL, ?, 0)`,
      )
      .run(nowSec(), DEFAULT_RETRY_REMAINING)
  }).immediate()
}

/** Wipe jobs/outputs in every versioned DB. Leaves memory_session_meta on memory.db. */
export function clearAllVersionMemoryData(): void {
  for (const dbPath of allJobDbPaths()) {
    if (dbPath !== sessionMetaDbPath() && !fs.existsSync(dbPath)) continue
    const db = openTransientDb(dbPath)
    try {
      clearJobTables(db)
    } finally {
      db.close()
    }
  }
}

/** Include inactive existing stores for deletion, reset guards and diagnostics. */
export function existingMemoryStores(): MemoryStore[] {
  return MEMORY_VERSIONS.filter((version) => version === "v1" || fs.existsSync(memoryDbPath(version)))
    .map((version) => withMemoryVersion(version, () => new MemoryStore()))
}

function newId(): string {
  return crypto.randomUUID()
}
/**
 * Phase-2 worker ids embed the owning pid and host so a later boot can tell a
 * live peer's lease from one orphaned by a hard kill (host auto-update/restart).
 */
const PHASE2_WORKER_PREFIX = `pid:${process.pid}@${os.hostname()}:`
export const PHASE2_HEARTBEAT_SECONDS = 90
function phase2WorkerId(): string {
  return `${PHASE2_WORKER_PREFIX}${crypto.randomUUID()}`
}
function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: exists but not ours. Only ESRCH proves it is gone.
    return (err as NodeJS.ErrnoException).code !== "ESRCH"
  }
}
function now(): number {
  return Date.now()
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function failureMessage(error: unknown): string {
  try {
    if (error instanceof Error) return String(error.message ?? "unknown error")
    return String(error ?? "unknown error")
  } catch {
    return "unknown error"
  }
}

export class MemoryStore {
  constructor(
    private db: Database = openDb(),
    private meta: Database = openSessionMetaDb(),
    readonly version = currentMemoryVersion(),
  ) {}

  stage1Outputs(): Stage1Output[] {
    return this.db
      .prepare("SELECT * FROM memory_stage1_outputs ORDER BY source_updated_at DESC")
      .all() as Stage1Output[]
  }

  stage1OutputCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM memory_stage1_outputs").get() as { count: number }).count
  }

  hasStage1Output(sessionId: string): boolean {
    return this.db
      .prepare("SELECT 1 FROM memory_stage1_outputs WHERE session_id = ?")
      .get(sessionId) !== null
  }

  /**
   * Deletes stale rows; snapshots consumed by the last successful Phase 2 are
   * protected. Stalest-first, capped per run (codex PRUNE_BATCH_SIZE).
   */
  pruneStage1Outputs(maxUnusedDays: number): number {
    const cutoff = now() - maxUnusedDays * 24 * 60 * 60 * 1000
    return this.db
      .prepare(
        `DELETE FROM memory_stage1_outputs
         WHERE rowid IN (
           SELECT rowid FROM memory_stage1_outputs
           WHERE selected_for_phase2 = 0
             AND ((last_usage IS NOT NULL AND last_usage < ?)
                  OR (last_usage IS NULL AND source_updated_at < ?))
           ORDER BY COALESCE(last_usage, source_updated_at) ASC, source_updated_at ASC, session_id ASC
           LIMIT ?
         )`,
      )
      .run(cutoff, cutoff, PRUNE_BATCH_SIZE).changes
  }

  upsertStage1Output(out: Omit<Stage1Output, "usage_count" | "last_usage">): boolean {
    const existing = this.db
      .prepare("SELECT source_updated_at FROM memory_stage1_outputs WHERE session_id = ?")
      .get(out.session_id) as { source_updated_at: number } | null
    // codex replaces when the incoming watermark is >= the stored one; only a
    // strictly newer stored row wins.
    if (existing && existing.source_updated_at > out.source_updated_at) {
      return false
    }
    this.db
      .prepare(
        `INSERT INTO memory_stage1_outputs
          (session_id, source_updated_at, raw_memory, rollout_summary, rollout_slug, cwd, generated_at, usage_count, last_usage)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)
         ON CONFLICT(session_id) DO UPDATE SET
           source_updated_at = excluded.source_updated_at,
           raw_memory = excluded.raw_memory,
           rollout_summary = excluded.rollout_summary,
           rollout_slug = excluded.rollout_slug,
           cwd = excluded.cwd,
           generated_at = excluded.generated_at`,
      )
      .run(out.session_id, out.source_updated_at, out.raw_memory, out.rollout_summary, out.rollout_slug, out.cwd ?? null, out.generated_at)
    return true
  }

  recordUsage(sessionIds: string[]): void {
    if (sessionIds.length === 0) return
    // One transaction for the whole batch (codex record_stage1_output_usage).
    // .immediate() like every other write transaction here: take the write
    // lock up front so busy_timeout applies instead of risking a mid-txn
    // upgrade failure under cross-process access.
    const ts = now()
    const stmt = this.db.prepare(
      "UPDATE memory_stage1_outputs SET usage_count = usage_count + 1, last_usage = ? WHERE session_id = ?",
    )
    this.db.transaction(() => {
      for (const id of sessionIds) stmt.run(ts, id)
    }).immediate()
  }

  /**
   * Record citations from a durable assistant message exactly once. V2 can
   * observe the same persisted text through session.text.ended and later
   * context calls, and either observation may happen after a process restart.
   */
  recordUsageOnce(sessionId: string, assistantMessageId: string, citedSessionIds: string[]): string[] {
    const ids = [...new Set(citedSessionIds)]
    if (!sessionId || !assistantMessageId || ids.length === 0) return []
    const fresh: string[] = []
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO memory_citation_usage
        (session_id, assistant_message_id, cited_session_id, recorded_at)
       VALUES (?, ?, ?, ?)`,
    )
    const update = this.db.prepare(
      "UPDATE memory_stage1_outputs SET usage_count = usage_count + 1, last_usage = ? WHERE session_id = ?",
    )
    const ts = now()
    this.db.transaction(() => {
      for (const citedSessionId of ids) {
        const result = insert.run(sessionId, assistantMessageId, citedSessionId, ts)
        if (result.changes === 0) continue
        const updated = update.run(ts, citedSessionId)
        if (updated.changes > 0) {
          fresh.push(citedSessionId)
        } else {
          this.db
            .prepare("DELETE FROM memory_citation_usage WHERE session_id = ? AND assistant_message_id = ? AND cited_session_id = ?")
            .run(sessionId, assistantMessageId, citedSessionId)
        }
      }
    }).immediate()
    return fresh
  }

  claimStage1Jobs(sessions: ClaimableSession[], excludeSession?: string, maxClaimed?: number): Stage1Claim[] {
    const workerId = newId()
    // Cap per-pass claims at codex's max_rollouts_per_startup (max_claimed,
    // default 2, clamp 1-128). codex also uses max_claimed as the
    // cross-process running-jobs cap; execution concurrency is limited
    // separately (STAGE1_CONCURRENCY, codex buffer_unordered(8)).
    const claimCap = Math.max(1, maxClaimed ?? 2)
    const claimed: Stage1Claim[] = []
    const claimOne = this.db.transaction((s: ClaimableSession, ownershipToken: string, lease: number): boolean => {
      const activeRow = this.db
        .prepare("SELECT COUNT(*) AS c FROM memory_jobs WHERE kind='memory_stage1' AND status='running' AND (lease_until IS NULL OR lease_until > ?)")
        .get(nowSec()) as { c: number }
      if (activeRow.c >= claimCap) return false
      // Mirrors codex try_claim_stage1_job: a newer input watermark (session
      // activity) overrides retry backoff and resets exhausted retries; done
      // jobs are reclaimed only when the session advanced past the last
      // success watermark.
      const result = this.db
        .prepare(
          `INSERT INTO memory_jobs
            (kind, job_key, status, worker_id, ownership_token, started_at, lease_until, retry_remaining, input_watermark)
           VALUES ('memory_stage1', ?, 'running', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(kind, job_key) DO UPDATE SET
             status = 'running',
             worker_id = excluded.worker_id,
             ownership_token = excluded.ownership_token,
             started_at = excluded.started_at,
             lease_until = excluded.lease_until,
             finished_at = NULL,
             retry_at = NULL,
             last_error = NULL,
             retry_remaining = CASE
               WHEN excluded.input_watermark > COALESCE(memory_jobs.input_watermark, -1) THEN excluded.retry_remaining
               ELSE memory_jobs.retry_remaining
             END,
             input_watermark = excluded.input_watermark
           WHERE (memory_jobs.status != 'running' OR memory_jobs.lease_until IS NULL OR memory_jobs.lease_until <= excluded.started_at)
             AND (memory_jobs.retry_at IS NULL
                  OR memory_jobs.retry_at <= excluded.started_at
                  OR excluded.input_watermark > COALESCE(memory_jobs.input_watermark, -1))
             AND (memory_jobs.retry_remaining > 0
                  OR excluded.input_watermark > COALESCE(memory_jobs.input_watermark, -1))
             AND (memory_jobs.status != 'done'
                  OR memory_jobs.last_success_watermark IS NULL
                  OR memory_jobs.last_success_watermark < excluded.input_watermark)`,
        )
        .run(s.id, workerId, ownershipToken, nowSec(), lease, DEFAULT_RETRY_REMAINING, s.updated_at)
      return result.changes > 0
    })
    for (const s of sessions) {
      if (s.id === excludeSession) continue
      if (claimed.length >= claimCap) break
      // Per-claim ownership token (codex uses a fresh UUID per claim) so a
      // zombie worker cannot finalize a job another worker re-claimed.
      const ownershipToken = newId()
      const lease = nowSec() + STAGE1_LEASE_SECONDS
      if (claimOne.immediate(s, ownershipToken, lease)) claimed.push({ sessionId: s.id, ownershipToken })
    }
    return claimed
  }

  markStage1Succeeded(sessionId: string, ownershipToken: string, out: Omit<Stage1Output, "usage_count" | "last_usage">): void {
    this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE memory_jobs SET status='done', finished_at=?, lease_until=NULL, last_error=NULL,
            last_success_watermark=?, retry_at=NULL
           WHERE kind='memory_stage1' AND job_key=? AND status='running' AND ownership_token=?`,
        )
        .run(nowSec(), out.source_updated_at, sessionId, ownershipToken)
      // Ownership lost (lease expired, job re-claimed): do not clobber the new
      // owner's output. Mirrors codex mark_stage1_job_succeeded.
      if (res.changes > 0) {
        this.upsertStage1Output(out)
        this.enqueueGlobalConsolidation(out.source_updated_at)
      }
    }).immediate()
  }

  /** Extraction succeeded but produced nothing worth keeping: finish the job and drop any stale output. */
  markStage1SucceededNoOutput(sessionId: string, ownershipToken: string, sourceUpdatedAt: number): void {
    this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE memory_jobs SET status='done', finished_at=?, lease_until=NULL, last_error=NULL,
            last_success_watermark=?, retry_at=NULL
           WHERE kind='memory_stage1' AND job_key=? AND status='running' AND ownership_token=?`,
        )
        .run(nowSec(), sourceUpdatedAt, sessionId, ownershipToken)
      if (res.changes === 0) return
      const deleted = this.db.prepare("DELETE FROM memory_stage1_outputs WHERE session_id = ?").run(sessionId)
      if (deleted.changes > 0) this.enqueueGlobalConsolidation(sourceUpdatedAt)
    }).immediate()
  }

  markStage1Failed(sessionId: string, ownershipToken: string, error: unknown): void {
    const message = failureMessage(error)
    const tNow = nowSec()
    const retryAt = tNow + STAGE1_RETRY_DELAY_SECONDS
    // Quota/rate-limit is transient provider capacity, not a bad transcript.
    // Codex avoids claiming in that state via guard.rs; we cannot read quota,
    // so keep the job pending and do not burn retry_remaining. Claim still
    // honors retry_at, so this cannot tight-loop while quota is down.
    if (isProviderCapacityError(error)) {
      this.db
        .prepare(
          `UPDATE memory_jobs SET
             status = 'pending',
             last_error = ?,
             retry_at = ?,
             finished_at = ?,
             lease_until = NULL
           WHERE kind='memory_stage1' AND job_key=? AND status='running' AND ownership_token=?`,
        )
        .run(message.slice(0, 4000), retryAt, tNow, sessionId, ownershipToken)
      return
    }
    this.db
      .prepare(
        `UPDATE memory_jobs SET
           status = CASE WHEN retry_remaining > 1 THEN 'pending' ELSE 'failed' END,
           retry_remaining = MAX(0, retry_remaining - 1),
           last_error = ?,
           retry_at = ?,
           finished_at = ?,
           lease_until = NULL
         WHERE kind='memory_stage1' AND job_key=? AND status='running' AND ownership_token=?`,
      )
      .run(message.slice(0, 4000), retryAt, tNow, sessionId, ownershipToken)
  }

  /**
   * Re-open stage-1 jobs that exhausted their retry budget solely because of
   * a quota/rate-limit error. Historical completed sessions never get a newer
   * watermark, so without this they stay failed forever after a quota outage.
   * Leaves retry_at alone so an active backoff still holds.
   */
  requeueExhaustedProviderCapacityJobs(): number {
    const rows = this.db
      .prepare(
        `SELECT job_key, last_error FROM memory_jobs
         WHERE kind='memory_stage1' AND status='failed' AND last_error IS NOT NULL`,
      )
      .all() as { job_key: string; last_error: string }[]
    let n = 0
    const stmt = this.db.prepare(
      `UPDATE memory_jobs SET status='pending', retry_remaining=?
       WHERE kind='memory_stage1' AND job_key=? AND status='failed'`,
    )
    this.db.transaction(() => {
      for (const row of rows) {
        if (!isProviderCapacityError(row.last_error)) continue
        n += stmt.run(DEFAULT_RETRY_REMAINING, row.job_key).changes
      }
    }).immediate()
    return n
  }

  /**
   * Plugin dispose/reload: release a claimed stage-1 job without burning a retry
   * or imposing the 1h backoff. Leaves status=pending so the next process can
   * reclaim immediately (unlike markStage1Failed). Ownership-token guarded.
   */
  releaseStage1OnShutdown(sessionId: string, ownershipToken: string): void {
    this.db
      .prepare(
        `UPDATE memory_jobs SET
           status = 'pending',
           last_error = ?,
           retry_at = NULL,
           finished_at = ?,
           lease_until = NULL
         WHERE kind='memory_stage1' AND job_key=? AND status='running' AND ownership_token=?`,
      )
      .run("plugin shutting down", nowSec(), sessionId, ownershipToken)
  }

  /**
   * Enqueues global consolidation after stage-1 state changes. If phase 2 is
   * already running, preserve its lease and advance only the input watermark.
   */
  private enqueueGlobalConsolidation(inputWatermark: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_jobs
          (kind, job_key, status, retry_remaining, input_watermark, last_success_watermark)
         VALUES ('memory_consolidate_global', 'global', 'pending', ?, ?, 0)
         ON CONFLICT(kind, job_key) DO UPDATE SET
           status = CASE
             WHEN memory_jobs.status = 'running' THEN 'running'
             ELSE 'pending'
           END,
           retry_at = CASE
             WHEN memory_jobs.status = 'running' THEN memory_jobs.retry_at
             ELSE NULL
           END,
           retry_remaining = MAX(memory_jobs.retry_remaining, excluded.retry_remaining),
           input_watermark = CASE
             WHEN excluded.input_watermark > COALESCE(memory_jobs.input_watermark, 0)
               THEN excluded.input_watermark
             ELSE COALESCE(memory_jobs.input_watermark, 0) + 1
           END`,
      )
      .run(DEFAULT_RETRY_REMAINING, inputWatermark)
  }

  claimGlobalPhase2Job(opts: { bypassCooldown?: boolean } = {}): Phase2ClaimResult {
    const workerId = phase2WorkerId()
    const ownershipToken = newId()
    const tNow = nowSec()
    const lease = tNow + PHASE2_LEASE_SECONDS
    return this.db
      .transaction((): Phase2ClaimResult => {
        const row = this.db
          .prepare("SELECT * FROM memory_jobs WHERE kind='memory_consolidate_global' AND job_key='global'")
          .get() as
          | {
              status: string
              lease_until: number | null
              retry_at: number | null
              finished_at: number | null
              last_error: string | null
            }
          | null
        if (!row) {
          this.db
            .prepare(
              `INSERT INTO memory_jobs
                (kind, job_key, status, worker_id, ownership_token, started_at, lease_until, retry_remaining)
               VALUES ('memory_consolidate_global', 'global', 'running', ?, ?, ?, ?, ?)`,
            )
            .run(workerId, ownershipToken, tNow, lease, DEFAULT_RETRY_REMAINING)
          return { type: "claimed", workerId, ownershipToken }
        }
        if (row.status === "running" && row.lease_until != null && row.lease_until > tNow) {
          return { type: "skipped_running" }
        }
        // codex: cooldown after a clean success (last_error IS NULL AND
        // finished_at within the window); failures fall through to retry_at.
        if (
          !opts.bypassCooldown &&
          row.last_error == null &&
          row.finished_at != null &&
          tNow - row.finished_at < PHASE2_COOLDOWN_MS / 1000
        ) {
          return { type: "skipped_cooldown" }
        }
        // codex gates on retry_at regardless of status and never exhausts
        // phase-2 retries; retry_remaining is informational only.
        if (row.retry_at != null && row.retry_at > tNow) {
          return { type: "skipped_retry_unavailable" }
        }
        this.db
          .prepare(
            `UPDATE memory_jobs SET
               status='running',
               worker_id=?,
               ownership_token=?,
               started_at=?,
               lease_until=?,
               finished_at=NULL,
               retry_at=NULL,
               last_error=NULL
             WHERE kind='memory_consolidate_global' AND job_key='global'`,
          )
          .run(workerId, ownershipToken, tNow, lease)
        return { type: "claimed", workerId, ownershipToken }
      })
      .immediate()
  }

  heartbeatPhase2Job(ownershipToken: string): boolean {
    const lease = nowSec() + PHASE2_LEASE_SECONDS
    const res = this.db
      .prepare(
        `UPDATE memory_jobs SET lease_until=? WHERE kind='memory_consolidate_global' AND job_key='global' AND ownership_token=? AND status='running'`,
      )
      .run(lease, ownershipToken)
    return res.changes > 0
  }

  /**
   * Marks the phase-2 job done and records exactly which stage-1 snapshots the
   * run consumed (selected_for_phase2), so pruning cannot delete inputs that
   * still back the consolidated artifacts.
   */
  markPhase2Succeeded(ownershipToken: string, selected: Pick<Stage1Output, "session_id" | "source_updated_at">[] = []): void {
    // codex stores the completion watermark = max source_updated_at consumed;
    // the 6h cooldown is keyed on finished_at, not on this value.
    const watermark = selected.reduce((max, s) => Math.max(max, s.source_updated_at), 0)
    // One transaction for the job row + the selected-input flags (codex
    // mark_global_phase2_job_succeeded does the same): a crash between them
    // must not leave a done job whose retention flags still describe the
    // previous run — pruning could then delete inputs backing the artifacts.
    this.db.transaction(() => {
      const res = this.db
        .prepare(
          `UPDATE memory_jobs SET status='done', finished_at=?, lease_until=NULL, last_error=NULL, retry_remaining=?,
             last_success_watermark=MAX(COALESCE(last_success_watermark, 0), ?), retry_at=NULL
           WHERE kind='memory_consolidate_global' AND job_key='global' AND ownership_token=? AND status='running'`,
        )
        .run(nowSec(), DEFAULT_RETRY_REMAINING, watermark, ownershipToken)
      if (res.changes === 0) return
      this.db.prepare("UPDATE consolidation_progress SET max_thread_count = MAX(max_thread_count, ?)")
        .run(new Set(selected.map((s) => s.session_id)).size)
      this.db.run("UPDATE memory_stage1_outputs SET selected_for_phase2 = 0, selected_for_phase2_source_updated_at = NULL")
      const mark = this.db.prepare(
        `UPDATE memory_stage1_outputs
         SET selected_for_phase2 = 1, selected_for_phase2_source_updated_at = ?
         WHERE session_id = ? AND source_updated_at = ?`,
      )
      for (const s of selected) mark.run(s.source_updated_at, s.session_id, s.source_updated_at)
    }).immediate()
  }

  /** High-water mark of distinct sessions consumed by one successful run. */
  maxConsolidatedThreadCount(): number {
    return (this.db.prepare("SELECT max_thread_count FROM consolidation_progress WHERE singleton = 1")
      .get() as { max_thread_count: number }).max_thread_count
  }

  /**
   * Phase-2 job snapshot for memory_inspect. Always returns the global job row
   * when it exists (including failed/running), so diagnostics are not limited
   * to clean successes. `success_finished_at` is set only for a clean success
   * (never a failure timestamp); `last_success_watermark` follows codex
   * (preserved across later attempts; zero only counts while clean).
   */
  phase2JobSnapshot(): {
    status: string
    last_error: string | null
    started_at: number | null
    finished_at: number | null
    retry_at: number | null
    lease_until: number | null
    success_finished_at: number | null
    last_success_watermark: number | null
  } | null {
    const row = this.db
      .prepare(
        `SELECT status, started_at, finished_at, last_error, retry_at, lease_until, last_success_watermark FROM memory_jobs
         WHERE kind='memory_consolidate_global' AND job_key='global'`,
      )
      .get() as {
        status: string
        started_at: number | null
        finished_at: number | null
        last_error: string | null
        retry_at: number | null
        lease_until: number | null
        last_success_watermark: number | null
      } | null
    if (!row) return null
    const cleanSuccess =
      row.last_error === null &&
      row.finished_at !== null &&
      (row.status === "done" || row.status === "pending")
    // Codex initializes pending global jobs with watermark 0, so zero proves a
    // success only while the row itself is a clean completed attempt.
    const watermark =
      row.last_success_watermark === null
        ? null
        : row.last_success_watermark === 0 && !cleanSuccess
          ? null
          : row.last_success_watermark
    return {
      status: row.status,
      last_error: row.last_error,
      started_at: row.started_at,
      finished_at: row.finished_at,
      retry_at: row.retry_at,
      lease_until: row.lease_until,
      // Codex preserves last_success_watermark across later attempts, while the
      // job finished_at describes only the latest attempt. Never label a failure
      // timestamp as a success finish time.
      success_finished_at: cleanSuccess ? row.finished_at : null,
      last_success_watermark: watermark,
    }
  }

  /** Last recorded phase-2 success info. Null when phase 2 never succeeded. */
  phase2LastSuccess(): { finished_at: number | null; last_success_watermark: number | null } | null {
    const snap = this.phase2JobSnapshot()
    if (!snap || snap.last_success_watermark === null) return null
    return {
      finished_at: snap.success_finished_at,
      last_success_watermark: snap.last_success_watermark,
    }
  }

  markPhase2Failed(ownershipToken: string, error: unknown): void {
    const message = failureMessage(error)
    const res = this.db
      .prepare(
        `UPDATE memory_jobs SET
           status = 'failed',
           retry_remaining = MAX(0, retry_remaining - 1),
           last_error = ?,
           retry_at = ?,
           finished_at = ?,
           lease_until = NULL
         WHERE kind='memory_consolidate_global' AND job_key='global' AND ownership_token=? AND status='running'`,
      )
      .run(message.slice(0, 4000), nowSec() + PHASE2_RETRY_DELAY_SECONDS, nowSec(), ownershipToken)
    if (res.changes > 0) return
    // codex mark_global_phase2_job_failed_if_unowned: if the owned update
    // matched nothing, recover a stuck running row that lost its owner
    // (ownership_token NULL) so it does not linger until lease expiry.
    this.db
      .prepare(
        `UPDATE memory_jobs SET
           status = 'failed',
           retry_remaining = MAX(0, retry_remaining - 1),
           last_error = ?,
           retry_at = ?,
           finished_at = ?,
           lease_until = NULL
         WHERE kind='memory_consolidate_global' AND job_key='global' AND status='running' AND ownership_token IS NULL`,
      )
      .run(message.slice(0, 4000), nowSec() + PHASE2_RETRY_DELAY_SECONDS, nowSec())
  }

  /**
   * Plugin dispose/reload: release the global phase-2 job without retry backoff
   * so the next process can reclaim immediately. Ownership-token guarded.
   */
  /**
   * Orphan sweep: a `running` global row whose owning pid is dead can never
   * be finished by anyone; release it so the next pass can reclaim instead of
   * waiting the full lease out. Rows from live pids (a peer instance), rows
   * from another host, rows with a fresh heartbeat (the owner may sit in
   * another pid namespace, e.g. a sandbox sharing memory.db), and rows
   * without a pid tag (older schema) are left alone.
   */
  releaseOrphanedPhase2Job(): boolean {
    const row = this.db
      .prepare(
        `SELECT worker_id, lease_until FROM memory_jobs
         WHERE kind='memory_consolidate_global' AND job_key='global' AND status='running'`,
      )
      .get() as { worker_id: string | null; lease_until: number | null } | null
    const m = row?.worker_id?.match(/^pid:(\d+)(?:@([^:]*))?:/)
    if (!m) return false
    if (m[2] !== undefined && m[2] !== os.hostname()) return false
    if (pidAlive(Number(m[1]))) return false
    const heartbeatFreshAfter = nowSec() + PHASE2_LEASE_SECONDS - 3 * PHASE2_HEARTBEAT_SECONDS
    if (row!.lease_until !== null && row!.lease_until > heartbeatFreshAfter) return false
    const res = this.db
      .prepare(
        `UPDATE memory_jobs SET
           status = 'pending',
           last_error = ?,
           retry_at = NULL,
           finished_at = ?,
           lease_until = NULL,
           ownership_token = NULL
         WHERE kind='memory_consolidate_global' AND job_key='global' AND status='running' AND worker_id=?`,
      )
      .run(`owner pid ${m[1]} exited before finishing`, nowSec(), row!.worker_id)
    return res.changes > 0
  }

  releasePhase2OnShutdown(ownershipToken: string): void {
    this.db
      .prepare(
        `UPDATE memory_jobs SET
           status = 'pending',
           last_error = ?,
           retry_at = NULL,
           finished_at = ?,
           lease_until = NULL
         WHERE kind='memory_consolidate_global' AND job_key='global' AND ownership_token=? AND status='running'`,
      )
      .run("plugin shutting down", nowSec(), ownershipToken)
  }

  /**
   * Phase 2 input set, mirroring codex get_phase2_input_selection:
   * - excludes sessions marked disabled/polluted (their summary files then
   *   disappear from the workspace and the diff drives forgetting)
   * - recency: last_usage when the memory has ever been used, otherwise
   *   source_updated_at
   * - ranked by usage, then recency
   */
  getPhase2InputSelection(maxRaw: number, maxUnusedDays: number): Stage1Output[] {
    const cutoff = now() - maxUnusedDays * 24 * 60 * 60 * 1000
    if (maxRaw <= 0) return []
    const rows = this.db
      .prepare(
        `SELECT so.* FROM memory_stage1_outputs so
         WHERE (length(trim(so.raw_memory)) > 0 OR length(trim(so.rollout_summary)) > 0)
           AND ((so.last_usage IS NOT NULL AND so.last_usage >= ?)
                OR (so.last_usage IS NULL AND so.source_updated_at >= ?))
         ORDER BY COALESCE(so.usage_count, 0) DESC,
                  COALESCE(so.last_usage, so.source_updated_at) DESC,
                  so.source_updated_at DESC,
                   so.session_id DESC`,
      )
      .iterate(cutoff, cutoff)
    const selected: Stage1Output[] = []
    // V2's job DB has no source catalog. Check the shared catalog before
    // counting a row toward the limit, as Codex does against its thread DB.
    for (const value of rows) {
      const row = value as Stage1Output
      const mode = this.getMemoryMode(row.session_id)
      if (mode !== null && mode !== "enabled") continue
      selected.push(row)
      if (selected.length >= maxRaw) break
    }
    return selected
  }

  /**
   * Mirrors codex delete_thread_memory: remove a deleted session's output and
   * job, then enqueue forgetting if phase 2 had consumed that output.
   */
  deleteSessionMemory(sessionId: string): boolean {
    return this.db.transaction((): boolean => {
      const existing = this.db
        .prepare("SELECT selected_for_phase2 FROM memory_stage1_outputs WHERE session_id = ?")
        .get(sessionId) as { selected_for_phase2: number } | null
      const deleted = this.db.prepare("DELETE FROM memory_stage1_outputs WHERE session_id = ?").run(sessionId)
      this.db.prepare("DELETE FROM memory_jobs WHERE kind='memory_stage1' AND job_key = ?").run(sessionId)
      const shouldConsolidate =
        deleted.changes > 0 && existing !== null && existing.selected_for_phase2 !== 0
      if (shouldConsolidate) this.enqueueGlobalConsolidation(now())
      return shouldConsolidate
    }).immediate()
  }

  /**
   * codex clear_memory_data deletes extracted memories and jobs but explicitly
   * preserves per-session memory modes: a reset must not re-enable sessions
   * the user disabled or that were marked polluted.
   *
   * After the wipe, leave a phase-2 cooldown marker (status=done, finished_at
   * now, last_error NULL). Without it, the next idle/chat hook first-run-claims
   * phase 2 on an empty DB and ensureLayout re-seeds the just-wiped root —
   * memory_reset then looks like a no-op to the caller. Codex avoids this
   * because reset is a client RPC outside the write-pipeline pump; the plugin
   * surface is model-invoked mid-session, so hooks can race the wipe.
   */
  clearMemoryData(): void {
    clearJobTables(this.db)
  }

  setMemoryMode(sessionId: string, mode: "enabled" | "disabled" | "polluted"): void {
    this.meta
      .prepare(
        `INSERT INTO memory_session_meta (session_id, memory_mode, polluted, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET memory_mode=excluded.memory_mode, polluted=excluded.polluted, updated_at=excluded.updated_at`,
      )
      .run(sessionId, mode, mode === "polluted" ? 1 : 0, now())
  }

  /**
   * Stamp a mode only when the session has no meta row yet — used to mark
   * sessions seen while generate_memories=false as permanently 'disabled'
   * (codex stamps memory_mode at thread creation, session.rs), without
   * overriding an explicit user-set or polluted mode.
   */
  stampMemoryModeIfAbsent(sessionId: string, mode: "enabled" | "disabled"): void {
    this.meta
      .prepare(
        `INSERT OR IGNORE INTO memory_session_meta (session_id, memory_mode, polluted, updated_at)
         VALUES (?, ?, 0, ?)`,
      )
      .run(sessionId, mode, now())
  }

  getMemoryMode(sessionId: string): "enabled" | "disabled" | "polluted" | null {
    const row = this.meta
      .prepare("SELECT memory_mode AS mode FROM memory_session_meta WHERE session_id = ?")
      .get(sessionId) as { mode: "enabled" | "disabled" | "polluted" } | null
    return row?.mode ?? null
  }

  markPolluted(sessionId: string): void {
    this.meta
      .prepare(
        `INSERT INTO memory_session_meta (session_id, memory_mode, polluted, updated_at)
         VALUES (?, 'polluted', 1, ?)
         ON CONFLICT(session_id) DO UPDATE SET polluted=1, memory_mode='polluted', updated_at=excluded.updated_at`,
      )
      .run(sessionId, now())
    // codex mark_thread_memory_mode_polluted: a consumed output must be
    // forgotten on the next pass, not after a pending phase-2 retry backoff.
    // Session meta is shared, so every writer that consumed it re-queues.
    for (const store of existingMemoryStores()) store.enqueueIfSelected(sessionId)
  }

  private enqueueIfSelected(sessionId: string): void {
    const row = this.db
      .prepare("SELECT selected_for_phase2 FROM memory_stage1_outputs WHERE session_id = ?")
      .get(sessionId) as { selected_for_phase2: number } | null
    if (row && row.selected_for_phase2 !== 0) this.enqueueGlobalConsolidation(now())
  }

  isPolluted(sessionId: string): boolean {
    const row = this.meta
      .prepare("SELECT polluted AS p FROM memory_session_meta WHERE session_id = ?")
      .get(sessionId) as { p: number } | null
    return row?.p === 1
  }

  /**
   * Stage-1 job counts + recent failures for memory_inspect. Helps diagnose
   * "nothing is learning" without reading the raw jobs table.
   *
   * `staleBeforeSec`: exhausted jobs finished before this unix-seconds cutoff
   * (typically now − max_rollout_age_days) are counted in `stale_exhausted`
   * and omitted from `recent_errors` so leftover rows from old plugin
   * versions do not bury live due/backoff failures.
   */
  stage1JobSnapshot(staleBeforeSec?: number): {
    by_status: Record<string, number>
    by_failure_class: { backoff: number; provider_capacity: number; other_exhausted: number; due: number }
    stale_exhausted: number
    recent_errors: Stage1RecentError[]
  } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS c FROM memory_jobs WHERE kind='memory_stage1' GROUP BY status")
      .all() as { status: string; c: number }[]
    const by_status: Record<string, number> = {}
    for (const r of rows) by_status[r.status] = r.c
    const tNow = nowSec()
    const errorRows = this.db
      .prepare(
        `SELECT job_key AS session_id, last_error, retry_at, status, retry_remaining, finished_at FROM memory_jobs
         WHERE kind='memory_stage1' AND last_error IS NOT NULL
         ORDER BY COALESCE(finished_at, started_at, 0) DESC`,
      )
      .all() as {
        session_id: string
        last_error: string
        retry_at: number | null
        status: string
        retry_remaining: number
        finished_at: number | null
      }[]
    const by_failure_class = { backoff: 0, provider_capacity: 0, other_exhausted: 0, due: 0 }
    const live: Stage1RecentError[] = []
    let stale_exhausted = 0
    for (const row of errorRows) {
      const failure_class = classifyStage1Failure(row, tNow)
      if (failure_class) by_failure_class[failure_class]++
      const entry: Stage1RecentError = {
        session_id: row.session_id,
        last_error: row.last_error,
        retry_at: row.retry_at,
        status: row.status,
        retry_remaining: row.retry_remaining,
        failure_class,
      }
      if (isStaleExhausted(row, staleBeforeSec)) {
        stale_exhausted++
        continue
      }
      live.push(entry)
    }
    live.sort((a, b) => liveErrorRank(a.failure_class) - liveErrorRank(b.failure_class))
    return { by_status, by_failure_class, stale_exhausted, recent_errors: live.slice(0, 5) }
  }
}

export type Stage1FailureClass = "backoff" | "provider_capacity" | "other_exhausted" | "due"

export interface Stage1RecentError {
  session_id: string
  last_error: string
  retry_at: number | null
  status: string
  retry_remaining: number
  failure_class: Stage1FailureClass | null
}

function liveErrorRank(klass: Stage1FailureClass | null): number {
  if (klass === "due") return 0
  if (klass === "backoff") return 1
  if (klass === "provider_capacity") return 2
  if (klass === "other_exhausted") return 3
  return 4
}

function isStaleExhausted(
  row: { status: string; retry_remaining: number; finished_at: number | null; retry_at: number | null },
  staleBeforeSec: number | undefined,
): boolean {
  if (staleBeforeSec == null) return false
  if (row.status !== "failed" && row.retry_remaining > 0) return false
  const ts = row.finished_at ?? row.retry_at ?? 0
  return ts > 0 && ts < staleBeforeSec
}

function classifyStage1Failure(
  row: { status: string; last_error: string; retry_at: number | null; retry_remaining: number },
  nowSec: number,
): Stage1FailureClass | null {
  if (row.status === "failed" || row.retry_remaining <= 0) {
    return isProviderCapacityError(row.last_error) ? "provider_capacity" : "other_exhausted"
  }
  if (row.retry_at != null && row.retry_at > nowSec) return "backoff"
  if (row.retry_at != null && row.retry_at <= nowSec) return "due"
  if (isProviderCapacityError(row.last_error)) return "provider_capacity"
  return null
}
