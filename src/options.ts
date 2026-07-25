import type { CodexInteropOptions } from "./codex-interop.js"

/**
 * Effective plugin options + configuration diagnostics, owned by a leaf
 * module so both the plugin entry (writes) and the control tools (read for
 * memory_inspect) can reach them without an import cycle.
 *
 * Option names and defaults mirror codex's MemoriesToml/MemoriesConfig
 * (codex-rs/config/src/types.rs). Keep them 1:1 so the drift script and
 * manual syncing stay trivial; do not rename for taste. codex_interop is the
 * one opencode-specific addition (no codex equivalent).
 */
export interface PluginOptionsState {
  generate_memories: boolean
  use_memories: boolean
  dedicated_tools: boolean
  disable_on_external_context: boolean
  extract_model?: string
  consolidation_model?: string
  max_raw_memories_for_consolidation: number
  max_unused_days: number
  max_rollout_age_days: number
  max_rollouts_per_startup: number
  min_rollout_idle_hours: number
  codex_interop: CodexInteropOptions
}

export const pluginOptions: PluginOptionsState = {
  generate_memories: true,
  use_memories: true,
  dedicated_tools: true,
  disable_on_external_context: false,
  max_raw_memories_for_consolidation: 256,
  max_unused_days: 30,
  max_rollout_age_days: 10,
  max_rollouts_per_startup: 2,
  min_rollout_idle_hours: 6,
  codex_interop: { import: false, export: false },
}

/**
 * Config problems noticed while applying plugin options (unknown keys,
 * malformed values). The plugin never hard-fails on bad options — codex uses
 * deny_unknown_fields, a plugin can only degrade — and console output from a
 * plugin is effectively invisible in the TUI, so the warnings are kept here
 * and surfaced by the memory_inspect tool as the user-facing check.
 */
const configWarnings: string[] = []

export function recordConfigWarning(message: string): void {
  configWarnings.push(message)
  console.warn(`[opencode-codex-memory] ${message}`)
}

export function getConfigWarnings(): readonly string[] {
  return configWarnings
}

/** Test seam: options/warnings are module state, tests need a clean slate. */
export function resetConfigWarningsForTest(): void {
  configWarnings.length = 0
}
