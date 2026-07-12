import { MemoryStore, STAGE1_CONCURRENCY } from "./store.js"
import { loadTranscript, selectEligibleSessions } from "./capture.js"
import { redact, isMemoryExcludedFragment } from "./redact.js"
import { stripCitations } from "./citation.js"
import { extractViaSubagent } from "./llm.js"
import { checkRateLimit } from "./ratelimit.js"

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

// codex serializes the full transcript and truncates at 70% of the model
// context window, falling back to 150k tokens; ~4 chars/token puts the
// char-estimate equivalent at 600k.
const TRANSCRIPT_MAX_CHARS = 600_000
// When truncating, keep the head and the tail: the start carries the user's
// framing, the end carries the final outcome and feedback. codex splits the
// budget 50/50 between head and tail (truncate.rs split_budget).
const TRANSCRIPT_HEAD_CHARS = 300_000
const TRANSCRIPT_TAIL_CHARS = 300_000

export async function runPhase1(store: MemoryStore, opts: Phase1Options = DEFAULT_PHASE1_OPTIONS): Promise<void> {
  store.pruneStage1Outputs(opts.maxUnusedDays ?? 30)
  const rl = await checkRateLimit("phase1")
  if (!rl.ok) {
    console.warn("[opencode-codex-memory] skipping phase1 due to rate limit:", rl.reason)
    return
  }
  const eligible = await selectEligibleSessions(store, opts)
  if (eligible.length === 0) return
  const claimed = store.claimStage1Jobs(eligible, opts.excludeSession, opts.maxClaimed)
  if (claimed.length === 0) return
  const sessionById = new Map(eligible.map((s) => [s.id, s]))

  await runPool(claimed, STAGE1_CONCURRENCY, async (claim) => {
    const sid = claim.sessionId
    try {
      const session = sessionById.get(sid)
      const sourceUpdatedAt = session?.updated_at ?? Date.now()
      const transcript = await buildTranscript(sid)
      if (!transcript.trim()) {
        store.markStage1SucceededNoOutput(sid, claim.ownershipToken, sourceUpdatedAt)
        return
      }
      const result = await extractViaSubagent(sid, transcript, {
        cwd: session?.directory ?? undefined,
        model: opts.extractModel,
      })
      if (!result) {
        // Extractor judged the session not worth remembering.
        store.markStage1SucceededNoOutput(sid, claim.ownershipToken, sourceUpdatedAt)
        return
      }
      store.markStage1Succeeded(sid, claim.ownershipToken, {
        session_id: sid,
        source_updated_at: sourceUpdatedAt,
        raw_memory: redact(result.raw_memory),
        rollout_summary: redact(result.rollout_summary),
        // codex redacts the slug too — it becomes a filename.
        rollout_slug: result.rollout_slug ? redact(result.rollout_slug) : result.rollout_slug,
        cwd: session?.directory ?? null,
        generated_at: Date.now(),
      })
    } catch (err) {
      store.markStage1Failed(sid, claim.ownershipToken, (err as Error).message)
    }
  })
}

export async function buildTranscript(sessionId: string): Promise<string> {
  const msgs = await loadTranscript(sessionId)
  if (msgs.length === 0) return ""
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
  if (full.length <= TRANSCRIPT_MAX_CHARS) return full
  return (
    full.slice(0, TRANSCRIPT_HEAD_CHARS) +
    "\n\n[... transcript truncated ...]\n\n" +
    full.slice(full.length - TRANSCRIPT_TAIL_CHARS)
  )
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