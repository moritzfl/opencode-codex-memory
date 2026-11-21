import { MemoryStore, STAGE1_CONCURRENCY } from "./store.js"
import { loadTranscript, selectEligibleSessions } from "./capture.js"
import { serializeTieredInput } from "./rollout-input.js"
import { redact, isMemoryExcludedFragment } from "./redact.js"
import { stripCitations } from "./citation.js"
import { extractViaSubagent, MAX_TRANSCRIPT_BYTES, SubagentCancelledError } from "./llm.js"
import { checkRateLimit, isProviderCapacityBlocked, markRateLimitUsed, ProviderCapacityError } from "./ratelimit.js"
import { isPluginShuttingDown } from "./lifecycle.js"
import { recordDiagnostic } from "./diagnostics.js"
import { currentMemoryVersion, withMemoryVersion } from "./memory-version.js"
import { truncateToBytes } from "./token.js"

const V2_SUMMARY_MAX_BYTES = 9_000

export interface Phase1Options {
  maxAgeDays: number
  minIdleHours: number
  // Max rollouts claimed per pass (codex max_rollouts_per_startup / max_claimed).
  maxClaimed?: number
  // Retention for stale stage-1 outputs (codex max_unused_days); pruning runs
  // before the rate gate because it costs no tokens (codex start.rs).
  maxUnusedDays?: number
  excludeSession?: string
  extractModel?: string
}

export const DEFAULT_PHASE1_OPTIONS: Phase1Options = {
  maxAgeDays: 10,
  minIdleHours: 6,
  maxClaimed: 2,
  maxUnusedDays: 30,
}

export async function runPhase1(
  store: MemoryStore,
  opts: Phase1Options = DEFAULT_PHASE1_OPTIONS,
  rateLimitCheck: typeof checkRateLimit = checkRateLimit,
): Promise<void> {
  return withMemoryVersion(store.version, () => runVersionPhase1(store, opts, rateLimitCheck))
}

async function runVersionPhase1(
  store: MemoryStore,
  opts: Phase1Options,
  rateLimitCheck: typeof checkRateLimit,
): Promise<void> {
  if (isPluginShuttingDown()) return
  // Prune first (no tokens), matching codex start.rs ordering before the gate.
  store.pruneStage1Outputs(opts.maxUnusedDays ?? 30)
  // Historical quota-exhausted jobs never get a newer watermark; reopen them
  // before the gate so a later unblocked pass can claim them.
  const requeued = store.requeueExhaustedProviderCapacityJobs()
  if (requeued > 0) {
    recordDiagnostic("info", "phase1", `requeued ${requeued} quota-exhausted job(s)`)
  }
  const extractModel = opts.extractModel
  const rl = await rateLimitCheck("phase1", extractModel)
  if (!rl.ok) {
    console.warn("[opencode-codex-memory] skipping phase1 due to rate limit:", rl.reason)
    return
  }
  const eligible = await selectEligibleSessions(store, opts)
  if (eligible.length === 0) return
  const claimed = store.claimStage1Jobs(eligible, opts.excludeSession, opts.maxClaimed)
  // Empty claim: do not stamp the process timer (codex only metrics
  // skipped_no_candidates and leaves the next startup free to try again).
  if (claimed.length === 0) {
    // eligible ≠ claimable: already done at this watermark, exhausted retries,
    // or lease held. Surface that so inspect is not "memory stuck".
    recordDiagnostic(
      "info",
      "phase1",
      `no claims (eligible=${eligible.length}; already extracted, in backoff, or at claim cap)`,
    )
    return
  }
  markRateLimitUsed("phase1")
  recordDiagnostic("info", "phase1", `claimed ${claimed.length} session(s)`)
  const sessionById = new Map(eligible.map((s) => [s.id, s]))

  await runPool(claimed, STAGE1_CONCURRENCY, async (claim) => {
    const sid = claim.sessionId
    // dispose mid-pass: release the claim without burning a retry or waiting
    // for the 1h lease — otherwise jobs stay `running` until lease expiry.
    if (isPluginShuttingDown()) {
      store.releaseStage1OnShutdown(sid, claim.ownershipToken)
      return
    }
    // Sibling jobs in this pass: do not call a model after quota was observed
    // for every model in the chain.
    if (isProviderCapacityBlocked("phase1", extractModel)) {
      store.markStage1Failed(sid, claim.ownershipToken, new ProviderCapacityError("provider capacity exhausted"))
      return
    }
    try {
      const session = sessionById.get(sid)
      const sourceUpdatedAt = session?.updated_at ?? Date.now()
      const transcript = await prepareTranscript(sid)
      if (isPluginShuttingDown()) {
        store.releaseStage1OnShutdown(sid, claim.ownershipToken)
        return
      }
      if (!transcript) {
        // A newly empty chat is a legitimate no-output result. An existing
        // extraction plus an empty API success is anomalous: retry instead of
        // permanently forgetting memory because of a transient host glitch.
        if (store.hasStage1Output(sid)) {
          throw new Error(`empty transcript for previously extracted session ${sid}`)
        }
        store.markStage1SucceededNoOutput(sid, claim.ownershipToken, sourceUpdatedAt)
        return
      }
      const result = await extractViaSubagent(sid, transcript, {
        cwd: session?.directory ?? undefined,
        model: extractModel,
      })
      // Finalize after a completed model call even if dispose raced, so the
      // claim does not sit `running` until lease expiry. The mark is token +
      // status guarded: if shutdown already released the job and a new process
      // reclaimed it, this becomes a no-op (paid work dropped, never double-written).
      if (!result) {
        // Extractor judged the session not worth remembering.
        store.markStage1SucceededNoOutput(sid, claim.ownershipToken, sourceUpdatedAt)
        return
      }
      const summary =
        currentMemoryVersion() === "v2"
          ? truncateToBytes(redact(result.rollout_summary), V2_SUMMARY_MAX_BYTES)
          : redact(result.rollout_summary)
      store.markStage1Succeeded(sid, claim.ownershipToken, {
        session_id: sid,
        source_updated_at: sourceUpdatedAt,
        raw_memory: currentMemoryVersion() === "v2" ? "" : redact(result.raw_memory),
        rollout_summary: summary,
        // codex redacts the slug too — it becomes a filename.
        rollout_slug: result.rollout_slug ? redact(result.rollout_slug) : result.rollout_slug,
        cwd: session?.directory ?? null,
        generated_at: Date.now(),
      })
    } catch (err) {
      // Aborted mid-extract on dispose (shutdown signal / flag): release for
      // immediate reclaim, do not burn a retry or impose the 1h failure backoff.
      // Quota backoff is per model, noted by the extraction fallback chain.
      if (err instanceof SubagentCancelledError || isPluginShuttingDown()) {
        store.releaseStage1OnShutdown(sid, claim.ownershipToken)
      } else {
        store.markStage1Failed(sid, claim.ownershipToken, err)
      }
    }
  })
}

export async function buildTranscript(sessionId: string): Promise<string> {
  return (await prepareTranscript(sessionId))?.(MAX_TRANSCRIPT_BYTES) ?? ""
}

async function prepareTranscript(sessionId: string): Promise<((limit: number) => string) | null> {
  const msgs = await loadTranscript(sessionId)
  if (msgs.length === 0) return null
  if (currentMemoryVersion() === "v2") {
    const render = (limit: number) => redact(stripCitations(serializeTieredInput(msgs, limit)))
    const initial = render(MAX_TRANSCRIPT_BYTES)
    return initial.trim() ? (limit) => (Buffer.byteLength(initial) <= limit ? initial : render(limit)) : null
  }
  const lines: string[] = []
  for (const m of msgs) {
    if (m.type === "system") continue
    // codex sanitize_response_item_for_memories drops developer-role messages
    // entirely (injected instructions, not conversation). opencode 1.17 only
    // stores user/assistant roles; this guards future role additions.
    if (m.role === "developer") continue
    const role = m.role ?? m.type
    const text = m.text ?? ""
    if (!text.trim()) continue
    // Injected AGENTS.md/<skill> blocks in user content are excluded from
    // extraction (codex is_memory_excluded_contextual_user_fragment).
    if (role === "user" && isMemoryExcludedFragment(text)) continue
    lines.push(`### ${role}\n${redact(stripCitations(text))}`)
  }
  const full = lines.join("\n\n")
  return full ? (limit) => truncateToBytes(full, limit) : null
}

async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}
