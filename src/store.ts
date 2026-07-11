import type { Database } from "bun:sqlite"
import { openDb } from "./db.js"

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

function newId(): string {
  return crypto.randomUUID()
}
function now(): number {
  return Date.now()
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export class MemoryStore {
  constructor(private db: Database = openDb()) {}

  stage1Outputs(): Stage1Output[] {
    return this.db
      .prepare("SELECT * FROM memory_stage1_outputs ORDER BY source_updated_at DESC")
      .all() as Stage1Output[]
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
           ORDER BY COALESCE(last_usage, source_updated_at) ASC
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
    const ts = now()
    const stmt = this.db.prepare(
      "UPDATE memory_stage1_outputs SET usage_count = usage_count + 1, last_usage = ? WHERE session_id = ?",
    )
    for (const id of sessionIds) stmt.run(ts, id)
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

  markStage1Failed(sessionId: string, ownershipToken: string, error: string): void {
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
      .run(error.slice(0, 4000), nowSec() + STAGE1_RETRY_DELAY_SECONDS, nowSec(), sessionId, ownershipToken)
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

  claimGlobalPhase2Job(): Phase2ClaimResult {
    const workerId = newId()
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
        if (row.last_error == null && row.finished_at != null && tNow - row.finished_at < PHASE2_COOLDOWN_MS / 1000) {
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
    const res = this.db
      .prepare(
        `UPDATE memory_jobs SET status='done', finished_at=?, lease_until=NULL, last_error=NULL, retry_remaining=?,
           last_success_watermark=MAX(COALESCE(last_success_watermark, 0), ?), retry_at=NULL
         WHERE kind='memory_consolidate_global' AND job_key='global' AND ownership_token=? AND status='running'`,
      )
      .run(nowSec(), DEFAULT_RETRY_REMAINING, watermark, ownershipToken)
    if (res.changes === 0) return
    this.db.exec("UPDATE memory_stage1_outputs SET selected_for_phase2 = 0, selected_for_phase2_source_updated_at = NULL")
    const mark = this.db.prepare(
      `UPDATE memory_stage1_outputs
       SET selected_for_phase2 = 1, selected_for_phase2_source_updated_at = ?
       WHERE session_id = ? AND source_updated_at = ?`,
    )
    for (const s of selected) mark.run(s.source_updated_at, s.session_id, s.source_updated_at)
  }

  markPhase2Failed(ownershipToken: string, error: string): void {
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
      .run(error.slice(0, 4000), nowSec() + PHASE2_RETRY_DELAY_SECONDS, nowSec(), ownershipToken)
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
      .run(error.slice(0, 4000), nowSec() + PHASE2_RETRY_DELAY_SECONDS, nowSec())
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
    return this.db
      .prepare(
        `SELECT so.* FROM memory_stage1_outputs so
         LEFT JOIN memory_session_meta m ON m.session_id = so.session_id
         WHERE (m.memory_mode IS NULL OR m.memory_mode = 'enabled')
           AND (length(trim(so.raw_memory)) > 0 OR length(trim(so.rollout_summary)) > 0)
           AND ((so.last_usage IS NOT NULL AND so.last_usage >= ?)
                OR (so.last_usage IS NULL AND so.source_updated_at >= ?))
         ORDER BY COALESCE(so.usage_count, 0) DESC,
                  COALESCE(so.last_usage, so.source_updated_at) DESC,
                  so.source_updated_at DESC,
                  so.session_id DESC
         LIMIT ?`,
      )
      .all(cutoff, cutoff, maxRaw) as Stage1Output[]
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
   */
  clearMemoryData(): void {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM memory_stage1_outputs")
      this.db.exec("DELETE FROM memory_jobs")
    }).immediate()
  }

  setMemoryMode(sessionId: string, mode: "enabled" | "disabled" | "polluted"): void {
    this.db
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
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_session_meta (session_id, memory_mode, polluted, updated_at)
         VALUES (?, ?, 0, ?)`,
      )
      .run(sessionId, mode, now())
  }

  getMemoryMode(sessionId: string): "enabled" | "disabled" | "polluted" | null {
    const row = this.db
      .prepare("SELECT memory_mode AS mode FROM memory_session_meta WHERE session_id = ?")
      .get(sessionId) as { mode: "enabled" | "disabled" | "polluted" } | null
    return row?.mode ?? null
  }

  markPolluted(sessionId: string): void {
    this.db
      .prepare(
        `INSERT INTO memory_session_meta (session_id, memory_mode, polluted, updated_at)
         VALUES (?, 'polluted', 1, ?)
         ON CONFLICT(session_id) DO UPDATE SET polluted=1, memory_mode='polluted', updated_at=excluded.updated_at`,
      )
      .run(sessionId, now())
  }

  isPolluted(sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT polluted AS p FROM memory_session_meta WHERE session_id = ?")
      .get(sessionId) as { p: number } | null
    return row?.p === 1
  }
}