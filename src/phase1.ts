import { MemoryStore, STAGE1_CONCURRENCY } from "./store.js"
import { loadTranscript, selectEligibleSessions } from "./capture.js"
import { redact } from "./redact.js"
import { extractViaSubagent } from "./llm.js"

export interface Phase1Options {
  maxAgeDays: number
  minIdleHours: number
  excludeSession?: string
}

export const DEFAULT_PHASE1_OPTIONS: Phase1Options = {
  maxAgeDays: 14,
  minIdleHours: 1,
}

export async function runPhase1(store: MemoryStore, opts: Phase1Options = DEFAULT_PHASE1_OPTIONS): Promise<void> {
  const eligible = selectEligibleSessions(store, opts)
  if (eligible.length === 0) return
  const claimed = store.claimStage1Jobs(eligible.map((s) => s.id), opts.excludeSession)
  if (claimed.length === 0) return

  await runPool(claimed, STAGE1_CONCURRENCY, async (sid) => {
    try {
      const transcript = buildTranscript(sid)
      if (!transcript.trim()) {
        store.markStage1Succeeded(sid, {
          session_id: sid,
          source_updated_at: Date.now(),
          raw_memory: "(empty session)",
          rollout_summary: "Empty or unreadable session.",
          rollout_slug: null,
          generated_at: Date.now(),
        })
        return
      }
      const result = await extractViaSubagent(sid, transcript)
      store.markStage1Succeeded(sid, {
        session_id: sid,
        source_updated_at: Date.now(),
        raw_memory: redact(result.raw_memory),
        rollout_summary: redact(result.rollout_summary),
        rollout_slug: result.rollout_slug,
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
    lines.push(`### ${role}\n${redact(text)}`)
  }
  return lines.join("\n\n").slice(0, 200_000)
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