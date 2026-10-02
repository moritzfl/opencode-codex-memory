import { setTimeout as sleep } from "node:timers/promises"
import { recordDiagnostic } from "../diagnostics.js"

type ModelRef = { providerID: string; id: string }

// Startup provider registrations can lag service health. Bound the wait rather
// than silently changing models or indefinitely hiding a configuration error.
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000] as const

/** Only retry host selection failures: these occur before any inference. */
export function isModelSelectionUnavailable(error: unknown, model?: ModelRef): boolean {
  const message = model
    ? `Model unavailable: ${model.providerID}/${model.id}`
    : "No model specified and no supported model is available"
  const seen = new Set<unknown>()
  for (let current = error as any; current && !seen.has(current); current = current.cause ?? current.error) {
    seen.add(current)
    const tag = current._tag ?? current.name
    if (["InvalidRequestError", "Generate.ModelSelectionError"].includes(tag) && current.message === message) return true
  }
  return false
}

export async function retryModelSelection<T>(
  request: () => Promise<T>,
  model?: ModelRef,
  signal?: AbortSignal,
  delays: readonly number[] = RETRY_DELAYS_MS,
): Promise<T> {
  const label = model ? `${model.providerID}/${model.id}` : "host default model"
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try {
      const result = await request()
      if (attempt > 0) recordDiagnostic("info", "model-readiness", `${label} available after ${attempt} startup retry(s)`)
      return result
    } catch (error) {
      if (signal?.aborted || !isModelSelectionUnavailable(error, model)) throw error
      const delay = delays[attempt]
      if (delay === undefined) {
        recordDiagnostic("error", "model-readiness", `${label} still unavailable after ${attempt} startup retry(s)`)
        throw error
      }
      if (attempt === 0) recordDiagnostic("warn", "model-readiness", `${label} not registered yet; waiting for model startup`)
      await sleep(delay, undefined, signal ? { signal } : undefined)
    }
  }
}
