export const REASONING_VARIANT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type ReasoningVariant = (typeof REASONING_VARIANT_LADDER)[number]

export function nearestReasoningVariant(preferred: string, available: Iterable<string>): string | undefined {
  const have = new Set(available)
  if (have.has(preferred)) return preferred
  const prefIdx = (REASONING_VARIANT_LADDER as readonly string[]).indexOf(preferred)
  if (prefIdx < 0) return undefined
  let best: string | undefined
  let bestDist = Infinity
  let bestIdx = -1
  for (let idx = 0; idx < REASONING_VARIANT_LADDER.length; idx++) {
    const name = REASONING_VARIANT_LADDER[idx]
    if (!have.has(name)) continue
    const dist = Math.abs(idx - prefIdx)
    if (dist < bestDist || (dist === bestDist && idx > bestIdx)) {
      best = name
      bestDist = dist
      bestIdx = idx
    }
  }
  return best
}

export function enabledVariantKeys(variants: unknown): string[] {
  if (!variants || typeof variants !== "object" || Array.isArray(variants)) return []
  const out: string[] = []
  for (const [name, value] of Object.entries(variants as Record<string, unknown>)) {
    if (value && typeof value === "object" && !Array.isArray(value) && (value as { disabled?: unknown }).disabled === true) {
      continue
    }
    out.push(name)
  }
  return out
}

export function catalogVariantKeys(data: unknown, providerID: string, modelID: string): string[] | undefined {
  if (!data || typeof data !== "object") return undefined
  const root = data as { all?: unknown; providers?: unknown }
  const all = Array.isArray(root.all) ? root.all : Array.isArray(root.providers) ? root.providers : undefined
  if (!all) return undefined
  const provider = all.find((item) => item && typeof item === "object" && (item as { id?: unknown }).id === providerID) as
    | { models?: Record<string, unknown> }
    | undefined
  if (!provider?.models || typeof provider.models !== "object") return undefined
  const model = provider.models[modelID]
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined
  if (!Object.prototype.hasOwnProperty.call(model, "variants")) return undefined
  return enabledVariantKeys((model as { variants?: unknown }).variants)
}
