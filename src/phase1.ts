import { MemoryStore, STAGE1_CONCURRENCY } from "./store.js"
import { loadTranscript, selectEligibleSessions } from "./capture.js"
import { redact } from "./redact.js"
import { stripCitations } from "./citation.js"
import { extractViaSubagent } from "./llm.js"
import { checkRateLimit } from "./ratelimit.js"

export interface Phase1Options {
  maxAgeDays: number
  minIdleHours: number
  excludeSession?: string
  extractModel?: string
}

export const DEFAULT_PHASE1_OPTIONS: Phase1Options = {
  maxAgeDays: 14,
  minIdleHours: 1,
}

const TRANSCRIPT_MAX_CHARS = 200_000
// When truncating, keep the head and the tail: the start carries the user's
// framing, the end carries the final outcome and feedback.
const TRANSCRIPT_HEAD_CHARS = 120_000
const TRANSCRIPT_TAIL_CHARS = 80_000

export async function runPhase1(store: MemoryStore, opts: Phase1Options = DEFAULT_PHASE1_OPTIONS): Promise<void> {
  const rl = await checkRateLimit("phase1")
  if (!rl.ok) {
    console.warn("[opencode-memex] skipping phase1 due to rate limit:", rl.reason)
    return
  }
  const eligible = selectEligibleSessions(store, opts)
  if (eligible.length === 0) return
  const claimed = store.claimStage1Jobs(eligible, opts.excludeSession)
  if (claimed.length === 0) return
  const sessionById = new Map(eligible.map((s) => [s.id, s]))

  await runPool(claimed, STAGE1_CONCURRENCY, async (sid) => {
    try {
      const session = sessionById.get(sid)
      const sourceUpdatedAt = session?.updated_at ?? Date.now()
      const transcript = buildTranscript(sid)
      if (!transcript.trim()) {
        store.markStage1SucceededNoOutput(sid, sourceUpdatedAt)
        return
      }
      const result = await extractViaSubagent(sid, transcript, {
        cwd: session?.directory ?? undefined,
        model: opts.extractModel,
      })
      if (!result) {
        // Extractor judged the session not worth remembering.
        store.markStage1SucceededNoOutput(sid, sourceUpdatedAt)
        return
      }
      store.markStage1Succeeded(sid, {
        session_id: sid,
        source_updated_at: sourceUpdatedAt,
        raw_memory: redact(result.raw_memory),
        rollout_summary: redact(result.rollout_summary),
        rollout_slug: result.rollout_slug,
        cwd: session?.directory ?? null,
        generated_at: Date.now(),
      })
    } catch (err) {
      store.markStage1Failed(sid, (err as Error).message)
    }
  })
}

function buildTranscript(sessionId: string): string {
  const msgs = loadTranscript(sessionId)
  if (msgs.length === 0) return ""
  const lines: string[] = []
  for (const m of msgs) {
    if (m.type === "system") continue
    const role = m.role ?? m.type
    const text = m.text ?? ""
    if (!text.trim()) continue
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