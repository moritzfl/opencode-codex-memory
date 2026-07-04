import type { Database } from "bun:sqlite"
import { openDb } from "./db.js"

export const DEFAULT_RETRY_REMAINING = 3
export const STAGE1_LEASE_SECONDS = 3600
export const PHASE2_LEASE_SECONDS = 1800
export const PHASE2_COOLDOWN_MS = 6 * 60 * 60 * 1000
export const STAGE1_CONCURRENCY = 8
export const SCAN_LIMIT = 5000

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

export type ClaimResult =
  | { type: "claimed"; sessionId: string; workerId: string; ownershipToken: string }
  | { type: "skipped" }

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

  /** Deletes stale rows; snapshots consumed by the last successful Phase 2 are protected. */
  pruneStage1Outputs(maxUnusedDays: number): number {
    const cutoff = now() - maxUnusedDays * 24 * 60 * 60 * 1000
    return this.db
      .prepare(
        `DELETE FROM memory_stage1_outputs
         WHERE selected_for_phase2 = 0
           AND ((last_usage IS NOT NULL AND last_usage < ?)
                OR (last_usage IS NULL AND source_updated_at < ?))`,
      )
      .run(cutoff, cutoff).changes
  }

  upsertStage1Output(out: Omit<Stage1Output, "usage_count" | "last_usage">): boolean {
    const existing = this.db
      .prepare("SELECT source_updated_at FROM memory_stage1_outputs WHERE session_id = ?")
      .get(out.session_id) as { source_updated_at: number } | null
    if (existing && existing.source_updated_at >= out.source_updated_at) {
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

  claimStage1Jobs(sessions: ClaimableSession[], excludeSession?: string, maxClaimed?: number): string[] {
    const workerId = newId()
    const ownershipToken = newId()
    const lease = nowSec() + STAGE1_LEASE_SECONDS
    // Cap per-pass claims at codex's max_rollouts_per_startup (max_claimed) when
    // provided, never exceeding the hard concurrency ceiling.
    const claimCap = Math.max(1, Math.min(maxClaimed ?? STAGE1_CONCURRENCY, STAGE1_CONCURRENCY))
    const claimed: string[] = []
    for (const s of sessions) {
      if (s.id === excludeSession) continue
      if (claimed.length >= claimCap) break
      const activeRow = this.db
        .prepare("SELECT COUNT(*) AS c FROM memory_jobs WHERE kind='memory_stage1' AND status='running' AND (lease_until IS NULL OR lease_until > ?)")
        .get(nowSec()) as { c: number }
      if (activeRow.c >= STAGE1_CONCURRENCY) break
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
      if (result.changes > 0) claimed.push(s.id)
    }
    return claimed
  }

  markStage1Succeeded(sessionId: string, out: Omit<Stage1Output, "usage_count" | "last_usage">): void {
    this.upsertStage1Output(out)
    this.db
      .prepare(
        `UPDATE memory_jobs SET status='done', finished_at=?, lease_until=NULL, last_error=NULL,
          last_success_watermark=?, retry_at=NULL
         WHERE kind='memory_stage1' AND job_key=?`,
      )
      .run(nowSec(), out.source_updated_at, sessionId)
  }

  /** Extraction succeeded but produced nothing worth keeping: finish the job and drop any stale output. */
  markStage1SucceededNoOutput(sessionId: string, sourceUpdatedAt: number): void {
    this.db
      .prepare(
        `UPDATE memory_jobs SET status='done', finished_at=?, lease_until=NULL, last_error=NULL,
          last_success_watermark=?, retry_at=NULL
         WHERE kind='memory_stage1' AND job_key=?`,
      )
      .run(nowSec(), sourceUpdatedAt, sessionId)
    this.db.prepare("DELETE FROM memory_stage1_outputs WHERE session_id = ?").run(sessionId)
  }

  markStage1Failed(sessionId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE memory_jobs SET
           status = CASE WHEN retry_remaining > 1 THEN 'pending' ELSE 'failed' END,
           retry_remaining = MAX(0, retry_remaining - 1),
           last_error = ?,
           retry_at = ?,
           finished_at = ?,
           lease_until = NULL
         WHERE kind='memory_stage1' AND job_key=?`,
      )
      .run(error.slice(0, 4000), nowSec() + 60 * 5, nowSec(), sessionId)
  }

  claimGlobalPhase2Job(): Phase2ClaimResult {
    const workerId = newId()
    const ownershipToken = newId()
    const lease = nowSec() + PHASE2_LEASE_SECONDS
    const nowMs = now()
    const row = this.db
      .prepare("SELECT * FROM memory_jobs WHERE kind='memory_consolidate_global' AND job_key='global'")
      .get() as
      | {
          status: string
          lease_until: number | null
          retry_at: number | null
          retry_remaining: number
          finished_at: number | null
          last_success_watermark: number | null
        }
      | null
    if (!row) {
      this.db
        .prepare(
          `INSERT INTO memory_jobs
            (kind, job_key, status, worker_id, ownership_token, started_at, lease_until, retry_remaining)
           VALUES ('memory_consolidate_global', 'global', 'running', ?, ?, ?, ?, ?)`,
        )
        .run(workerId, ownershipToken, nowSec(), lease, DEFAULT_RETRY_REMAINING)
      return { type: "claimed", workerId, ownershipToken }
    }
    if (row.status === "running" && row.lease_until != null && row.lease_until > nowSec()) {
      return { type: "skipped_running" }
    }
    if (row.status === "done" && row.last_success_watermark != null && nowMs - row.last_success_watermark < PHASE2_COOLDOWN_MS) {
      return { type: "skipped_cooldown" }
    }
    if (row.status === "failed" && row.retry_remaining <= 0) {
      return { type: "skipped_retry_unavailable" }
    }
    if (row.status === "failed" && row.retry_at != null && row.retry_at > nowSec()) {
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
           retry_remaining=?,
           last_error=NULL
         WHERE kind='memory_consolidate_global' AND job_key='global'`,
      )
      .run(workerId, ownershipToken, nowSec(), lease, DEFAULT_RETRY_REMAINING)
    return { type: "claimed", workerId, ownershipToken }
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
    const res = this.db
      .prepare(
        `UPDATE memory_jobs SET status='done', finished_at=?, last_error=NULL, last_success_watermark=?, retry_at=NULL
         WHERE kind='memory_consolidate_global' AND job_key='global' AND ownership_token=?`,
      )
      .run(nowSec(), now(), ownershipToken)
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
    this.db
      .prepare(
        `UPDATE memory_jobs SET
           status = CASE WHEN retry_remaining > 1 THEN 'pending' ELSE 'failed' END,
           retry_remaining = MAX(0, retry_remaining - 1),
           last_error = ?,
           retry_at = ?,
           finished_at = ?
         WHERE kind='memory_consolidate_global' AND job_key='global' AND ownership_token=?`,
      )
      .run(error.slice(0, 4000), nowSec() + 60 * 10, nowSec(), ownershipToken)
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

  clearMemoryData(): void {
    this.db.exec("DELETE FROM memory_stage1_outputs")
    this.db.exec("DELETE FROM memory_jobs")
    this.db.exec("DELETE FROM memory_session_meta")
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